import { createHash } from 'node:crypto';
import { promptKinds } from './catalog.ts';

export interface Prompt {
  id: string;
  text: string;
}

const catalog = promptKinds.flatMap((kind, category) => kind.prompts.map(prompt => ({
  id: `${kind.id}-${prompt.id}`,
  text: kind.prefix + prompt.text,
  category,
})));
export const maxPrompts = catalog.length;

const rank = (...parts: (string | number)[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Plan all profiles together, using actual prior attempts rather than planned or completed work. */
export function generateBatches(profileIds: string[], seed: string, count = 5,
  history: ReadonlyMap<string, number> = new Map()): Prompt[][] {
  if (!Number.isInteger(count) || count < 1 || count > maxPrompts) {
    throw new Error(`Prompt count must be between 1 and ${maxPrompts}.`);
  }

  const categoryCount = promptKinds.length;
  const base = Math.floor(count / categoryCount);
  const extras = count % categoryCount;
  const compareAge = (a: number, b: number) => a === b ? 0 : a < b ? -1 : 1;
  const ages = promptKinds.map((_, category) => catalog.filter(prompt => prompt.category === category)
    .map(prompt => history.get(prompt.id) ?? Number.NEGATIVE_INFINITY).sort(compareAge));
  const quotas = (offset: number) => profileIds.map((_, profile) => {
    const result = Array<number>(categoryCount).fill(base);
    for (let extra = 0; extra < extras; extra++) {
      result[(offset + profile * extras + extra) % categoryCount]!++;
    }
    return result;
  });
  const offsets = Array.from({ length: categoryCount }, (_, offset) => {
    const allocation = quotas(offset);
    const selected = ages.flatMap((categoryAges, category) => categoryAges.slice(0,
      allocation.reduce((sum, profile) => sum + profile[category]!, 0))).sort(compareAge);
    return { allocation, selected, rank: rank(seed, 'categories', offset) };
  }).sort((a, b) => {
    for (let index = 0; index < a.selected.length; index++) {
      const difference = compareAge(a.selected[index]!, b.selected[index]!);
      if (difference) return difference;
    }
    return a.rank.localeCompare(b.rank);
  });
  const allocation = offsets[0]!.allocation;
  const profiles = profileIds.map((profileId, index) => ({
    prompts: [] as Prompt[],
    chosen: new Set<string>(),
    used: Array<number>(categoryCount).fill(0),
    quota: allocation[index]!,
    ranked: catalog.map(prompt => ({ ...prompt, rank: rank(seed, profileId, prompt.id) })),
  }));
  const batchUsed = new Set<string>();
  for (let index = 0; index < count; index++) {
    for (const profile of profiles) {
      const leastUsed = Math.min(...profile.used.filter((used, category) => used < profile.quota[category]!));
      const eligible = profile.ranked.filter(prompt => !profile.chosen.has(prompt.id) &&
        profile.used[prompt.category] === leastUsed && profile.used[prompt.category]! < profile.quota[prompt.category]!);
      const unused = eligible.filter(prompt => !batchUsed.has(prompt.id));
      const choices = unused.length ? unused : eligible;
      choices.sort((a, b) => {
        const first = history.get(a.id) ?? Number.NEGATIVE_INFINITY;
        const second = history.get(b.id) ?? Number.NEGATIVE_INFINITY;
        return compareAge(first, second) || a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id);
      });
      const chosen = choices[0]!;
      profile.prompts.push({ id: chosen.id, text: chosen.text });
      profile.chosen.add(chosen.id);
      profile.used[chosen.category]!++;
      batchUsed.add(chosen.id);
    }
  }
  return profiles.map(profile => profile.prompts);
}
