import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFile } from '../storage/files.ts';

/** A sending event is recorded immediately before a possibly uncertain submission. */
export function readPromptHistory(directory: string): Map<string, number> {
  const history = new Map<string, number>();
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (!entry) return history;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Prompt logs must be a regular directory.');
  for (const name of readdirSync(directory).filter(name => name.endsWith('.jsonl'))) {
    const contents = readRegularFile(join(directory, name));
    if (contents === undefined) throw new Error(`Prompt log disappeared: ${name}`);
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw new Error(`Invalid prompt log: ${name}`); }
      if (!record || typeof record !== 'object' || !('event' in record) || record.event !== 'sending') continue;
      if (!('promptId' in record) || typeof record.promptId !== 'string' || !record.promptId ||
          !('time' in record) || typeof record.time !== 'string' || !Number.isFinite(Date.parse(record.time))) {
        throw new Error(`Invalid sending event in prompt log: ${name}`);
      }
      const time = Date.parse(record.time);
      history.set(record.promptId, Math.max(history.get(record.promptId) ?? -Infinity, time));
    }
  }
  return history;
}
