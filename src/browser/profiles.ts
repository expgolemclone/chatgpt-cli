import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export interface Profile { name: string; path: string; id?: string }
const identityFile = '.gpt-usage-id';
const samePath = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
const contains = (parent: string, child: string) => {
  const difference = relative(parent.toLowerCase(), child.toLowerCase());
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
};

/** Explicit paths have no inventory requirement. Collection roots discover only marked direct children. */
export function resolveProfiles(paths: string[], localAppData = process.env.LOCALAPPDATA): Profile[] {
  if (!localAppData || !isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be an absolute directory.');
  const directories = paths.length ? paths : [join(localAppData, 'gpt-send-messages', 'profile')];
  const profiles: Profile[] = [];
  const normalEdge = join(localAppData, 'Microsoft', 'Edge', 'User Data');
  for (const value of directories) {
    if (!value || !isAbsolute(value)) throw new Error('--profile must be an absolute dedicated directory.');
    const path = resolve(value);
    if (contains(normalEdge, path) || contains(path, normalEdge)) {
      throw new Error('Normal Edge user data and its parent directories cannot be used for automation.');
    }
    if (profiles.some(profile => contains(profile.path, path) || contains(path, profile.path))) {
      throw new Error('Profile directories must not duplicate or overlap.');
    }
    assertProfileDirectory(path, false);
    const id = readProfileId(path);
    profiles.push({ name: basename(path), path, ...(id === undefined ? {} : { id }) });
  }
  return profiles;
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
    throw new Error('Dedicated profile is missing. Run npm run login first, then sign in and close its Edge window.');
  }
}

export function readRegularFile(path: string): string | undefined {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Profile metadata must be a regular file.');
  return readFileSync(path, 'utf8');
}

export function readProfileId(path: string): string | undefined {
  const value = readRegularFile(join(path, identityFile))?.trim();
  if (value !== undefined && !/^[0-9a-f]{32}$/.test(value)) throw new Error('Invalid profile identity.');
  return value;
}

export function listProfiles(root: string): Profile[] {
  resolveProfiles([root]);
  if (!lstatSync(root, { throwIfNoEntry: false })) return [];
  const profiles: Profile[] = [];
  const ids = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.toLowerCase() === 'archive' || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const path = join(root, entry.name);
    assertProfileDirectory(path, true);
    const id = readProfileId(path);
    if (id === undefined) continue;
    if (ids.has(id)) throw new Error('Duplicate local profile identity.');
    ids.add(id);
    profiles.push({ name: entry.name, path, id });
  }
  return profiles;
}

export function createProfile(root: string): Profile {
  resolveProfiles([root]);
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
