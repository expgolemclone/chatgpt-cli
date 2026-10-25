import { createHash } from 'node:crypto';
import { promptKinds } from './catalog.js';

export interface Prompt {
  id: string;
  text: string;
}

export const maxPrompts = promptKinds.reduce((total, kind) => total + kind.prompts.length, 0);

export function generatePrompts(profileId: string, seed: string, count = 5): Prompt[] {
  if (!Number.isInteger(count) || count < 1 || count > maxPrompts) {
    throw new Error(`Prompt count must be between 1 and ${maxPrompts}.`);
  }
  const groups = promptKinds.map(kind => kind.prompts.map(prompt => ({
    id: `${kind.id}-${prompt.id}`,
    text: kind.prefix + prompt.text,
    rank: createHash('sha256').update(JSON.stringify([seed, profileId, kind.id, prompt.id])).digest('hex'),
  })).sort((a, b) => a.rank.localeCompare(b.rank)))
    .sort((a, b) => a[0]!.rank.localeCompare(b[0]!.rank));

  const prompts: Prompt[] = [];
  for (let round = 0; prompts.length < count; round++) {
    for (const group of groups) {
      const prompt = group[round];
      if (prompt && prompts.length < count) prompts.push({ id: prompt.id, text: prompt.text });
    }
  }
  return prompts;
}
