export const codeReviewPrompts = [
  {
    id: 'double-charge',
    text: `深夜の月面ホテルで, 同じ予約IDの宿泊料が二度引き落とされた. 単一プロセス内では同じIDへの同時呼び出しを一度の請求にまとめ, 失敗後は再試行できる仕様だった.
\`\`\`js
const paid = new Map();
async function checkout(id, charge) {
  if (paid.has(id)) return paid.get(id);
  const result = await charge(id);
  paid.set(id, result);
  return result;
}
\`\`\`
障害調査員として, 二つの呼び出しがすり抜ける時系列を再構成してください. 時間待ちに頼らない再現テストと修正案を示し, プロセス再起動後の重複まで防げるかは別に論じてください.`,
  },
  {
    id: 'monday-museum',
    text: `月曜休館の博物館で, 同じチケットが東京では無効なのにロサンゼルスでは有効になった. 入力は有効なYYYY-MM-DD形式で, 時刻ではなく現地の暦の日付を表す.
\`\`\`js
function isOpen(date) {
  return new Date(date).getDay() !== 1;
}
\`\`\`
2026-01-05を使い, TZがAsia/Tokyoの場合とAmerica/Los_Angelesの場合の違いを説明してください. ミリ秒を足す応急処置は禁止です. 実行環境のタイムゾーンに左右されない修正と, 日曜と月曜を含むテストを提案してください.`,
  },
  {
    id: 'ghost-cart',
    text: `宇宙港の売店で, 購入確認画面を開いただけなのに本物のカートから月のお茶が減っていく. プレビューは何度呼んでも元のカートを変えない契約だった.
\`\`\`js
const cart = { items: [{ sku: 'moon-tea', quantity: 2 }] };
function preview(cart) {
  const draft = { ...cart };
  draft.items[0].quantity -= 1;
  return draft;
}
\`\`\`
参照関係をASCII図で描き, 連続二回のプレビューで何が起きるか追跡してください. このデータ構造に必要な範囲だけをコピーする修正と, 元データが不変であることを確かめるテストを示してください.`,
  },
  {
    id: 'search-race',
    text: `探偵の検索端末で, 最後に入力したdragonより古いdrの結果が画面を占領した. fetchResultsは非同期で, 呼び出し順に完了する保証はない.
\`\`\`js
async function search(query) {
  const rows = await fetchResults(query);
  render(rows);
}
\`\`\`
通信を遅くするのではなく, 任意の順で完了できる偽物のPromiseを使って事件を再現してください. 最後の検索だけを描画する修正を示し, 古い通信をキャンセルする方法だけで十分かも検討してください.`,
  },
  {
    id: 'infinite-bookshelf',
    text: `無限図書館の司書が, たった二冊の棚を調べたまま帰ってこない. 昇順かつ重複なしの数列からtargetを探し, なければ-1を返す関数をレビューしてください.
\`\`\`js
function find(values, target) {
  let low = 0, high = values.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] < target) low = mid;
    else high = mid;
  }
  return values[low] === target ? low : -1;
}
\`\`\`
終了しない最小の入力を示し, 各周回の探索範囲を表にしてください. 修正版では何が毎回小さくなるのかを説明し, 空配列と両端と範囲外を検証してください.`,
  },
  {
    id: 'sealed-exam',
    text: `魔法学校の封印済み答案を先生だけが書き換えられてしまった. 仕様は, 封印済みなら全員が編集不可, 未封印なら先生は全答案を編集可, 生徒は自分の答案だけ編集可である. 利用者は先生か生徒のどちらかとする.
\`\`\`js
function canEdit(user, answer) {
  return user.role === 'teacher' ||
    answer.ownerId === user.id && !answer.locked;
}
\`\`\`
先生かどうか, 所有者かどうか, 封印済みかどうかの真理値表を作り, 仕様と食い違う行を特定してください. 括弧だけで直す案と名前付き条件に分ける案を比較し, 次の担当者が誤読しにくい方を選んでください.`,
  },
  {
    id: 'locked-airlock',
    text: `宇宙船の気密扉が, 一回の作業失敗を境に二度と開かなくなった. acquireは非同期でロックを取り, 取得成功時だけ同期的な解放関数を返す. 解放関数自体は例外を投げない.
\`\`\`js
async function runWithLock(acquire, work) {
  const release = await acquire();
  const value = await work();
  release();
  return value;
}
\`\`\`
workの成功と失敗とacquireの失敗を別々に追跡してください. 元の例外を握りつぶさずに直し, 取得したロックだけが必ず一回解放されることをテストで示してください.`,
  },
  {
    id: 'unfinished-archive',
    text: `竜の観測記録を保存する処理が完了と報告したのに, 倉庫には空のファイルしかなかった. saveは非同期で, closeは保存先を閉じる処理である.
\`\`\`js
async function archive(rows, save, close) {
  rows.forEach(async row => {
    await save(row);
  });
  await close();
}
\`\`\`
コールバック内のawaitが外側を待たせない理由を説明してください. 同時保存を禁止する仕様として書き直し, 途中の保存が失敗してもcloseを呼びつつ失敗を呼び出し元へ返すテストを作ってください.`,
  },
  {
    id: 'auction-prices',
    text: `妖精の競売場で最安値を尋ねたら100枚と言われ, さらに元の価格表の並びまで変わった. 入力は空でない有限の正数配列であり, 関数は元の配列を変更してはいけない.
\`\`\`js
function cheapest(prices) {
  return prices.sort()[0];
}
\`\`\`
[3, 20, 100]を使って独立した二つの問題を突き止めてください. 並べ替えを直す案と並べ替え自体をやめる案を比較し, 配列が百万件になった場合も考えて選んでください. 不変性を検証するテストも必要です.`,
  },
  {
    id: 'perfect-coverage',
    text: `遊園地の割引計算はカバレッジ100%なのに, 子どもから大人料金を取っていた. 仕様は12歳以下が500円, 13歳以上が1000円で, 入力は0以上の整数とする.
\`\`\`js
function fare(age) {
  return age < 12 ? 500 : 1000;
}
for (const age of [8, 12, 20]) {
  const expected = fare(age);
  assert.equal(fare(age), expected);
}
\`\`\`
実装の不具合とテストの不具合を別々に告発してください. 期待値を実装から作らないテストに直し, 比較演算子を一文字変える変異を使って, カバレッジだけでは保証できないものを説明してください.`,
  },
  {
    id: 'null-ban-list',
    text: `SQLiteの利用者表にはID 1, 2, 3があり, ban表のcustomer_idには2とNULLが入っている. NULLは利用者を指定しない. 停止されていない利用者を返す次の問合せをレビューしてください.
\`\`\`sql
SELECT id FROM users
WHERE id NOT IN (SELECT customer_id FROM bans);
\`\`\`
実際に返る行を三値論理で説明し, NULLを含む場合も意図どおりになる問合せと小さな検証データを示してください.`,
  },
  {
    id: 'vanishing-customers',
    text: `注文のない顧客も含めて, 支払済み注文だけを結合したい. 次のSQLをレビューしてください.
\`\`\`sql
SELECT c.id, o.id
FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'paid';
\`\`\`
注文なし, 未払のみ, 支払済みありの三人について結果を追い, 条件の位置を直してください. 未払注文のある顧客を消さないテストも示してください.`,
  },
  {
    id: 'empty-order-count',
    text: `注文が一件もない店舗は0件と表示する. orders.idはNULLにならない主キーである.
\`\`\`sql
SELECT s.id, COUNT(*) AS orders
FROM shops s LEFT JOIN orders o ON o.shop_id = s.id
GROUP BY s.id;
\`\`\`
空の店舗が1件と数えられる理由を結合結果から説明し, 修正案と0件, 1件, 2件の検証例を示してください.`,
  },
  {
    id: 'midnight-double-count',
    text: `UTCで保存した注文を日別に集計するSQLです. 隣り合う二日間の集計に同じ注文が入らない契約です.
\`\`\`sql
SELECT COUNT(*) FROM orders
WHERE created_at BETWEEN :start AND :next_midnight;
\`\`\`
翌日ちょうど00:00の注文がどう扱われるか説明してください. 末尾の小数秒を推測せずに直し, 日境界直前と境界上のテストを作ってください.`,
  },
  {
    id: 'unstable-pages',
    text: `在庫一覧を20件ずつ表示するSQLです. priceが同じ商品は多数あります. ページを読んでいる間にデータは変わらないものとします.
\`\`\`sql
SELECT id, price FROM products
ORDER BY price LIMIT 20 OFFSET :offset;
\`\`\`
同額の商品がページ境界にある場合に順序が一意でない理由を説明し, 一意なidを使う修正を示してください. データが途中で追加された場合は別の問題として扱ってください.`,
  },
  {
    id: 'coin-rounding',
    text: `SQLiteのレジで金額をREAL型で保存し, 合計が一致したときだけ領収書を確定するコードです.
\`\`\`sql
SELECT SUM(amount) = 0.3 AS matches FROM sales;
-- amount: 0.1, 0.2
\`\`\`
二進浮動小数点の問題と, 小数二桁の通貨を整数の最小単位で扱う設計を説明してください. 移行時の丸め規則を勝手に決めず, 境界例と確認事項を挙げてください.`,
  },
  {
    id: 'name-as-sql',
    text: `名前で顧客を検索する処理をレビューしてください. dbはSQLと値を別々に渡せるAPIを持ちます.
\`\`\`js
function findCustomer(db, name) {
  return db.all("SELECT id FROM customers WHERE name = '" + name + "'");
}
\`\`\`
引用符を含む通常の名前が壊れる例と, 入力をSQLとして解釈させる危険を分けて説明してください. 値のバインドを使った修正と二種類のテストを示してください.`,
  },
  {
    id: 'last-seat',
    text: `座席の残数が1のときに二人が同時予約する. 各処理は別トランザクションで, 現在の実装は次の順です.
\`\`\`sql
SELECT remaining FROM shows WHERE id = :id;
-- remaining > 0 なら予約を作る
UPDATE shows SET remaining = remaining - 1 WHERE id = :id;
\`\`\`
両方が残数1を読む時系列を示してください. 条件付き更新の影響行数を確かめる案を示し, 予約作成と更新を同一トランザクションに含める理由を説明してください.`,
  },
  {
    id: 'unique-migration',
    text: `PostgreSQLの利用者表にメールアドレスの一意制約を追加する差分です. 既存の重複行には別々の注文履歴があるため, 勝手に削除してはいけません.
\`\`\`sql
ALTER TABLE users ADD CONSTRAINT users_email_unique UNIQUE (email);
\`\`\`
適用前の調査と重複解消の判断を含む段階的な移行計画をレビューしてください. NULLと大文字小文字の扱いは未決定事項として確認し, 失敗時の復旧も考えてください.`,
  },
  {
    id: 'shared-notebook',
    text: `Pythonの貸出カードを作る関数です. 呼び出しごとに独立したメモが必要です.
\`\`\`python
def card(name, notes=[]):
    notes.append(name)
    return notes
\`\`\`
引数を省略して二回呼んだ結果を追い, デフォルト値が作られる時点を説明してください. 修正と明示的なリストを渡した場合のテストも示してください.`,
  },
  {
    id: 'same-label',
    text: `Pythonの設定読み込みで, 値が文字列readyなら処理を開始します.
\`\`\`python
def can_start(status):
    return status is 'ready'
\`\`\`
同じ文字列内容でも判定が不安定になり得る理由を, 同一性と値の等価性の違いから説明してください. 修正と動的に作った文字列を使うテストを示してください.`,
  },
  {
    id: 'consumed-stream',
    text: `一度しか走査できないPythonのジェネレータを受け取り, 正の値の件数と合計を返します.
\`\`\`python
def report(values):
    count = sum(1 for value in values if value > 0)
    total = sum(value for value in values if value > 0)
    return count, total
\`\`\`
入力iter([1, 2, -1])の結果を追い, 一回の走査で直してください. 空入力と大きな入力でも不要な全件コピーをしないことを検証してください.`,
  },
  {
    id: 'late-buttons',
    text: `Pythonで三つの操作を用意します. 各関数は作成時の番号を返す契約です.
\`\`\`python
actions = []
for number in range(3):
    actions.append(lambda: number)
\`\`\`
各関数を後から呼ぶ結果と変数の参照関係を説明してください. 値を固定する修正を二案示し, 三つの結果を別々に検証してください.`,
  },
  {
    id: 'cropped-sensors',
    text: `Pythonで時刻と温度を対にします. 件数が違う場合は途中まで保存せずエラーにする仕様です.
\`\`\`python
def readings(times, temperatures):
    return list(zip(times, temperatures))
\`\`\`
長さが異なる入力で何が失われるか示し, Python 3.11のstrictオプションを使う修正を提案してください. リストだけでなく一度きりのイテレータでもテストしてください.`,
  },
  {
    id: 'shared-grid',
    text: `Pythonで独立した三行の盤面を作りたい.
\`\`\`python
grid = [[0] * 3] * 3
grid[0][1] = 7
\`\`\`
実際の盤面と行オブジェクトの参照を示し, 内包表記で直してください. 一つのセルを変えても他の行が変わらないテストを作ってください.`,
  },
  {
    id: 'dictionary-cleanup',
    text: `Pythonの辞書から値が0の項目を除きます. 呼び出し元の辞書を更新する契約です.
\`\`\`python
def remove_zero(counts):
    for key, value in counts.items():
        if value == 0:
            del counts[key]
\`\`\`
実行時に起きる問題を示し, 走査対象を安全に固定する修正と, 複数の0が並ぶ入力のテストを示してください.`,
  },
  {
    id: 'hidden-file-error',
    text: `Pythonで設定ファイルを読みます. ファイルが存在しない場合だけ空の設定を返し, 権限不足やJSON不正は呼び出し元に知らせます.
\`\`\`python
try:
    with open(path, encoding='utf-8') as file:
        return json.load(file)
except Exception:
    return {}
\`\`\`
握りつぶされる失敗を分類し, 例外の範囲を絞ってください. 不在, 権限エラー, 不正なJSONをそれぞれ独立して検証してください.`,
  },
  {
    id: 'blocking-coroutine',
    text: `Pythonのasyncioで二つの通知を並行して待つ処理です.
\`\`\`python
async def notify(send):
    time.sleep(2)
    await send()
\`\`\`
同期sleepがイベントループを止める影響を説明し, 非同期の待機へ直してください. 実際の二秒待ちに頼らず, 他のタスクが進むことを確かめるテストを提案してください.`,
  },
  {
    id: 'temporary-export',
    text: `Pythonで一時ファイルを使ってエクスポートする処理です. exportが例外を投げてもファイルを残してはいけません.
\`\`\`python
path = make_temporary_file()
export(path)
os.unlink(path)
\`\`\`
失敗時の資源漏れを説明し, 所有権が明確な後始末を提案してください. 元の例外を失わない扱いと, 削除自体が失敗した場合に何を報告するかも検討してください.`,
  },
  {
    id: 'archive-boundary',
    text: `アップロードされたZIPを作業ディレクトリへ展開するPythonの差分です. アーカイブ内の名前は信頼できません.
\`\`\`python
for entry in archive.infolist():
    target = os.path.join(destination, entry.filename)
    with open(target, 'wb') as output:
        output.write(archive.read(entry))
\`\`\`
親ディレクトリへ出る名前や絶対パスを使った失敗例を挙げ, 展開先の境界を守る設計を示してください. シンボリックリンクとWindowsのパスも別途検討してください.`,
  },
  {
    id: 'zero-volume',
    text: `音量0も有効なJavaScriptの設定です. 未指定の場合だけ50を使います.
\`\`\`js
function volume(settings) {
  return settings.volume || 50;
}
\`\`\`
0が無視される理由を説明し, nullとundefinedだけを既定値にする修正を示してください. 0, 50, null, 未指定の期待値をテストに書いてください.`,
  },
  {
    id: 'unsafe-greeting',
    text: `ユーザーが入力した表示名をそのまま文字として見せたい. nameは信頼できない値です.
\`\`\`js
function greet(element, name) {
  element.innerHTML = 'Hello, ' + name;
}
\`\`\`
HTMLとして解釈される入力例を示し, 表示だけが目的の場合のDOM APIで直してください. タグが実行されず文字として残るテストを提案してください.`,
  },
  {
    id: 'identity-map',
    text: `座標の値が同じなら同じ倉庫を取り出すJavaScriptです.
\`\`\`js
const stores = new Map();
stores.set({ x: 1, y: 2 }, 'north');
console.log(stores.get({ x: 1, y: 2 }));
\`\`\`
結果とオブジェクトのキー比較を説明してください. xとyが整数という前提で衝突しないキー表現を設計し, 異なる座標を誤って混同しないテストを示してください.`,
  },
  {
    id: 'truthful-fetch',
    text: `fetchがHTTP 500を返したときは保存失敗として呼び出し元に知らせます.
\`\`\`js
async function load(url) {
  const response = await fetch(url);
  return response.json();
}
\`\`\`
通信失敗とHTTPエラーでPromiseがどう変わるかを分けて説明し, response.okを確認する修正を示してください. 不正なJSONも別の失敗としてテストしてください.`,
  },
  {
    id: 'post-retry',
    text: `配達依頼をPOSTするコードです. サーバーが依頼を受け取った後に応答だけ失われる場合があります.
\`\`\`js
try {
  return await createDelivery(order);
} catch {
  return await createDelivery(order);
}
\`\`\`
二重配達の時系列を説明してください. 失敗が確定した場合と結果不明の場合を区別し, サーバー側の冪等性キーを使える場合と使えない場合の運用を比較してください.`,
  },
  {
    id: 'missing-validation',
    text: `TypeScriptで外部から受け取ったJSONを使います. countは0以上の整数である必要があります.
\`\`\`ts
type Settings = { count: number };
function load(raw: string): Settings {
  return JSON.parse(raw) as Settings;
}
\`\`\`
型アサーションだけでは実行時に保証されない理由を説明してください. 不正なJSON, 欠落, 文字列, 負数を拒否する検証例とテストを示してください.`,
  },
  {
    id: 'unstable-comparator',
    text: `JavaScriptで優先度の高い順に並べ, 同じ優先度は元の順を維持します.
\`\`\`js
jobs.sort((a, b) => a.priority > b.priority ? -1 : 1);
\`\`\`
同値の場合でも1を返す比較関数の問題を説明し, 数値の優先度を前提に直してください. 同値を含む入力と元配列を変更してよいかの契約を確認してください.`,
  },
  {
    id: 'defer-in-loop',
    text: `Goで複数のファイルを一つずつ読みます. 同時に開くファイルは最大一つにしたい.
\`\`\`go
for _, name := range names {
    f, err := os.Open(name)
    if err != nil { return err }
    defer f.Close()
    if err := process(f); err != nil { return err }
}
\`\`\`
deferが実行される時点とファイル数が多い場合の影響を説明してください. 一件ごとに閉じる構造と, 処理失敗とclose失敗をどう扱うかを示してください.`,
  },
  {
    id: 'nil-map',
    text: `Goで単語の出現数を数えます.
\`\`\`go
func count(words []string) map[string]int {
    var counts map[string]int
    for _, word := range words { counts[word]++ }
    return counts
}
\`\`\`
空入力と一件以上の入力での動作を説明し, 書き込み可能なmapを作る修正を示してください. 同じ単語が二回あるテストを含めてください.`,
  },
  {
    id: 'concurrent-counter',
    text: `Goで二つのgoroutineがカウンタを100回ずつ増やします. 最終値は200でなければなりません.
\`\`\`go
var count int
for i := 0; i < 2; i++ {
    go func() { for j := 0; j < 100; j++ { count++ }; done <- true }()
}
<-done; <-done
fmt.Println(count)
\`\`\`
完了待ちがあっても更新競合が消えない理由を説明してください. atomicまたはmutexによる修正とrace detectorを使う検証を提案してください.`,
  },
  {
    id: 'cancelled-worker',
    text: `Goのworkerはcontextが終了したら待機中でも抜ける契約です.
\`\`\`go
func worker(ctx context.Context, jobs <-chan Job) error {
    for {
        job := <-jobs
        handle(job)
    }
}
\`\`\`
仕事が来ないときの停止不能と, channelが閉じたときの動作を別々にレビューしてください. selectと受信のok値を使う修正および決定的なテストを示してください.`,
  },
  {
    id: 'response-body',
    text: `GoでHTTP応答のstatusを確認する処理です. 成功時も失敗時も取得したbodyを閉じる必要があります.
\`\`\`go
resp, err := client.Do(req)
if err != nil { return err }
if resp.StatusCode != 200 { return fmt.Errorf("bad status") }
return json.NewDecoder(resp.Body).Decode(&result)
\`\`\`
資源の所有期間を説明し, bodyを閉じる位置を示してください. HTTPエラーとJSONエラーの両方でcloseされるテストを提案してください.`,
  },
  {
    id: 'utf8-cut',
    text: `Rustで最初の文字を表示する関数です. 入力は日本語を含む任意のUTF-8文字列です.
\`\`\`rust
fn first(s: &str) -> &str {
    &s[0..1]
}
\`\`\`
空文字と先頭が日本語の文字列で何が起きるかを説明してください. Unicodeスカラー値を一つ返すOption<char>の案を示し, 書記素とは異なることも明記してください.`,
  },
  {
    id: 'decimal-scale',
    text: `Javaで金額が数値として同じかを比較します. 小数点以下の桁数は比較条件ではありません.
\`\`\`java
new BigDecimal("1.0").equals(new BigDecimal("1.00"))
\`\`\`
結果とequalsがscaleも比較する理由を説明し, 数値比較の修正を示してください. nullの扱いを未決定事項にしたうえで, 1.0と1.00と1.01をテストしてください.`,
  },
  {
    id: 'file-name-spaces',
    text: `Bashで入力ディレクトリの通常ファイルを一つずつ処理します. ファイル名には空白や改行も含まれます.
\`\`\`bash
for file in $(find "$dir" -type f); do
  process "$file"
done
\`\`\`
単語分割によって壊れる例を挙げ, NUL区切りを使う安全な案を示してください. 先頭がハイフンの名前も含むテストを提案してください.`,
  },
  {
    id: 'pipeline-status',
    text: `Bashでバックアップを圧縮して保存します. backupが失敗したらスクリプト全体を失敗にしたい.
\`\`\`bash
backup | gzip > backup.gz
echo "backup complete"
\`\`\`
通常のパイプライン終了状態だけでは見落とす失敗を説明してください. pipefailを含む修正と, 部分的な出力を成功した成果物として残さない設計を提案してください.`,
  },
  {
    id: 'keyboard-button',
    text: `一覧の削除操作を追加したHTMLです. マウスだけでなくキーボードでも操作できなければなりません.
\`\`\`html
<div class="delete" onclick="removeItem()">Delete</div>
\`\`\`
標準のbuttonに置き換える利点を説明し, フォーム内での意図しない送信を避ける属性も示してください. キーボード操作と支援技術向けの名前を検証してください.`,
  },
  {
    id: 'private-cache',
    text: `ログイン利用者ごとに異なる請求明細を返すHTTPレスポンスです. 間に共有キャッシュがあります.
\`\`\`http
HTTP/1.1 200 OK
Cache-Control: public, max-age=3600
Content-Type: application/json
\`\`\`
別の利用者に内容が渡る危険を説明してください. 保存させない方針でヘッダーを見直し, 認証の有無とキャッシュの振る舞いを検証する方法を示してください.`,
  },
  {
    id: 'csv-formula',
    text: `顧客名をCSVへ出力し, 人が表計算ソフトで開きます. 顧客名は外部入力で, CSVの引用符処理自体はライブラリに任せています.
\`\`\`js
stringify([{ name: '=1+1' }], { header: true });
\`\`\`
CSVの構文上正しくても表計算ソフトで数式として扱われる問題を説明してください. 対象ソフトの挙動を確認したうえで値を安全に扱う方針と, 先頭の記号や空白を含むテストを提案してください.`,
  },
  {
    id: 'yaml-public-binding',
    text: `ローカル開発用の管理画面を起動する設定です. この画面には認証機能がありません.
\`\`\`yaml
admin:
  host: 0.0.0.0
  port: 9000
\`\`\`
意図せずネットワークへ公開される可能性をレビューし, ローカル利用に限定する設定案を示してください. コンテナ内でのアドレス解釈は別途確認事項にし, 実際の待受を検証する方法を提案してください.`,
  },
] as const;
