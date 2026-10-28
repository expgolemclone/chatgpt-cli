import { createHash } from 'node:crypto';
import { lstatSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import lockfile from 'proper-lockfile';
import { emailPattern } from '../browser/account.ts';
import { inspectProfile, type Inspection } from '../browser/inspect.ts';
import { assertProfileDirectory, listProfiles, readProfileId, resolveProfiles, type Profile } from '../browser/profiles.ts';
import { readLedger, writeLedger } from './ledger.ts';

export interface SyncSelection { root?: string; profile?: string }
export interface SyncResult extends Inspection { profile: Profile; updated: boolean; renamed: boolean }

export async function syncUsage(selection: SyncSelection, ledgerPath: string,
  inspect: (profile: Profile) => Promise<Inspection> = inspectProfile): Promise<SyncResult[]> {
  if ((selection.root === undefined) === (selection.profile === undefined)) {
    throw new Error('sync requires --profile-root or exactly one --profile.');
  }
  const target = resolveProfiles([selection.root ?? selection.profile!])[0]!;
  const root = selection.root === undefined ? dirname(target.path) : target.path;
  assertProfileDirectory(root, true);
  const ledgerFile = resolve(ledgerPath);
  const difference = relative(root.toLowerCase(), ledgerFile.toLowerCase());
  if (difference === '' || (difference !== '..' && !difference.startsWith('..' + sep) && !isAbsolute(difference))) {
    throw new Error('The ledger must be outside the browser profile collection.');
  }
  readLedger(ledgerFile);
  const releases: (() => Promise<void>)[] = [];
  try {
    for (const path of [root, ledgerFile].sort()) {
      const key = createHash('sha256').update(path.toLowerCase()).digest('hex');
      releases.push(await lockfile.lock(path, {
        lockfilePath: join('C:/dev/tmp', 'chatgpt-sync-' + key + '.lock'),
        stale: 120_000, update: 10_000, retries: 0,
      }));
    }
    const ledger = readLedger(ledgerFile);
    const profiles = selection.root === undefined ? resolveProfiles([target.path]) : listProfiles(root);
    const results: SyncResult[] = [];
    let finished: number | undefined;
    for (const profile of profiles) {
      assertProfileDirectory(profile.path, true);
      if (profile.id === undefined || readProfileId(profile.path) !== profile.id) {
        throw new Error('sync requires an unchanged, marked profile identity.');
      }
      if (finished !== undefined) await setTimeout(Math.max(0, 30_000 - (Date.now() - finished)));
      const inspection = await inspect(profile);
      finished = Date.now();
      if (!['logged_in', 'logged_out', 'unknown'].includes(inspection.status) ||
          !['無料', 'plus', '不明'].includes(inspection.state)) throw new Error('Invalid profile inspection.');
      if (/http_(403|429)|access_cooldown|access_blocked/.test(inspection.reason)) {
        throw new Error('Access rejected or cooling down. Sync stopped; remaining profiles were not contacted. ' + inspection.reason);
      }
      const result: SyncResult = { ...inspection, profile, updated: false, renamed: false };
      if (inspection.status === 'logged_in') {
        const email = inspection.email_address;
        if (!email || !emailPattern.test(email) || /[<>:"/\\|?*\x00-\x1f]/.test(email) || /[. ]$/.test(email)) {
          throw new Error('Inspection returned an invalid email directory name.');
        }
        assertProfileDirectory(profile.path, true);
        if (readProfileId(profile.path) !== profile.id) throw new Error('Profile identity changed during inspection.');
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
