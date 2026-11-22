import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { readRegularFile } from '../storage/files.ts';

export interface Profile { name: string; path: string; id: string }
const identityFile = '.gpt-usage-id';
const samePath = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
const contains = (parent: string, child: string) => {
  const difference = relative(parent.toLowerCase(), child.toLowerCase());
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
};

const absolute = (path: string) => isAbsolute(path) && parse(path).root.length > 1;

function localAppData(): string {
  const path = process.env.LOCALAPPDATA;
  if (!path || !absolute(path)) throw new Error('LOCALAPPDATA must be an absolute directory.');
  return resolve(path);
}

export function profileRoot(): string {
  return join(localAppData(), 'chatgpt-cli', 'profiles');
}

export function assertDedicatedDirectory(path: string, required: boolean): void {
  if (!absolute(path)) throw new Error('Dedicated profile directories must be absolute.');
  const normalEdge = join(localAppData(), 'Microsoft', 'Edge', 'User Data');
  if (contains(normalEdge, path) || contains(path, normalEdge)) {
    throw new Error('Normal Edge user data and its parent directories cannot be used for automation.');
  }
  assertProfileDirectory(path, required);
}

/** Reject links in every existing ancestor, including before creating a new directory. */
export function assertProfileDirectory(path: string, required: boolean): void {
  let existing = path;
  let entry = lstatSync(existing, { throwIfNoEntry: false });
  while (!entry) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('Profile directory has no accessible parent.');
    existing = parent;
    entry = lstatSync(existing, { throwIfNoEntry: false });
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || !samePath(realpathSync(existing), existing)) {
    throw new Error('Profile directory and its ancestors must be regular, unlinked directories.');
  }
  if (required && !samePath(existing, path)) {
    throw new Error('Dedicated profile directory is missing. Run chatgpt-cli login to create a profile.');
  }
}

function readProfileId(path: string): string | undefined {
  const value = readRegularFile(join(path, identityFile))?.trim();
  if (value !== undefined && !/^[0-9a-f]{32}$/.test(value)) throw new Error('Invalid profile identity.');
  return value;
}

export function assertIdentity(profile: Profile): void {
  assertDedicatedDirectory(profile.path, true);
  if (!profile.id || readProfileId(profile.path) !== profile.id) {
    throw new Error(`Profile identity changed: ${profile.path}`);
  }
}

/** Only marked direct children are selectable, never arbitrary paths. */
export function listProfiles(root: string, name?: string): Profile[] {
  assertDedicatedDirectory(root, false);
  const profiles: Profile[] = [];
  const ids = new Set<string>();
  const entries = lstatSync(root, { throwIfNoEntry: false }) ? readdirSync(root, { withFileTypes: true }) : [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.toLowerCase() === 'archive' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const path = join(root, entry.name);
    assertProfileDirectory(path, true);
    const id = readProfileId(path);
    if (id === undefined) continue;
    if (ids.has(id)) throw new Error('Duplicate local profile identity.');
    ids.add(id);
    profiles.push({ name: entry.name, path, id });
  }
  if (name === undefined) return profiles;
  const matches = profiles.filter(profile => profile.name.toLowerCase() === name.toLowerCase());
  if (!matches.length) throw new Error(`No profile named "${name}". Run chatgpt-cli profiles to see available names.`);
  if (matches.length > 1) throw new Error(`Profile name "${name}" is ambiguous.`);
  return matches;
}

export function createProfile(root: string): Profile {
  assertDedicatedDirectory(root, false);
  const occupied = new Set(lstatSync(root, { throwIfNoEntry: false }) ? readdirSync(root).map(name => name.toLowerCase()) : []);
  let number = 1;
  while (occupied.has(`未ログイン-${String(number).padStart(3, '0')}`)) number++;
  const name = `未ログイン-${String(number).padStart(3, '0')}`;
  const profile = { name, path: join(root, name), id: randomUUID().replaceAll('-', '') };
  const temporary = mkdtempSync('C:/dev/tmp/gpt-profile-');
  try {
    writeFileSync(join(temporary, identityFile), profile.id, { flag: 'wx' });
    mkdirSync(root, { recursive: true });
    assertProfileDirectory(root, true);
    // Atomic installation; a collision fails without overwriting or merging browser data.
    if (lstatSync(profile.path, { throwIfNoEntry: false })) throw new Error('Profile directory already exists.');
    renameSync(temporary, profile.path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return profile;
}
