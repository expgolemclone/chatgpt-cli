import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readRegularFile } from '../storage/files.ts';

export const failureCooldownMs = 30 * 60_000;

/** A sending event is recorded immediately before a possibly uncertain submission. */
export function readPromptHistory(directory: string, cooldownMs = 0, now = Date.now()): Map<string, number> {
  const history = new Map<string, number>();
  let latestRun = -Infinity;
  let latestCompleted = true;
  const entry = lstatSync(directory, { throwIfNoEntry: false });
  if (!entry) return history;
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Prompt logs must be a regular directory.');
  for (const name of readdirSync(directory).filter(name => name.endsWith('.jsonl'))) {
    const contents = readRegularFile(join(directory, name));
    if (contents === undefined) throw new Error(`Prompt log disappeared: ${name}`);
    let isSendRun = false;
    let lastTime = -Infinity;
    let completed = false;
    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { throw new Error(`Invalid prompt log: ${name}`); }
      if (!record || typeof record !== 'object' || !('event' in record)) continue;
      const parsedTime = 'time' in record && typeof record.time === 'string' ? Date.parse(record.time) : Number.NaN;
      if (Number.isFinite(parsedTime)) lastTime = Math.max(lastTime, parsedTime);
      if (record.event === 'started' && 'command' in record && record.command === 'send') isSendRun = true;
      if (['session-started', 'challenge', 'profile-failed', 'batch-stopped'].includes(String(record.event))) {
        isSendRun = true;
      }
      if (record.event === 'finished') completed = 'success' in record && record.success === true;
      if (record.event !== 'sending') continue;
      if (!('promptId' in record) || typeof record.promptId !== 'string' || !record.promptId ||
          !Number.isFinite(parsedTime)) {
        throw new Error(`Invalid sending event in prompt log: ${name}`);
      }
      isSendRun = true;
      completed = false;
      history.set(record.promptId, Math.max(history.get(record.promptId) ?? -Infinity, parsedTime));
    }
    // Runs without send activity (including login/open) cannot clear an incomplete send cooldown.
    if (!isSendRun || lastTime === -Infinity || lastTime < latestRun) continue;
    latestCompleted = lastTime === latestRun ? latestCompleted && completed : completed;
    latestRun = lastTime;
  }
  if (cooldownMs > 0 && !latestCompleted && latestRun !== -Infinity && now < latestRun + cooldownMs) {
    throw new Error(`Previous send did not complete; cooling down until ${new Date(latestRun + cooldownMs).toISOString()}. Review the previous run before retrying.`);
  }
  return history;
}
