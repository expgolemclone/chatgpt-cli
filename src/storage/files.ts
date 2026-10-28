import { lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function readRegularFile(path: string): string | undefined {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Metadata must be a regular file.');
  return readFileSync(path, 'utf8');
}

export function replaceRegularFile(path: string, contents: string, expected = readRegularFile(path)): void {
  const temporary = mkdtempSync('C:/dev/tmp/chatgpt-file-');
  try {
    const staged = join(temporary, 'contents');
    writeFileSync(staged, contents, { flag: 'wx' });
    if (readRegularFile(path) !== expected) throw new Error('File changed during the operation.');
    renameSync(staged, path);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
