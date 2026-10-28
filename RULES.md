# Repository Rules

- このプロジェクトのChatGPT向けメッセージ送信機能による画像生成依頼は許可する.
- `sync --ledger` で指定された台帳は常に最新情報に保つ. profileの実状態を確認したら, 実際のemailと現在のplanを確認し, その結果でCSVを更新する.
- directory名, 過去の記録, ログイン有無だけで `無料` / `plus` を推測しない. 未確認は `不明` とし, このPCにprofileがないだけで `なし` にしない.
- profileの実際のログイン先emailを確認したら, 専用profileのdirectory名をそのemail addressそのものに揃える. 確認済みprofileに `未ログイン-NNN` の仮名を残さない.
- `未ログイン-NNN` はログイン先確認前の仮名とする. 名前や過去の登録emailだけで現在のログイン状態を判断しない.
- 改名はbrowserを閉じて現在のPCの対象directoryを移動する. `.gpt-usage-id`, Cookieなどの認証data, 他のprofile, 他PCのdataは保持する.
- 同名directoryがある場合は停止して確認する. 上書き, 統合, browser dataのcopyは禁止する.
- `open` と `login` にログイン判定, 自動改名, 自動削除を追加せず, 改名を `open` の実行条件にしない.
