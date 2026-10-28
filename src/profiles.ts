import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

export interface Profile { name: string; path: string }

const samePath = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
const contains = (parent: string, child: string) => {
  const difference = relative(parent.toLowerCase(), child.toLowerCase());
  return difference === '' || (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference));
};

/** Resolve explicit dedicated directories; never discover another application's profiles. */
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
    profiles.push({ name: basename(path), path });
  }
  return profiles;
}

/** Also reject linked ancestors before login can create a new directory through them. */
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
