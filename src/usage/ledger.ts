import { dirname } from 'node:path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import { emailPattern } from '../browser/account.ts';
import { assertProfileDirectory } from '../browser/profiles.ts';
import { readRegularFile, replaceRegularFile } from '../storage/files.ts';

export interface LedgerRow { kind: string; value: string; state: string }
export interface Ledger { contents: string; rows: LedgerRow[] }
const columns = ['kind', 'value', 'state'];

export function readLedger(path: string): Ledger {
  assertProfileDirectory(dirname(path), true);
  const contents = readRegularFile(path);
  if (contents === undefined) throw new Error('An existing ledger CSV is required.');
  const [header, ...records] = parse(contents, { bom: true }) as string[][];
  if (JSON.stringify(header) !== JSON.stringify(columns)) throw new Error('Ledger header must be kind,value,state.');
  const emails = new Set<string>();
  const rows = records.map(record => {
    if (record.length !== 3 || record.some(value => !value.trim())) throw new Error('Ledger fields must not be empty.');
    const [kind, value, state] = record as [string, string, string];
    if (kind === 'email') {
      if (!emailPattern.test(value) || !['なし', '無料', 'plus', '不明'].includes(state)) {
        throw new Error('Invalid email ledger row.');
      }
      if (emails.has(value.toLowerCase())) throw new Error('Duplicate email in ledger.');
      emails.add(value.toLowerCase());
    }
    return { kind, value, state };
  });
  return { contents, rows };
}

export function writeLedger(path: string, ledger: Ledger): void {
  assertProfileDirectory(dirname(path), true);
  const contents = stringify([columns, ...ledger.rows.map(row => [row.kind, row.value, row.state])]);
  replaceRegularFile(path, contents, ledger.contents);
  ledger.contents = contents;
}
