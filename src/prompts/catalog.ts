import { codeReviewPrompts } from './code-review.ts';
import { codexPrompts } from './codex.ts';
import { imagePrompts } from './image.ts';

export const promptKinds = [
  { id: 'code-review', prefix: '', prompts: codeReviewPrompts },
  { id: 'image', prefix: '@create image\n文字や企業ロゴは入れないでください.\n', prompts: imagePrompts },
  { id: 'codex', prefix: '', prompts: codexPrompts },
] as const;
