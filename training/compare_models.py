"""固定の試験写真で今のモデルと新しいモデルを比べ、採用してよいか判定する。

使い方（PowerShell）:
    python compare_models.py --inbox C:\\BoundaryMarkerAI\\inbox ^
        --old C:\\BoundaryMarkerAI\\models\\boundary_v03 --new C:\\BoundaryMarkerAI\\models\\boundary_v04

--old / --new は .onnx と model_config.json が入ったフォルダ。前処理は写真台帳アプリと同じ
（EXIF の向き補正・RGB・114 の灰色で中央に正方形パディング・入力サイズへ縮小・0〜1）。

採用の条件（2026-11-20 推奨案「どの種類も下がらない時だけ」）:
- 全体の正解率（両方が知っている種類）が今のモデルより上がる。同じなら、新しいモデルが判別できる種類が増えた時だけ
- どの種類の正解率も今のモデル以上（--allow-drop で 1種類あたりの下がりを許す幅を指定できる。既定 0）
- 今のモデルに無い種類は比べない（新しい種類は正解率を表示するだけ）

結果は画面と --new フォルダの compare_report.json に書く。採用なら終了コード 0、見送りなら 2。
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps


def load_config(folder: Path) -> dict:
    raw = json.loads((folder / "model_config.json").read_text(encoding="utf-8"))
    get = lambda *ks, default=None: next((raw[k] for k in ks if k in raw), default)  # noqa: E731
    inp = get("input", default={}) or {}
    size = inp.get("size")
    w = inp.get("width", size or 640)
    h = inp.get("height", size or 640)
    pre = get("preprocess", "preprocessing", default={}) or {}
    classes = get("classes", "names")
    if isinstance(classes, dict):
        classes = [classes[k] for k in sorted(classes, key=int)]
    names = get("display_names", "displayNames", "classToAppValue", "class_to_app_value", default={}) or {}
    scale = pre.get("scale")
    if scale is None:
        scale = {"0_to_1": 255, "0_to_255": 1}.get(pre.get("pixelScale", "0_to_1"), 255)
    out = get("output", default={}) or {}
    return {
        "width": int(w), "height": int(h),
        "letterbox": pre.get("letterbox", True),
        "pad": tuple(pre.get("pad_color", pre.get("padColor", [114, 114, 114]))),
        "pad_pos": pre.get("pad_position", pre.get("padPosition", "center")),
        "bgr": str(pre.get("channel_order", pre.get("channelOrder", "RGB"))).upper() == "BGR",
        "scale": float(scale),
        "mean": np.array(pre.get("mean", [0, 0, 0]), dtype=np.float32),
        "std": np.array(pre.get("std", [1, 1, 1]), dtype=np.float32),
        "exif": pre.get("exif_transpose", pre.get("exifTranspose", True)),
        "classes": list(classes),
        "labels": [names.get(c, c) for c in classes],
        "logits": (out.get("type") == "logits"),
        "output": out.get("name"),
        "input": inp.get("name"),
    }


def preprocess(path: Path, cfg: dict) -> np.ndarray:
    im = Image.open(path)
    if cfg["exif"]:
        im = ImageOps.exif_transpose(im)
    im = im.convert("RGB")
    if cfg["letterbox"]:
        side = max(im.size)
        sq = Image.new("RGB", (side, side), cfg["pad"])
        off = ((side - im.width) // 2, (side - im.height) // 2) if cfg["pad_pos"] == "center" else (0, 0)
        sq.paste(im, off)
        im = sq
    im = im.resize((cfg["width"], cfg["height"]), Image.BILINEAR)
    a = np.asarray(im, dtype=np.float32)
    if cfg["bgr"]:
        a = a[..., ::-1]
    a = (a / cfg["scale"] - cfg["mean"]) / cfg["std"]
    return a.transpose(2, 0, 1)[None].astype(np.float32)


class Model:
    def __init__(self, folder: Path):
        import onnxruntime as ort
        onnx = next(folder.glob("*.onnx"), None)
        if onnx is None:
            raise SystemExit(f"{folder} に .onnx がありません")
        self.cfg = load_config(folder)
        self.sess = ort.InferenceSession(str(onnx), providers=["CPUExecutionProvider"])
        self.inp = self.cfg["input"] or self.sess.get_inputs()[0].name
        self.out = self.cfg["output"] or self.sess.get_outputs()[0].name
        self.name = folder.name

    def predict(self, path: Path) -> str:
        y = self.sess.run([self.out], {self.inp: preprocess(path, self.cfg)})[0].reshape(-1)
        if self.cfg["logits"]:
            y = np.exp(y - y.max())
            y = y / y.sum()
        return self.cfg["labels"][int(np.argmax(y))]


def load_test(inbox: Path) -> list[tuple[Path, str]]:
    test = json.loads((inbox / "test_set.json").read_text(encoding="utf-8"))["classes"]
    samples = json.loads((inbox / "samples.json").read_text(encoding="utf-8"))["samples"]
    out = []
    for shas in test.values():
        for s in shas:
            r = samples.get(s)
            if r and (inbox / r["path"]).is_file():
                out.append((inbox / r["path"], r["label"]))  # 正解は今の標識名（後で直した分も反映）
    return out


def score(model: Model, test: list[tuple[Path, str]]) -> dict:
    per = defaultdict(lambda: [0, 0])
    for path, label in test:
        per[label][1] += 1
        if model.predict(path) == label:
            per[label][0] += 1
    known = set(model.cfg["labels"])
    total_ok = sum(v[0] for k, v in per.items() if k in known)
    total_n = sum(v[1] for k, v in per.items() if k in known)
    return {
        "classes": {k: {"correct": v[0], "n": v[1], "acc": v[0] / v[1]} for k, v in sorted(per.items())},
        "known": sorted(known),
        "acc": total_ok / total_n if total_n else 0.0,
    }


def decide(old: dict, new: dict, allow_drop: float) -> tuple[bool, list[str]]:
    reasons = []
    common = [k for k in old["classes"] if k in old["known"] and k in new["known"]]
    def acc(s, ks):
        n = sum(s["classes"][k]["n"] for k in ks)
        return sum(s["classes"][k]["correct"] for k in ks) / n if n else 0.0
    o, nw = acc(old, common), acc(new, common)
    more = len(set(new["known"]) - set(old["known"])) > 0
    if nw < o or (nw == o and not more):
        reasons.append(f"全体 {o:.1%} → {nw:.1%}（上がっていない）")
    for k in common:
        a, b = old["classes"][k]["acc"], new["classes"][k]["acc"]
        if b < a - allow_drop - 1e-9:
            reasons.append(f"{k} {a:.1%} → {b:.1%}（下がった）")
    return (not reasons), reasons


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--inbox", type=Path, required=True)
    ap.add_argument("--old", type=Path, required=True)
    ap.add_argument("--new", type=Path, required=True)
    ap.add_argument("--allow-drop", type=float, default=0.0, help="1種類あたり許す下がり（0.05 = 5ポイント）")
    a = ap.parse_args(argv)

    test = load_test(a.inbox)
    if not test:
        print("試験用の写真がありません。先に make_dataset.py を実行してください", file=sys.stderr)
        return 1
    old, new = Model(a.old), Model(a.new)
    so, sn = score(old, test), score(new, test)
    ok, reasons = decide(so, sn, a.allow_drop)

    print(f"試験写真 {len(test)} 枚")
    print(f"{'種類':<14}{old.name:>14}{new.name:>14}")
    for k in sorted(set(so["classes"]) | set(sn["classes"])):
        f = lambda s: (f"{s['classes'][k]['correct']}/{s['classes'][k]['n']} {s['classes'][k]['acc']:.0%}" if k in s["known"] else "—")  # noqa: E731
        print(f"{k:<14}{f(so):>14}{f(sn):>14}")
    print(f"{'全体':<14}{so['acc']:>14.1%}{sn['acc']:>14.1%}")
    print("→ 採用してよい" if ok else "→ 見送り: " + " / ".join(reasons))
    (a.new / "compare_report.json").write_text(json.dumps(
        {"old": old.name, "new": new.name, "adopt": ok, "reasons": reasons, "old_score": so, "new_score": sn, "test_images": len(test)},
        ensure_ascii=False, indent=1), encoding="utf-8")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
