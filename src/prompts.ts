import { createHash } from 'node:crypto';

export interface Prompt {
  id: string;
  text: string;
}

type Template = { id: string; language: string; code: (n: number) => string };
const templates: Template[] = [
  {
    id: 'off-by-one', language: 'typescript',
    code: n => `function sumTo(n: number): number {\n  let total = 0;\n  for (let i = 1; i < n; i++) total += i;\n  return total;\n}\nconsole.log(sumTo(${n})); // 1から${n}までの合計にしたい`,
  },
  {
    id: 'mutable-default', language: 'python',
    code: n => `def add_value(value, values=[]):\n    values.append(value)\n    return values\n\nprint(add_value(${n}))\nprint(add_value(${n + 1}))  # 呼び出しごとに独立したリストにしたい`,
  },
  {
    id: 'async-foreach', language: 'typescript',
    code: n => `async function doubleAll(values: number[]): Promise<number[]> {\n  const result: number[] = [];\n  values.forEach(async value => {\n    await new Promise(resolve => setTimeout(resolve, 10));\n    result.push(value * 2);\n  });\n  return result;\n}\nconsole.log(await doubleAll([${n}, ${n + 1}, ${n + 2}]));`,
  },
  {
    id: 'mutating-sort', language: 'typescript',
    code: n => `function sortedCopy(values: number[]): number[] {\n  return values.sort();\n}\nconst original = [${n}, ${n * 10}, ${n + 1}, 2];\nconst sorted = sortedCopy(original);\nconsole.log({ original, sorted }); // 元の配列を変えず, 数値の昇順にしたい`,
  },
  {
    id: 'late-binding', language: 'python',
    code: n => `callbacks = []\nfor i in range(${n}):\n    callbacks.append(lambda: i)\n\nprint([callback() for callback in callbacks])\n# 0から${n - 1}まで順に表示したい`,
  },
  {
    id: 'integer-division', language: 'python',
    code: n => `def average(values):\n    return sum(values) // len(values)\n\nprint(average([${n}, ${n + 1}]))\nprint(average([]))\n# 小数を保持した平均を求め, 空リストも適切に処理したい`,
  },
];

export const maxQuestions = templates.length;

/** Reproducible local templates + PRNG; no LLM or network is used. */
export function generatePrompts(
  profileId: string, seed: string, count = 2,
): Prompt[] {
  if (!Number.isInteger(count) || count < 1 || count > maxQuestions) {
    throw new Error(`Question count must be between 1 and ${maxQuestions}.`);
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
    const n = 3 + Math.floor(random() * 15);
    prompts.push({
      id: template.id,
      text: `次のコードをレビューしてください. 実際の動作と意図との差を説明し, 修正版のコード, 境界条件, 具体的なテスト例を示してください.\n\n\`\`\`${template.language}\n${template.code(n)}\n\`\`\``,
    });
  }
  return prompts;
}
