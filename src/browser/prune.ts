import { lstatSync, rmSync } from 'node:fs';
import { sep } from 'node:path';
import { acquirePathLock } from '../storage/lock.ts';
import { inspectProfile, inspectProfiles, type Inspection } from './inspect.ts';
import { isProfileRunning } from './processes.ts';
import { assertDedicatedDirectory, assertIdentity, listProfiles } from './profiles.ts';

const inUse: Inspection = { status: 'unknown', email_address: null, state: '不明', reason: 'profile_in_use' };

export async function* pruneProfiles(root: string, apply = false, inspect = inspectProfile) {
  assertDedicatedDirectory(root, false);
  if (root.toLowerCase().split(sep).includes('archive')) throw new Error('Archived profiles cannot be pruned.');
  if (!lstatSync(root, { throwIfNoEntry: false })) return;
  const release = await acquirePathLock(root);
  try {
    const profiles = listProfiles(root);
    for await (const { profile, inspection } of inspectProfiles(profiles,
      async profile => isProfileRunning(profile) ? inUse : inspect(profile))) {
      let { status, reason } = inspection;
      let action: 'keep' | 'would-delete' | 'deleted' = 'keep';
      if (status === 'logged_out') {
        if (!apply) {
          action = 'would-delete';
        } else if (isProfileRunning(profile)) {
          ({ status, reason } = inUse);
        } else {
          assertIdentity(profile);
          rmSync(profile.path, { recursive: true, maxRetries: 10, retryDelay: 200 });
          action = 'deleted';
        }
      }
      yield { profile, status, reason, action };
    }
  } finally {
    await release();
  }
}
