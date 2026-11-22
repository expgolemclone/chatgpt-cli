import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { createProfile, type Profile } from '../../src/browser/profiles.ts';

export function createNamedProfile(root: string, name: string): Profile {
  const profile = createProfile(root);
  const path = join(root, name);
  renameSync(profile.path, path);
  return { ...profile, name, path };
}
