import { randomUUID } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { AccessBlockedError, NonFreeAccountError, runChat } from './chat.js';
import { generatePrompts } from './prompts/generate.js';

interface Profile { id: string; name: string; path: string }
interface Manifest { schemaVersion: 1; edgePath: string; edgeArguments: string[]; profileRoot: string; profiles: Profile[] }
const samePath = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();

export function readManifest(file: string): Manifest {
  const data = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  if (data?.schemaVersion !== 1 || typeof data.edgePath !== 'string' ||
      !Array.isArray(data.edgeArguments) || data.edgeArguments.some(argument => typeof argument !== 'string') ||
      typeof data.profileRoot !== 'string' || !Array.isArray(data.profiles) || data.profiles.length === 0 ||
      !isAbsolute(data.edgePath) || !isAbsolute(data.profileRoot)) {
    throw new Error('Invalid profile manifest. Use send-messages.ps1.');
  }
  if (!lstatSync(data.edgePath).isFile()) throw new Error('Edge executable is missing.');
  const root = lstatSync(data.profileRoot);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe profile root.');
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const profile of data.profiles) {
    if (!profile || typeof profile.id !== 'string' || !/^[a-f0-9]{32}$/.test(profile.id) ||
        typeof profile.name !== 'string' || typeof profile.path !== 'string' ||
        profile.name.toLowerCase() === 'archive' || basename(profile.path) !== profile.name ||
        !isAbsolute(profile.path) || !samePath(dirname(profile.path), data.profileRoot) ||
        ids.has(profile.id) || paths.has(profile.path.toLowerCase())) {
      throw new Error('Invalid or duplicate dedicated profile.');
    }
    const entry = lstatSync(profile.path); // Never let Playwright create a missing profile.
    if (!entry.isDirectory() || entry.isSymbolicLink() ||
        !samePath(dirname(realpathSync(profile.path)), realpathSync(data.profileRoot))) {
      throw new Error('Unsafe or missing dedicated profile directory.');
    }
    ids.add(profile.id);
    paths.add(profile.path.toLowerCase());
  }
  return data;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    manifest: { type: 'string' }, questions: { type: 'string' },
    seed: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  } });
  if (!values.manifest) throw new Error('Use send-messages.ps1 to resolve local profiles.');
  const count = values.questions === undefined ? undefined : Number(values.questions);
  const manifest = readManifest(values.manifest);
  const seed = values.seed ?? randomUUID();
  const batches = manifest.profiles.map(profile => ({
    profile, prompts: generatePrompts(profile.id, seed, count),
  }));
  if (values['dry-run']) {
    console.log(JSON.stringify({ seed, profiles: batches.map(({ profile, prompts }) => ({
      name: profile.name, prompts,
    })) }, null, 2));
    return;
  }
  if (!process.env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is required.');
  const logs = join(process.env.LOCALAPPDATA, 'gpt-send-messages', 'logs');
  mkdirSync(logs, { recursive: true });
  const logFile = join(logs, `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.jsonl`);
  const log = (event: string, details: Record<string, unknown> = {}) => {
    const record = { time: new Date().toISOString(), event, ...details };
    appendFileSync(logFile, JSON.stringify(record) + '\n', 'utf8');
    console.log(JSON.stringify(record));
  };
  log('started', { seed, profiles: batches.length, logFile });
  let lastSend = 0;
  let failed = false;
  for (const { profile, prompts } of batches) {
    let context: BrowserContext | undefined;
    let lastPage: Page | undefined;
    try {
      // A pre-opened profile will fail its own Chromium lock. Never terminate it or delete locks.
      context = await chromium.launchPersistentContext(profile.path, {
        executablePath: manifest.edgePath, headless: false, viewport: null,
        args: manifest.edgeArguments,
      });
      const page = await context.newPage();
      lastPage = page;
      await runChat(page, prompts, {
        beforeSend: async () => {
          const delay = Math.max(0, lastSend + 30_000 - Date.now());
          if (delay) await new Promise(resolve => setTimeout(resolve, delay));
          lastSend = Date.now();
        },
        onEvent: (event, prompt) => log(event, { profile: profile.name, promptId: prompt.id, url: page.url() }),
      });
    } catch (error) {
      if (error instanceof NonFreeAccountError) {
        log('profile-skipped', { profile: profile.name, reason: 'non-free-account' });
      } else {
        failed = true;
        log('profile-failed', { profile: profile.name, url: lastPage?.url(), error: String(error) });
        if (error instanceof AccessBlockedError) {
          log('batch-stopped', { reason: 'Access blocked; no other profiles will be contacted.' });
          break;
        }
      }
    } finally {
      // Only close a context successfully created by THIS run, never an existing user browser.
      await context?.close();
    }
  }
  log('finished', { success: !failed });
  if (failed) process.exitCode = 1;
}

// Importable by offline manifest tests without executing the CLI.
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
