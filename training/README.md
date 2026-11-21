# 使うほど賢くする（学習データ・新旧モデルの比較）

写真や学習済みモデルはこのリポジトリに入れません。ここにあるのは PC で動かすスクリプトだけです。

## 流れ

1. **ためる（アプリ）**：「読込」タブの「学習データ」でフォルダを選ぶ（例 `C:\BoundaryMarkerAI\inbox`）。アプリを開き直した後は、最初の印刷・戻しの時か「許可」ボタンで書き込みを許可します。
   以後、プレビューの「印刷画面を開く」と「SURVIAへ戻す」のたびに、標識が決まった近景写真（全方向）をそのフォルダへ保存します。
   - 種類ごとのフォルダ（`metal_pin\` など boundary_v03 と同じ英字）へ元の写真をそのまま。同じ写真は2回入れません。標識を直せばフォルダを移します。
   - `samples.json` に、標識・案件・点名・入れ方（手・AI・SURVIA）・その時のAIの1位と「AIが外れたか」を記録します。
   - 未設定・計算点・標識リストに無い名前は入れません。
2. **データセットを作る**（`C:\BoundaryMarkerAI` で、`.venv\Scripts\python.exe` を使う）:
   ```
   python make_dataset.py --inbox C:\BoundaryMarkerAI\inbox --out C:\BoundaryMarkerAI\dataset_v05 ^
     --raw C:\BoundaryMarkerAI\dataset\raw --fixed-test C:\BoundaryMarkerAI\dataset_v03\test
   ```
   - `--raw`：これまで手で仕分けた写真（`dataset\raw\<種類>\A001_点名近景.jpg`）も一緒に使います。`no_marker`・`_unclassified` は写真台帳の標識に無いので使いません。
   - `--fixed-test`：初回だけ、今までの固定試験写真（v0.2 から同じ 55 枚）をそのまま試験に入れます。その案件（A002・A008・A014・A027）は今までどおり学習に使いません。以後は `inbox\test_set.json` に固定され、アプリでためた写真から種類ごとに 20 枚（種類の3分の1まで）を足していきます。今までの raw 写真は試験に足しません（今までのモデルが学習に使っているため）。
   - 学習に使う枚数を種類ごとにそろえます：上限 = 一番少ない種類の3倍（`--ratio`）。上限を超える種類（金属鋲など）は、AIが外れた写真を先に、残りは案件を順に回して選びます。写真そのものは消しません。
   - AIが入れたまま（人が直していない）標識の写真は学習に使いません（AIの間違いを学び直さないため。`--use-ai-labels` で使う）。
   - 30枚（`--min-per-class`）に届かない種類は入れず、届いた時に自動で入ります。
   - `train\ val\ test\`（種類ごとのフォルダ）、`class_weights.json`（少ない種類ほど重い）、`class_labels.json`、`dataset_report.json` を書きます。
3. **学習**：`train_boundary_v04_FIXED.py` を `train_boundary_v05.py` に写し、`DATASET_DIR = ROOT / "dataset_v05"`・`RUN_NAME = "boundary_v05"` に変えて実行します（v0.4 と同じく、少ない種類を重くする損失）。続けて `export_boundary_v03_onnx.py` を写して v03 を v05 に変え、`models\boundary_v05\`（.onnx と model_config.json）へ書き出します。
4. **比べる**：
   ```
   python compare_models.py --dataset C:\BoundaryMarkerAI\dataset_v05 ^
     --old C:\BoundaryMarkerAI\models\boundary_v03 --new C:\BoundaryMarkerAI\models\boundary_v05
   ```
   - 固定の試験写真で、種類ごとの正解率を並べて出します（今の v03 は 55 枚で 90.9%。学習時の評価と同じ値になることを 2026-11-20 に確かめました）。
   - 採用してよいのは、全体の正解率が上がり、どの種類の正解率も今のモデルから 2 ポイントより下がらない時だけ（2026-11-20 ユーザー選択）。全体が同じなら、判別できる種類が増えた時だけ。見送りなら理由を出します。
5. **入れる（アプリ）**：採用してよい時だけ、アプリの「PC内AI」→「モデル追加」で新しいモデルを登録します。前のモデルは残り、いつでも戻せます。

ラベルの決まり（`docs\LABEL_POLICY.txt`）：プラスチック杭・木杭の上に金属鋲・金属標があるときは、杭（母体）の種類を選びます。台帳で標識を選ぶときも同じにします。

## 必要なもの

Python 3.10 以上、`pip install pillow numpy onnxruntime`。
