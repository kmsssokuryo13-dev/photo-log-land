# photo-log-land local production launcher

土地写真台帳アプリを Windows で `http://localhost:5178/` に起動するための script 群です
（doc-make・doc-make-land の `scripts/launcher` と同じ仕組み）。

## セットアップ（PC ごとに1回）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\launcher\setup-shortcuts.ps1
```

current user の Desktop に `土地写真台帳`（起動）と `土地写真台帳 終了（推奨）`（停止）を作ります。

## SURVIA から

SURVIA の設定「土地写真台帳」でこのフォルダを選ぶと、

- SURVIA を起動したときに、止まっていれば裏で起動しておきます（`-NoBrowser`）。
- 案件の「写真台帳」→「土地」→「土地写真台帳で開く」で、案件のフォルダの写真（P12遠景 など）と現場名・境界標を入れた状態で開きます。
- 「SURVIAへ戻す」で、点名・標識・撮影日を SURVIA に戻します（SURVIA の写真台帳で確かめてから調査報告書の境界標へ入ります）。

## 動作の要点

- 利用 URL は常に `http://localhost:5178/`。5178 が土地写真台帳以外に使われていれば、明示エラーで止まります。
- 土地写真台帳かどうかは `index.html` の `<meta name="app-id" content="photo-log-land">` で確かめます。
- `node_modules` が `package-lock.json` より古ければ build の前に `npm install`、`dist` が build 入力より新しければ build を省きます。
- server は `vite preview --host localhost --port 5178 --strictPort` を `node` から直接起動し、状態は `%LOCALAPPDATA%\photo-log-land-launcher\state.json` に残します。
- 設定（標識リストなど）と PC内AI のモデルはブラウザの場所ごとに保存されます。GitHub Pages で使っていた場合は、`http://localhost:5178/` で最初に1回だけ入れ直してください。
