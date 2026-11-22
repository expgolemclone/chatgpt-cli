import { constants, lstatSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import type { Locator } from 'playwright';
import { AccessBlockedError, CloudflareChallengeError, emailPattern } from './browser/account.ts';
import { launchProfile } from './browser/edge.ts';
import { isProfileRunning } from './browser/processes.ts';
import { assertIdentity, type Profile } from './browser/profiles.ts';
import { ProfileNotReadyError, runChat } from './chat.ts';

class ImageError extends Error {}

const pngHeader = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'); // signature and IHDR
const pngEnd = Buffer.from('0000000049454e44ae426082', 'hex'); // complete IEND
async function savePng(source: string, output: string): Promise<void> {
  const bytes = await readFile(source);
  const invalid = new ImageError('Download is not an intact PNG; no output was written.');
  if (bytes.length < 57 || !bytes.subarray(0, pngHeader.length).equals(pngHeader) ||
      !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || !bytes.subarray(-pngEnd.length).equals(pngEnd)) throw invalid;
  let hasPixels = false;
  for (let p = 8; p < bytes.length;) {
    if (p + 12 > bytes.length) throw invalid;
    const length = bytes.readUInt32BE(p), end = p + 8 + length;
    if (end + 4 > bytes.length || crc32(bytes.subarray(p + 4, end)) !== bytes.readUInt32BE(end)) throw invalid;
    const type = bytes.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT' && length) hasPixels = true;
    if (type === 'IEND' && end + 4 !== bytes.length) throw invalid;
    p = end + 4;
  }
  if (!hasPixels) throw invalid;
  await copyFile(source, output, constants.COPYFILE_EXCL);
}

async function downloadImage(turn: Locator, output: string, artifacts: string): Promise<void> {
  const gallery = turn.getByTestId('generated-image-gallery');
  const preview = gallery.getByTestId('generated-image-preview');
  const timeout = 15_000;
  // The turn state may settle just before the gallery is mounted.
  await preview.first().locator('img').waitFor({ timeout }).catch(() => {});
  if (await gallery.count() !== 1 || await preview.count() !== 1 || await preview.locator('img').count() !== 1) {
    throw new ImageError('The reply does not contain exactly one generated image.');
  }
  const page = turn.page();
  const viewer = page.getByRole('dialog');
  const name = /^(?:(?:download|save)(?: (?:this )?image)?|(?:画像を)?(?:ダウンロード|保存)(?:する)?)$/i;
  const control = viewer.getByRole('button', { name }).or(viewer.getByRole('link', { name }));
  try {
    await preview.click({ timeout });
    await control.waitFor({ state: 'visible', timeout });
  } catch (cause) { throw new ImageError('The generated image viewer did not offer a unique download control.', { cause }); }
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60_000 }), control.click({ timeout })])
    .catch(cause => { throw new ImageError('The viewer did not start a browser download.', { cause }); });
  const timer = setTimeout(() => { void download.cancel().catch(() => {}); }, 120_000);
  try {
    // A browser download is not necessarily a file on the CLI's filesystem.
    const source = join(artifacts, 'reply.png');
    try { await download.saveAs(source); }
    catch (cause) { throw new ImageError('The browser could not transfer the downloaded image.', { cause }); }
    try { await savePng(source, output); }
    catch (cause) {
      if (cause instanceof ImageError) throw cause;
      throw new ImageError('Could not publish the PNG to a new writable output file.', { cause });
    }
  } finally { clearTimeout(timer); }
}

export async function generateImage(profile: Profile, promptFile: string, destination: string, referenceFiles: string[] = []): Promise<string> {
  let state = 'Not sent';
  let hint = 'Choose a readable, nonempty UTF-8 brief file.';
  try {
    const brief = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolve(promptFile))).trim();
    if (!brief || brief.includes('\0')) throw new ImageError(hint);
    hint = 'Use distinct readable PNG, JPEG, or WebP files for --reference.';
    const references = referenceFiles.map(file => resolve(file));
    if (new Set(references.map(file => basename(file).toLowerCase())).size !== references.length) throw new ImageError(hint);
    for (const file of references) {
      if (!/\.(png|jpe?g|webp)$/i.test(file) || !lstatSync(file, { throwIfNoEntry: false })?.isFile()) throw new ImageError(hint);
      await access(file, constants.R_OK);
    }
    hint = 'Choose a new writable .png output path.';
    const output = resolve(destination);
    if (extname(output).toLowerCase() !== '.png' || lstatSync(output, { throwIfNoEntry: false })) throw new ImageError(hint);
    hint = 'Check the selected profile with chatgpt-cli profiles.';
    assertIdentity(profile);
    if (!lstatSync(join(profile.path, 'Local State'), { throwIfNoEntry: false })?.isFile()) {
      throw new ImageError('Sign in first with chatgpt-cli login --profile NAME, then close Edge.');
    }
    if (isProfileRunning(profile)) throw new ImageError('Close the selected dedicated Edge profile before running image.');
    hint = 'Choose a new writable .png output path.';
    await mkdir(dirname(output), { recursive: true });
    await access(dirname(output), constants.W_OK);
    hint = 'Check that the dedicated Edge profile is closed and available to the current user.';
    const artifacts = await mkdtemp(resolve('C:/dev/tmp/chatgpt-image-'));
    try {
      const edge = await launchProfile(profile, artifacts);
      try {
        const page = await edge.context.newPage();
        hint = 'Check the signed-in Plus account and the new chat.';
        await runChat(page, {
          prompt: { id: 'image', text: `Generate exactly one image from this brief:\n\n${brief}` },
          ...(emailPattern.test(profile.name) && { expectedEmail: profile.name }),
          references,
          save: turn => downloadImage(turn, output, artifacts),
        }, { onEvent: event => {
          if (event === 'sending') { state = 'Submission unconfirmed'; hint = 'No confirmed acknowledgement.'; }
          if (event === 'sent') { state = 'Sent'; hint = 'Could not confirm the completed image reply.'; }
          if (event === 'completed') { state = 'PNG saved'; hint = 'Check the saved file and close the dedicated profile.'; }
        } });
      } finally { await edge.close(); }
    } finally { await rm(artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    return output;
  } catch (error) {
    // Do not print browser call logs, ledger rows, signed URLs or prompt contents.
    const reason = state === 'Not sent' && error instanceof CloudflareChallengeError
      ? 'Cloudflare verification did not clear. Check ChatGPT in Edge, or use --profile NAME for another signed-in Plus profile that already has normal access.'
      : error instanceof AccessBlockedError ? 'Access is restricted; check ChatGPT manually.'
      : error instanceof ImageError || error instanceof ProfileNotReadyError ? error.message : hint;
    throw new Error(`${state}: ${reason}${state === 'Sent' || state === 'Submission unconfirmed' ? ' Check chat history before retrying.' : ''}`, { cause: error });
  }
}
