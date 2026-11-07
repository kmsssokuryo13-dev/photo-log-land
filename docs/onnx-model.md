# PC内AI（ONNX画像分類）

近景写真の境界標識の種類を、PCのブラウザ内（CPU / WASM）で推論して候補と確信度を表示し、確信度が高ければ標識を自動入力する機能です。

- 推論は読込時、**圧縮前の元写真** に対して行います（近景のみ。遠景・中景・マクロは判別しません）。
- AIが使えない・失敗した場合も、写真登録・並べ替え・PDF出力はそのまま使えます（手動運用）。
- Gemini 判別（✨ボタン・一括AI判別・APIキー欄）は廃止しました。

## 自動入力

`model_config.json` に `auto_fill_confidence`（例 `0.9`）があるモデルだけ、次の条件で標識プルダウンに自動入力します。書いていないモデルは候補表示のみです。

- 標識が「未設定」の点だけ（手で選んだ標識・SURVIA から受け取った標識は変えません。SURVIA が優先）
- 表示中の方向の近景写真の1位候補が `auto_fill_confidence` 以上（`min_confidence` 未満は入れません）
- 1位候補が標識リストにあり、計算点でない（リスト外・計算点は候補表示のみ）
- 自動入力した点はプルダウンが緑になり、左の一覧に `AI` が付きます。手で選び直すと印は消えます
- 「再判別」やモデル切替後の再判別では、AIが入れた点（手で変えていない点）だけ入れ直します。しきい値未満になれば「未設定」に戻します

## 使い方

1. 「読込」タブの **PC内AI** で「モデル追加」を押し、`*.onnx` と `model_config.json` を **一緒に** 選びます。
2. 検証に通ると、そのモデルが使用中になります。前のモデルは一覧に残ります。
3. 写真を読み込むと、編集タブの標識プルダウンの右に `AI 金属鋲 92%` のように表示されます（マウスを乗せると上位候補とモデル版）。
4. モデルを切り替えたら「再判別」で、読込済みの近景写真をそのモデルで判別し直せます。

## モデルの保存場所と新旧管理

- モデルはリポジトリにもサーバーにも置きません。PCのファイルから選び、**そのブラウザの IndexedDB** に版ごと保存します。
- 版（`model_name` + `model_version`）ごとに別レコードで保持し、ラジオボタンで使用中を切り替えます（ロールバック）。
- 新しいモデルは次の互換性検証に通った場合だけ登録・使用中になります。失敗した場合は登録せず、今のモデルを使い続けます。
  1. `model_config.json` の形式チェック
  2. モデルの読込（破損・形式違いの検出）
  3. 入力名・出力名がモデルにあるか
  4. 設定の入力サイズで試行推論できるか
  5. 出力数がクラス数と一致し、数値が正常か
- 使用中のモデルとクラス構成・入力サイズが違う場合は「クラス変更」と表示します（詳細はツールチップ）。
- 起動時に使用中モデルが読めない場合は赤い点が付き、AIなしで動きます。

## model_config.json

```json
{
  "schema_version": 1,
  "model_name": "boundary-mark",
  "model_version": "2026.11.01",
  "task": "classify",
  "input": { "name": "images", "width": 640, "height": 640, "layout": "NCHW", "dtype": "float32" },
  "preprocess": {
    "exif_transpose": true,
    "letterbox": true,
    "pad_color": [114, 114, 114],
    "pad_position": "center",
    "channel_order": "RGB",
    "scale": 255,
    "mean": [0, 0, 0],
    "std": [1, 1, 1]
  },
  "output": { "name": "output0", "type": "probabilities" },
  "classes": ["metal_tack", "concrete_post", "calc_point"],
  "display_names": { "metal_tack": "金属鋲", "concrete_post": "コンクリート杭", "calc_point": "計算点" },
  "top_k": 3,
  "min_confidence": 0.5,
  "auto_fill_confidence": 0.9
}
```

| 項目 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `model_version` | ○ | | 版。同じ `model_name` で同じ版は登録できません |
| `classes` | ○ | | 出力順のクラス名。Ultralytics 形式 `names: {"0": "...", ...}` も可 |
| `model_name` | | `model` | |
| `input.name` / `output.name` | | 先頭の入出力 | |
| `input.width` / `input.height` | | 640 | `input.size` で正方形指定も可 |
| `preprocess.exif_transpose` | | true | EXIFの回転情報で向きを補正 |
| `preprocess.letterbox` | | true | true: 全画像を残して正方形にパディング後リサイズ / false: 縦横比を無視してリサイズ |
| `preprocess.pad_color` | | [114,114,114] | |
| `preprocess.pad_position` | | center | center（Pillow の `(s-w)//2` と同じ）/ top-left |
| `preprocess.channel_order` | | RGB | RGB / BGR |
| `preprocess.scale` / `mean` / `std` | | 255 / 0 / 1 | `(画素/scale - mean) / std`。既定で 0〜1 |
| `output.type` | | probabilities | probabilities（softmax済み）/ logits（アプリで softmax） |
| `display_names` | | | クラス名 → 表示名。標識リストの名称に合わせると緑、リスト外は橙で表示 |
| `top_k` | | 3 | ツールチップに出す候補数 |
| `min_confidence` | | 0 | これ未満は `AI ?`（参考外）表示 |
| `auto_fill_confidence` | | なし | これ以上なら「未設定」の標識へ自動入力（0より大きく1以下）。なしは自動入力しない |

対応しているのは分類モデル（出力 `[1, クラス数]` の float32）のみです。入力は NCHW float32 `[1, 3, H, W]`。

## 前処理（学習時の再現）

1. EXIF回転補正（`createImageBitmap(..., { imageOrientation: 'from-image' })`）
2. RGB化（埋め込みICCによる色変換はしない）
3. 一辺 `max(w, h)` の正方形の中央に貼り付け、余白は RGB(114,114,114)
4. 640×640 へリサイズ（ブラウザの高品質補間）
5. NCHW float32、`画素 / 255` で 0〜1

Pillow（`ImageOps.exif_transpose` → `convert('RGB')` → パディング → `resize`）との比較で、EXIF回転6の画像で平均差 約0.2/255 でした。
リサイズの補間方式はブラウザと Pillow で完全には一致しないため、境界付近で最大 1 割程度の差が出ることがあります。

## 外部通信

onnxruntime-web の WASM はビルド成果物（`assets/ort-wasm-simd-threaded-*.wasm`）に同梱し、CDN からは取得しません。
GitHub Pages はクロスオリジン分離できないため、単一スレッドで動かします。

## コミットしないもの

`*.onnx`、`models/`、`private/` は `.gitignore` 済みです。モデル本体・実務写真はリポジトリに入れないでください。
