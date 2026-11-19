import { createHash } from 'node:crypto';
import { join } from 'node:path';
import lockfile from 'proper-lockfile';

export function acquirePathLock(path: string): Promise<() => Promise<void>> {
  const key = createHash('sha256').update(path.toLowerCase()).digest('hex');
  return lockfile.lock(path, {
    lockfilePath: join('C:/dev/tmp', 'chatgpt-cli-' + key + '.lock'),
    stale: 120_000, update: 10_000, retries: 0,
  });
}
