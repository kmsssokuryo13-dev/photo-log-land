"""学習フォルダにためた正解写真から、偏りを抑えた学習用データセットを作る。

使い方（PowerShell）:
    python make_dataset.py --inbox C:\\BoundaryMarkerAI\\inbox --out C:\\BoundaryMarkerAI\\datasets\\next

inbox は写真台帳アプリの「学習データ」で選んだフォルダ（samples.json と種類ごとのフォルダがある）。

やること:
1. 試験用の写真を種類ごとに固定する（inbox\\test_set.json。一度決めたら変えない。増えた種類だけ足す）。
   試験用には手で選んだ・SURVIA から来た・AI が外れて直した写真だけを使い、試験に使った点（同じ案件の同じ点）は学習に使わない。
2. 学習に使う枚数を種類ごとにそろえる（上限 = 一番少ない種類の --ratio 倍、かつ --max-per-class まで）。
   上限を超える種類は、AI が外れた写真を先に入れ、残りは案件を順番に回して選ぶ（同じ案件ばかりにしない）。
3. 少ない種類が損をしないよう、種類ごとの重み（class_weights.json）も書く。
4. --min-per-class に届かない種類は学習に入れない（写真はたまり続け、届いた時に入る）。

out には train\\<種類>\\, val\\<種類>\\, test\\<種類>\\ と class_weights.json, dataset_report.json を作る。
写真はコピーする（inbox の写真は動かさない・消さない）。
"""
from __future__ import annotations

import argparse
import json
import random
import shutil
import sys
from collections import defaultdict
from pathlib import Path

TRUSTED_SOURCES = {"manual", "survia"}


def load_samples(inbox: Path) -> list[dict]:
    idx = json.loads((inbox / "samples.json").read_text(encoding="utf-8"))
    out = []
    for sha, r in idx.get("samples", {}).items():
        if (inbox / r["path"]).is_file():
            out.append({**r, "sha256": sha})
    return out


def trusted(r: dict) -> bool:
    """試験に使ってよい正解（人が決めた標識）。AI が入れたままの標識は試験に使わない"""
    return r.get("source") in TRUSTED_SOURCES or bool(r.get("aiWrong"))


def group_of(r: dict) -> str:
    """同じ案件の同じ点の写真（方向違い・撮り直し）はよく似ているので、試験と学習に分けない"""
    return f"{r.get('caseKey', '')}#{r.get('pointName', '')}"


def update_test_set(inbox: Path, samples: list[dict], per_class: int, seed: int) -> dict[str, list[str]]:
    """試験用の写真（sha256）を種類ごとに固定する。既に決めた分は変えず、足りない種類だけ足す。
    点ごとにまとめて選び、種類の写真の3分の1までにとどめる（残りを学習に回すため）。"""
    path = inbox / "test_set.json"
    fixed: dict[str, list[str]] = json.loads(path.read_text(encoding="utf-8"))["classes"] if path.exists() else {}
    by_sha = {r["sha256"]: r for r in samples}
    rng = random.Random(seed)
    by_class: dict[str, list[dict]] = defaultdict(list)
    for r in samples:
        by_class[r["classKey"]].append(r)
    for cls, rows in sorted(by_class.items()):
        have = [s for s in fixed.get(cls, []) if s in by_sha]
        limit = min(per_class, len(rows) // 3)
        if len(have) >= limit:
            if have:
                fixed[cls] = have
            continue
        used_groups = {group_of(by_sha[s]) for s in have}
        groups: dict[str, list[dict]] = defaultdict(list)
        for r in rows:
            if trusted(r) and r["sha256"] not in have:
                groups[group_of(r)].append(r)
        # 既に試験に使った点の残り → ほかの点（ばらばらに）
        order = sorted(groups, key=lambda g: (g not in used_groups, rng.random()))
        for g in order:
            if len(have) + len(groups[g]) > limit and len(have) > 0:
                continue
            have.extend(r["sha256"] for r in groups[g])
            if len(have) >= limit:
                break
        if have:
            fixed[cls] = have
    path.write_text(json.dumps({"schema_version": 1, "classes": fixed}, ensure_ascii=False, indent=1), encoding="utf-8")
    return fixed


def pick_balanced(rows: list[dict], cap: int, seed: int) -> list[dict]:
    """上限 cap 枚まで選ぶ。AI が外れた写真が先、残りは案件を順に回して（新しい写真から）選ぶ"""
    if len(rows) <= cap:
        return rows
    wrong = [r for r in rows if r.get("aiWrong")]
    rest = [r for r in rows if not r.get("aiWrong")]
    picked = sorted(wrong, key=lambda r: r.get("savedAt", ""), reverse=True)[:cap]
    cases = defaultdict(list)
    for r in sorted(rest, key=lambda r: r.get("savedAt", ""), reverse=True):
        cases[r["caseKey"]].append(r)
    order = list(cases)
    random.Random(seed).shuffle(order)
    while len(picked) < cap and any(cases.values()):
        for c in order:
            if cases[c] and len(picked) < cap:
                picked.append(cases[c].pop(0))
    return picked


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--inbox", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--test-per-class", type=int, default=20, help="試験用の枚数（種類ごと）")
    ap.add_argument("--min-per-class", type=int, default=30, help="学習に入れる最低枚数（試験用を除く）")
    ap.add_argument("--ratio", type=float, default=3.0, help="一番少ない種類の何倍まで使うか")
    ap.add_argument("--max-per-class", type=int, default=1500)
    ap.add_argument("--val-ratio", type=float, default=0.15)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args(argv)

    samples = load_samples(a.inbox)
    if not samples:
        print("samples.json に写真がありません", file=sys.stderr)
        return 1
    test = update_test_set(a.inbox, samples, a.test_per_class, a.seed)
    test_shas = {s for v in test.values() for s in v}
    test_groups = {(r["classKey"], group_of(r)) for r in samples if r["sha256"] in test_shas}

    by_class: dict[str, list[dict]] = defaultdict(list)
    labels: dict[str, str] = {}
    for r in samples:
        labels[r["classKey"]] = r["label"]
        if r["sha256"] in test_shas or (r["classKey"], group_of(r)) in test_groups:
            continue  # 試験に使った点は学習に使わない（似た写真で点数が上がって見えるのを防ぐ）
        by_class[r["classKey"]].append(r)

    used = {c: rows for c, rows in by_class.items() if len(rows) >= a.min_per_class}
    skipped = {c: len(rows) for c, rows in by_class.items() if len(rows) < a.min_per_class}
    if len(used) < 2:
        print(f"学習できる種類が2つ未満です（{a.min_per_class}枚以上の種類: {list(used)}）", file=sys.stderr)
        return 1
    smallest = min(len(v) for v in used.values())
    cap = min(a.max_per_class, int(smallest * a.ratio))

    if a.out.exists() and any(a.out.iterdir()):
        print(f"{a.out} は空ではありません。別のフォルダを指定してください", file=sys.stderr)
        return 1
    rng = random.Random(a.seed)
    report = {"cap": cap, "classes": {}, "skipped": skipped}
    for cls, rows in sorted(used.items()):
        picked = pick_balanced(rows, cap, a.seed)
        # 検証用も案件で分ける
        cases = sorted({r["caseKey"] for r in picked})
        rng.shuffle(cases)
        n_val_cases = max(1, round(len(cases) * a.val_ratio)) if len(cases) > 1 else 0
        val_cases = set(cases[:n_val_cases])
        counts = {"train": 0, "val": 0}
        for r in picked:
            split = "val" if r["caseKey"] in val_cases else "train"
            if not val_cases and rng.random() < a.val_ratio:
                split = "val"
            dst = a.out / split / cls / Path(r["path"]).name
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(a.inbox / r["path"], dst)
            counts[split] += 1
        report["classes"][cls] = {"label": labels[cls], "available": len(rows), "aiWrong": sum(1 for r in rows if r.get("aiWrong")), **counts}
    for cls, shas in test.items():
        if cls not in used:
            continue
        by_sha = {r["sha256"]: r for r in samples}
        for s in shas:
            r = by_sha.get(s)
            if r:
                dst = a.out / "test" / cls / Path(r["path"]).name
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(a.inbox / r["path"], dst)
        report["classes"][cls]["test"] = len(shas)

    # 重み: 学習枚数の逆数（平均が1）。多い種類の写真1枚の影響を小さくする
    n = {c: v["train"] for c, v in report["classes"].items() if v["train"]}
    inv = {c: 1.0 / k for c, k in n.items()}
    mean = sum(inv.values()) / len(inv)
    weights = {c: round(w / mean, 4) for c, w in inv.items()}
    (a.out / "class_weights.json").write_text(json.dumps(weights, indent=1), encoding="utf-8")
    (a.out / "class_labels.json").write_text(json.dumps({c: labels[c] for c in used}, ensure_ascii=False, indent=1), encoding="utf-8")
    (a.out / "dataset_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"上限 {cap} 枚/種類")
    for cls, v in report["classes"].items():
        print(f"  {v['label']}({cls}): 学習 {v['train']} / 検証 {v['val']} / 試験 {v.get('test', 0)}（ためた {v['available']}、AI外れ {v['aiWrong']}）")
    for cls, k in skipped.items():
        print(f"  {labels[cls]}({cls}): {k} 枚。{a.min_per_class} 枚までためてから学習に入れます")
    return 0


if __name__ == "__main__":
    sys.exit(main())
