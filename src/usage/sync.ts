import { lstatSync, renameSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { emailPattern } from '../browser/account.ts';
import { inspectProfile, inspectProfiles, type Inspection } from '../browser/inspect.ts';
import { assertDedicatedDirectory, assertIdentity, listProfiles, type Profile } from '../browser/profiles.ts';
import { acquirePathLock } from '../storage/lock.ts';
import { readLedger, writeLedger } from './ledger.ts';

export interface SyncResult extends Inspection { profile: Profile; updated: boolean; renamed: boolean }

export async function syncUsage(root: string, ledgerPath: string, profileName?: string,
  inspect: (profile: Profile) => Promise<Inspection> = inspectProfile): Promise<SyncResult[]> {
  assertDedicatedDirectory(root, true);
  const ledgerFile = resolve(ledgerPath);
  const difference = relative(root.toLowerCase(), ledgerFile.toLowerCase());
  if (difference === '' || (difference !== '..' && !difference.startsWith('..' + sep) && !isAbsolute(difference))) {
    throw new Error('The ledger must be outside the browser profile collection.');
  }
  readLedger(ledgerFile);
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const path of [root, ledgerFile].sort()) releases.push(await acquirePathLock(path));
    const ledger = readLedger(ledgerFile);
    const profiles = listProfiles(root, profileName);
    const results: SyncResult[] = [];
    for await (const { profile, inspection } of inspectProfiles(profiles, inspect)) {
      const result: SyncResult = { ...inspection, profile, updated: false, renamed: false };
      if (inspection.status === 'logged_in') {
        const email = inspection.email_address;
        if (!email || !emailPattern.test(email) || /[<>:"/\\|?*\x00-\x1f]/.test(email) || /[. ]$/.test(email)) {
          throw new Error('Inspection returned an invalid email directory name.');
        }
        assertIdentity(profile);
        const destination = join(root, email);
        result.renamed = profile.name !== email;
        if (result.renamed && lstatSync(destination, { throwIfNoEntry: false })) {
          throw new Error('Profile directory already exists; stop for confirmation.');
        }
        const row = ledger.rows.find(row => row.kind === 'email' && row.value.toLowerCase() === email.toLowerCase());
        result.updated = !row || row.value !== email || row.state !== inspection.state;
        if (!row) ledger.rows.push({ kind: 'email', value: email, state: inspection.state });
        else { row.value = email; row.state = inspection.state; }
        if (result.updated) writeLedger(ledgerFile, ledger);
        if (result.renamed) {
          renameSync(profile.path, destination);
          result.profile = { ...profile, name: email, path: destination };
        }
      }
      results.push(result);
    }
    return results;
  } finally {
    await Promise.all(releases.map(release => release()));
  }
}
