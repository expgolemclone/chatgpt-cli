import { createHash } from 'node:crypto';
import { templates } from './catalog.js';

export interface Prompt {
  id: string;
  text: string;
}

export const maxPrompts = templates.length;

/** Reproducible local templates + PRNG; no LLM or network is used. */
export function generatePrompts(
  profileId: string, seed: string, count = 2,
): Prompt[] {
  if (!Number.isInteger(count) || count < 1 || count > maxPrompts) {
    throw new Error(`Prompt count must be between 1 and ${maxPrompts}.`);
  }
  let state = createHash('sha256').update(`${seed}:${profileId}`).digest().readUInt32LE(0);
  const random = () => {
    state = (state + 0x6D2B79F5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const available = [...templates];
  const prompts: Prompt[] = [];
  for (let i = 0; i < count; i++) {
    const template = available.splice(Math.floor(random() * available.length), 1)[0]!;
    prompts.push({
      id: template.id,
      text: template.render(3 + Math.floor(random() * 15)),
    });
  }
  return prompts;
}
