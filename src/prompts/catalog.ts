type Template = { id: string; render: (n: number) => string };

const codeReview = '次のコードをレビューしてください. 実際の動作と意図との差を説明し, 修正版のコード, 境界条件, 具体的なテスト例を示してください.';

export const templates: readonly Template[] = [
  {
    id: 'off-by-one',
    render: n => `${codeReview}

\`\`\`typescript
function sumTo(n: number): number {
  let total = 0;
  for (let i = 1; i < n; i++) total += i;
  return total;
}
console.log(sumTo(${n})); // 1から${n}までの合計にしたい
\`\`\``,
  },
  {
    id: 'mutable-default',
    render: n => `${codeReview}

\`\`\`python
def add_value(value, values=[]):
    values.append(value)
    return values

print(add_value(${n}))
print(add_value(${n + 1}))  # 呼び出しごとに独立したリストにしたい
\`\`\``,
  },
  {
    id: 'async-foreach',
    render: n => `${codeReview}

\`\`\`typescript
async function doubleAll(values: number[]): Promise<number[]> {
  const result: number[] = [];
  values.forEach(async value => {
    await new Promise(resolve => setTimeout(resolve, 10));
    result.push(value * 2);
  });
  return result;
}
console.log(await doubleAll([${n}, ${n + 1}, ${n + 2}]));
\`\`\``,
  },
  {
    id: 'mutating-sort',
    render: n => `${codeReview}

\`\`\`typescript
function sortedCopy(values: number[]): number[] {
  return values.sort();
}
const original = [${n}, ${n * 10}, ${n + 1}, 2];
const sorted = sortedCopy(original);
console.log({ original, sorted }); // 元の配列を変えず, 数値の昇順にしたい
\`\`\``,
  },
  {
    id: 'late-binding',
    render: n => `${codeReview}

\`\`\`python
callbacks = []
for i in range(${n}):
    callbacks.append(lambda: i)

print([callback() for callback in callbacks])
# 0から${n - 1}まで順に表示したい
\`\`\``,
  },
  {
    id: 'integer-division',
    render: n => `${codeReview}

\`\`\`python
def average(values):
    return sum(values) // len(values)

print(average([${n}, ${n + 1}]))
print(average([]))
# 小数を保持した平均を求め, 空リストも適切に処理したい
\`\`\``,
  },
  {
    id: 'image-presentation-cover',
    render: () => '@create image\n社内向けのAI活用説明資料の表紙用イラストを作成してください. 横長16:9, 白と青を基調にしたシンプルなデザインで, 人とAIが協力して仕事を進める様子を表現してください. タイトルを後から配置できる余白を上部に残し, 文字や企業ロゴは入れないでください.',
  },
  {
    id: 'image-development-workflow',
    render: () => '@create image\n開発者がAIに実装を相談し, コードをレビューして, テストで確認する流れを図解してください. 横長のフラットイラストで, 左から右へ3つの工程を矢印でつなぎ, 各工程を人物と道具で区別してください. 文字を使わずに意味が伝わる構図にしてください.',
  },
  {
    id: 'image-app-icon',
    render: () => '@create image\n社内の開発支援ツール用に, 人とAIの協力を表すアプリアイコンを作成してください. 正方形, 青と緑の2色を中心にしたフラットデザインで, 小さく表示しても識別できる単純な形にしてください. 文字, 企業ロゴ, 細かな装飾は入れないでください.',
  },
  {
    id: 'codex-pilot',
    render: n => `Codexを社内で導入検討している. まず開発者${n}人で4週間のPoCを実施したい. 対象業務の選び方, 週ごとの実施内容, レビューとテストの責任分担, 生産性と品質の評価指標, 本導入の判断基準を具体的に提案してください. 不明な前提は明示し, 小さく始められる計画にしてください.`,
  },
  {
    id: 'codex-security',
    render: () => 'Codexを社内で導入検討している. 情報システム部門とセキュリティ担当に説明するため, ソースコードや機密情報の取り扱い, 送信データと保持条件, 実行権限, 外部通信, 監査, 人による承認の観点で確認事項を整理してください. 社内で決める利用ルールと提供元に確認する製品仕様を分け, 導入前のチェックリストを示してください. 製品仕様は最新の公式情報を出典付きで確認し, 未確認の点は断定しないでください.',
  },
  {
    id: 'codex-cost-and-rollout',
    render: n => `Codexを社内で導入検討している. 開発者${n}人のチームを想定し, 費用対効果の試算方法と段階的な展開案を提案してください. 利用費だけでなく, 教育, レビュー, 手戻りの時間も含め, 導入前後で比較する指標と効果が出ない場合の中止基準を示してください. 仮の数値は仮定と明記し, 価格や契約条件は最新の公式情報を確認したうえで扱ってください.`,
  },
];
