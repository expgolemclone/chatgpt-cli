import { constants, lstatSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import type { Locator } from 'playwright';
import { AccessBlockedError, emailPattern } from './browser/account.ts';
import { launchProfile } from './browser/edge.ts';
import { isProfileRunning } from './browser/processes.ts';
import { assertIdentity, listProfiles, resolveProfiles, type Profile } from './browser/profiles.ts';
import { ProfileNotReadyError, runChat } from './chat.ts';
import { readLedger } from './usage/ledger.ts';

type Selection = { profile: string } | { root: string; ledger: string };
class ImageError extends Error {}

function selectProfile(selection: Selection): Profile {
  if ('profile' in selection) return resolveProfiles([selection.profile])[0]!;
  const plus = new Set(readLedger(resolve(selection.ledger)).rows.filter(row => row.kind === 'email' && row.state === 'plus')
    .map(row => row.value.toLowerCase()));
  const matches = listProfiles(selection.root).filter(profile => plus.has(profile.name.toLowerCase()));
  if (matches.length !== 1) throw new ImageError(`Found ${matches.length} matching Plus profiles; specify one --profile instead of --ledger.`);
  return matches[0]!;
}

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

async function downloadImage(turn: Locator, output: string): Promise<void> {
  const gallery = turn.getByTestId('generated-image-gallery');
  const preview = gallery.getByTestId('generated-image-preview').locator('img');
  if (await gallery.count() !== 1 || await preview.count() !== 1) throw new ImageError('The reply does not contain exactly one generated image.');
  const timeout = 15_000;
  await preview.hover({ timeout });
  const name = /^(?:(?:download|save)(?: (?:this )?image)?|(?:画像を)?(?:ダウンロード|保存)(?:する)?)$/i;
  const control = turn.getByRole('button', { name }).or(turn.getByRole('link', { name }));
  const [download] = await Promise.all([turn.page().waitForEvent('download', { timeout }), control.click({ timeout })]);
  const timer = setTimeout(() => { void download.cancel().catch(() => {}); }, 120_000);
  try {
    const source = await download.path(); // Only the user-facing download, never a thumbnail or private URL.
    if (!source) throw new ImageError('Image download failed.');
    await savePng(source, output);
  } finally { clearTimeout(timer); }
}

export async function generateImage(selection: Selection, promptFile: string, destination: string): Promise<string> {
  let state = 'Not sent';
  let hint = 'Check that --prompt-file is a readable, nonempty UTF-8 file.';
  try {
    const brief = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolve(promptFile))).trim();
    if (!brief || brief.includes('\0')) throw new ImageError(hint);
    hint = 'Choose a new writable .png path for --output.';
    const output = resolve(destination);
    if (extname(output).toLowerCase() !== '.png' || lstatSync(output, { throwIfNoEntry: false })) throw new ImageError(hint);
    await mkdir(dirname(output), { recursive: true });
    await access(dirname(output), constants.W_OK);
    hint = 'Check the dedicated profile selection or the private ledger; use image --help.';
    const profile = selectProfile(selection);
    assertIdentity(profile);
    if (!lstatSync(join(profile.path, 'Local State'), { throwIfNoEntry: false })?.isFile()) {
      throw new ImageError('Select an existing dedicated Edge user-data directory where you already signed in.');
    }
    if (isProfileRunning(profile)) throw new ImageError('Close the selected dedicated Edge profile before running image.');
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
          save: turn => downloadImage(turn, output),
        }, { onEvent: event => {
          if (event === 'sending') { state = 'Submission unconfirmed'; hint = 'No confirmed acknowledgement.'; }
          if (event === 'sent') { state = 'Sent'; hint = 'Could not save the generated PNG; check the download and output path.'; }
          if (event === 'completed') { state = 'PNG saved'; hint = 'Check the saved file and close the dedicated profile.'; }
        } });
      } finally { await edge.close(); }
    } finally { await rm(artifacts, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    return output;
  } catch (error) {
    // Do not print browser call logs, ledger rows, signed URLs or prompt contents.
    const reason = error instanceof AccessBlockedError ? 'Access is restricted; check ChatGPT manually.'
      : error instanceof ImageError || error instanceof ProfileNotReadyError ? error.message : hint;
    throw new Error(`${state}: ${reason}${state === 'Sent' || state === 'Submission unconfirmed' ? ' Check chat history before retrying.' : ''}`, { cause: error });
  }
}
