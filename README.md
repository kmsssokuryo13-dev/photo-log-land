# 写真台帳（土地）

土地の境界点写真を登録し、写真台帳としてまとめるWebアプリケーションです。

## 機能

- **境界点管理**: 境界点を追加・削除・名前変更
- **写真登録**: 各境界点に複数の写真をアップロード可能
- **ドラッグ＆ドロップ並べ替え**: 写真の順序を直感的に変更可能
- **写真の回転**: 90度回転に対応
- **PDF出力**: A4用紙に最適化された印刷レイアウトで出力
- **画像圧縮**: アップロード時に自動圧縮（最大1200px、品質80%）
- **PC内AI（ONNX）**: 近景写真の境界標識をブラウザ内で推論し、候補と確信度を表示（標識は手動で選択）。詳しくは [docs/onnx-model.md](docs/onnx-model.md)

## セットアップ

```bash
npm install
npm run dev
```

## ビルド・確認

```bash
npm run build
npm run lint
npm test
```

## 技術スタック

- React + TypeScript
- Vite
- Tailwind CSS v4
- @dnd-kit（ドラッグ＆ドロップ）
- Lucide React（アイコン）
- onnxruntime-web（PC内AI、WASM / CPU）
