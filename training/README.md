# 使うほど賢くする（学習データ・新旧モデルの比較）

写真や学習済みモデルはこのリポジトリに入れません。ここにあるのは PC で動かすスクリプトだけです。

## 流れ

1. **ためる（アプリ）**：「読込」タブの「学習データ」でフォルダを選ぶ（例 `C:\BoundaryMarkerAI\inbox`）。アプリを開き直した後は、最初の印刷・戻しの時か「許可」ボタンで書き込みを許可します。
   以後、プレビューの「印刷画面を開く」と「SURVIAへ戻す」のたびに、標識が決まった近景写真（全方向）をそのフォルダへ保存します。
   - 種類ごとのフォルダ（`metal_pin\` など boundary_v03 と同じ英字）へ元の写真をそのまま。同じ写真は2回入れません。標識を直せばフォルダを移します。
   - `samples.json` に、標識・案件・点名・入れ方（手・AI・SURVIA）・その時のAIの1位と「AIが外れたか」を記録します。
   - 未設定・計算点・標識リストに無い名前は入れません。
2. **データセットを作る**：`python make_dataset.py --inbox C:\BoundaryMarkerAI\inbox --out C:\BoundaryMarkerAI\datasets\v04`
   - 試験用の写真を種類ごとに固定（`inbox\test_set.json`、既定20枚・種類の3分の1まで）。一度決めたら変えず、学習には使いません。試験には人が決めた標識（手・SURVIA・AIを直した写真）だけを使います。
   - 学習に使う枚数を種類ごとにそろえます：上限 = 一番少ない種類の3倍（`--ratio`）。上限を超える種類（金属鋲など）は、AIが外れた写真を先に、残りは案件を順に回して選びます。写真そのものは消しません。
   - AIが入れたまま（人が直していない）標識の写真は学習に使いません（AIの間違いを学び直さないため。`--use-ai-labels` で使う）。
   - 30枚（`--min-per-class`）に届かない種類は入れず、届いた時に自動で入ります。
   - `train\ val\ test\`（種類ごとのフォルダ）、`class_weights.json`（少ない種類ほど重い）、`dataset_report.json` を書きます。
3. **学習**：今までどおり `C:\BoundaryMarkerAI` で `train\ val\` を使って学習し、`models\boundary_vNN\`（.onnx と model_config.json）へ書き出します。重み付けに対応した学習なら `class_weights.json` を使います。
4. **比べる**：`python compare_models.py --inbox C:\BoundaryMarkerAI\inbox --old ...\models\boundary_v03 --new ...\models\boundary_v04`
   - 固定の試験写真で、種類ごとの正解率を並べて出します。
   - 採用してよいのは、全体の正解率が上がり、どの種類の正解率も今のモデル以上の時だけ（同じ全体正解率なら、判別できる種類が増えた時だけ）。見送りなら理由を出します。
5. **入れる（アプリ）**：採用してよい時だけ、アプリの「PC内AI」→「モデル追加」で新しいモデルを登録します。前のモデルは残り、いつでも戻せます。

## 必要なもの

Python 3.10 以上、`pip install pillow numpy onnxruntime`。
