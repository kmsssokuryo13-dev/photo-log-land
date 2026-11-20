// 学習データ（正解写真）の組み立て。純粋関数のみ（ブラウザAPIに依存しない）
// 台帳で標識が決まった近景写真を「正解」として学習フォルダへためるための記録を作る。
// AI が外れて手で直した写真には aiWrong を付け、学習側で優先して使えるようにする。

import type { OnnxPrediction } from '../ai/useOnnxModels';

/** 正解にしない標識（写真に標識が写っていない・まだ決まっていない） */
export const NOT_A_LABEL = ['未設定', '計算点'];

/**
 * 既定の標識名 → 学習フォルダ名（英数字。Windows の学習ツールが日本語のパスで読めないことがあるため）。
 * boundary_v03 のクラス名にそろえる。モデルを使っていてもいなくても、同じ標識は同じフォルダにする。
 */
export const DEFAULT_CLASS_KEYS: Record<string, string> = {
  '金属鋲': 'metal_pin',
  '金属標': 'metal_marker',
  'プラスチック杭': 'plastic_stake',
  'コンクリート角': 'concrete_corner',
  'コンクリート杭': 'concrete_stake',
  '木杭': 'wood_stake',
  '刻印': 'engraved_mark',
  '真鍮標識': 'brass_marker',
  'マンホール中心': 'manhole_center',
};

/** 標識名から学習フォルダ名を決める。既定 → 使用中モデルのクラス名 → 文字コード（同じ名前なら毎回同じ）の順 */
export function classKeyFor(label: string, modelDisplayNames: Record<string, string> = {}): string {
  if (DEFAULT_CLASS_KEYS[label]) return DEFAULT_CLASS_KEYS[label];
  const fromModel = Object.entries(modelDisplayNames).find(([, v]) => v === label)?.[0];
  if (fromModel && /^[A-Za-z0-9_-]+$/.test(fromModel)) return fromModel;
  const hex = Array.from(label.normalize('NFKC')).map(c => c.codePointAt(0)!.toString(16)).join('');
  return `mark_${hex}`.slice(0, 60);
}

export type LabelSource = 'manual' | 'ai' | 'survia';

/** 学習フォルダの samples.json の1件 */
export interface LearnRecord {
  sha256: string;
  label: string; // 標識名（画面の名前）
  classKey: string; // 学習フォルダ名
  path: string; // 学習フォルダからの相対パス（classKey/ファイル名）
  caseKey: string; // 案件の目印（試験用と学習用を案件ごとに分けるため）
  siteName: string;
  pointName: string;
  direction: number;
  photoDate: string; // YYYY-MM-DD（ファイルの更新日時）
  savedAt: string;
  updatedAt: string;
  source: LabelSource; // 手で選んだ・AI が入れたまま・SURVIA から
  ai: { model: string; top: string; score: number } | null; // 保存した時の使用中モデルの1位
  aiWrong: boolean; // AI の1位が正解と違った（直した写真）
}

export interface LearnIndex {
  schema_version: 1;
  samples: Record<string, LearnRecord>; // sha256 → 記録
}

export function emptyIndex(): LearnIndex {
  return { schema_version: 1, samples: {} };
}

export function parseIndex(text: string | null): LearnIndex {
  if (!text) return emptyIndex();
  try {
    const v = JSON.parse(text) as Partial<LearnIndex>;
    if (v && v.schema_version === 1 && v.samples && typeof v.samples === 'object') return { schema_version: 1, samples: v.samples };
  } catch { /* 壊れていれば作り直す（写真は残っている） */ }
  return emptyIndex();
}

interface FileLike {
  id: string;
  viewType: string;
  modifiedMs?: number;
  onnx?: OnnxPrediction;
}

interface PointLike {
  pointName: string;
  markType: string;
  markSource?: 'ai';
  fromSurvia?: boolean;
  directions: Record<number, Partial<Record<string, FileLike>>>;
}

/** これから保存する1枚（写真の中身は呼び出し側が持つ） */
export interface LearnCandidate {
  fileId: string;
  label: string;
  pointName: string;
  direction: number;
  photoDate: string;
  source: LabelSource;
  ai: LearnRecord['ai'];
  aiWrong: boolean;
}

function ymd(ms: number | undefined): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 正解にできる近景写真を選ぶ。標識が決まっている点の、すべての方向の近景。
 * 未設定・計算点・標識リストに無い名前は入れない。元写真が無い写真（開き直して消えたもの）も入れない。
 */
export function collectCandidates(points: PointLike[], markTypes: string[], hasOriginal: (fileId: string) => boolean): LearnCandidate[] {
  const out: LearnCandidate[] = [];
  for (const p of points) {
    const label = p.markType;
    if (NOT_A_LABEL.includes(label) || !markTypes.includes(label)) continue;
    const source: LabelSource = p.markSource === 'ai' ? 'ai' : p.fromSurvia ? 'survia' : 'manual';
    for (const [dir, views] of Object.entries(p.directions)) {
      const fd = views.close;
      if (!fd || fd.viewType !== 'close' || !hasOriginal(fd.id)) continue;
      const pr = fd.onnx;
      const top = pr?.status === 'ok' ? pr.candidates[0] : undefined;
      const ai = pr?.status === 'ok' && top ? { model: pr.modelLabel, top: top.label, score: Math.round(top.score * 1000) / 1000 } : null;
      out.push({
        fileId: fd.id, label, pointName: p.pointName, direction: Number(dir), photoDate: ymd(fd.modifiedMs),
        source, ai, aiWrong: !!ai && ai.top !== label,
      });
    }
  }
  return out;
}

/** 案件の目印。現場名＋最初の撮影月（同じ現場を別の月に撮り直しても別案件として扱う） */
export function caseKeyOf(siteName: string, candidates: LearnCandidate[]): string {
  const months = candidates.map(c => c.photoDate.slice(0, 7)).filter(Boolean).sort();
  return `${siteName.trim() || '現場名なし'}|${months[0] ?? ''}`;
}

export function fileNameFor(sha256: string, ext: string): string {
  const e = /^\.[A-Za-z0-9]{1,5}$/.test(ext) ? ext.toLowerCase() : '.jpg';
  return `${sha256.slice(0, 16)}${e}`;
}

export type Plan =
  | { kind: 'new'; record: LearnRecord }
  | { kind: 'relabel'; record: LearnRecord; oldPath: string } // 標識を直した → 別のフォルダへ移す
  | { kind: 'update'; record: LearnRecord } // 同じ標識。記録だけ新しくする（AIの結果など）
  | { kind: 'same' };

/** 1枚をどう保存するか決める（同じ写真は中身の SHA-256 で見分け、2回入れない） */
export function planSample(index: LearnIndex, c: LearnCandidate, sha256: string, ext: string, ctx: {
  caseKey: string; siteName: string; now: string; modelDisplayNames?: Record<string, string>;
}): Plan {
  const classKey = classKeyFor(c.label, ctx.modelDisplayNames);
  const prev = index.samples[sha256];
  const path = `${classKey}/${fileNameFor(sha256, ext)}`;
  // 一度「AIが外れた」と記録した写真は、その後も外れ扱いのまま（直した後は AI の1位が合うことがあるため）
  const aiWrong = c.aiWrong || (!!prev && prev.label === c.label && prev.aiWrong);
  const record: LearnRecord = {
    sha256, label: c.label, classKey, path,
    caseKey: prev?.caseKey ?? ctx.caseKey, siteName: prev?.siteName ?? ctx.siteName,
    pointName: c.pointName, direction: c.direction, photoDate: c.photoDate,
    savedAt: prev?.savedAt ?? ctx.now, updatedAt: ctx.now,
    // 手で選んだ記録は、後で AI のままの記録で上書きしない
    source: prev && prev.label === c.label && prev.source !== 'ai' && c.source === 'ai' ? prev.source : c.source,
    ai: c.ai ?? prev?.ai ?? null, aiWrong,
  };
  if (!prev) return { kind: 'new', record };
  if (prev.path !== path) return { kind: 'relabel', record, oldPath: prev.path };
  const same = prev.label === record.label && prev.source === record.source && prev.aiWrong === record.aiWrong
    && JSON.stringify(prev.ai) === JSON.stringify(record.ai) && prev.pointName === record.pointName;
  return same ? { kind: 'same' } : { kind: 'update', record: { ...record, updatedAt: ctx.now } };
}

/** 種類ごとの枚数（画面に出す） */
export function countByLabel(index: LearnIndex): { label: string; count: number; wrong: number }[] {
  const m = new Map<string, { count: number; wrong: number }>();
  for (const r of Object.values(index.samples)) {
    const e = m.get(r.label) ?? { count: 0, wrong: 0 };
    e.count++;
    if (r.aiWrong) e.wrong++;
    m.set(r.label, e);
  }
  return [...m.entries()].map(([label, v]) => ({ label, ...v })).sort((a, b) => b.count - a.count);
}
