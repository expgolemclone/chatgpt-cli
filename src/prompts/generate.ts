import { createHash } from 'node:crypto';
import { promptKinds } from './catalog.js';

export interface Prompt {
  id: string;
  text: string;
}

export const maxPrompts = promptKinds.reduce((total, kind) =>
  total + kind.parts.reduce((combinations, parts) => combinations * parts.length, 1), 0);

/** Combine meaningful clauses locally. No prompt history or network is used. */
export function generatePrompts(profileId: string, seed: string, count = 2): Prompt[] {
  if (!Number.isInteger(count) || count < 1 || count > maxPrompts) {
    throw new Error(`Prompt count must be between 1 and ${maxPrompts}.`);
  }
  return Array.from({ length: count }, (_, index) => {
    const choice = createHash('sha256').update(JSON.stringify([seed, profileId, index])).digest();
    const kind = promptKinds[choice.readUInt32LE(0) % promptKinds.length]!;
    const indices = kind.parts.map((parts, part) => choice.readUInt32LE((part + 1) * 4) % parts.length);
    const parts = kind.parts.map((options, part) => options[indices[part]!]!);
    return { id: `${kind.id}-${indices.join('')}`, text: kind.prefix + parts.join(', ') + kind.ending };
  });
}
