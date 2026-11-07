// 写真（FileData）へのAI候補の付与と、確信度しきい値での標識の自動入力。

import type { OnnxPrediction } from './useOnnxModels';

/** PC内AIで判別する写真の種類。近景のみ（遠景・中景・マクロは判別しない） */
export const AI_TARGET_VIEW = 'close';

export function isAiTargetView(viewType: string): boolean {
  return viewType === AI_TARGET_VIEW;
}

interface FileLike {
  id: string;
  viewType: string;
  onnx?: OnnxPrediction;
}

interface PointLike<F extends FileLike> {
  directions: Record<number, Partial<Record<string, F>>>;
  selectedDirection: number;
}

/** 指定した写真の AI 候補だけを差し替えた新しい配列を返す（他の項目は同一参照のまま） */
export function applyPrediction<F extends FileLike, P extends PointLike<F>>(
  points: P[],
  fileId: string,
  prediction: OnnxPrediction | undefined,
): P[] {
  let changed = false;
  const next = points.map(p => {
    let pointChanged = false;
    const directions: P['directions'] = {};
    for (const [dir, views] of Object.entries(p.directions)) {
      const newViews: Partial<Record<string, F>> = {};
      for (const [view, fd] of Object.entries(views)) {
        if (fd && fd.id === fileId) {
          newViews[view] = { ...fd, onnx: prediction };
          pointChanged = true;
        } else {
          newViews[view] = fd;
        }
      }
      directions[Number(dir)] = newViews;
    }
    if (!pointChanged) return p;
    changed = true;
    return { ...p, directions };
  });
  return changed ? next : points;
}

/** 点の表示中の方向にある近景写真の AI 候補 */
export function predictionForPoint<F extends FileLike>(point: PointLike<F>): OnnxPrediction | undefined {
  return point.directions[point.selectedDirection]?.[AI_TARGET_VIEW]?.onnx;
}

/** AI 判別の対象となる写真（近景）を列挙する */
export function aiTargetFiles<F extends FileLike>(points: PointLike<F>[]): F[] {
  const out: F[] = [];
  for (const p of points) {
    for (const views of Object.values(p.directions)) {
      const fd = views[AI_TARGET_VIEW];
      if (fd && isAiTargetView(fd.viewType)) out.push(fd);
    }
  }
  return out;
}

// --- 自動入力 ---

/** 自動入力しない種類（候補は表示のみ） */
export const NO_AUTO_FILL = ['計算点'];
export const UNSET_MARK = '未設定';

/**
 * 候補から自動入力してよい標識名。使えなければ null。
 * しきい値（auto_fill_confidence）が設定されたモデルの、使用中モデルの結果で、
 * 1位が標識リストにあり計算点でなく、しきい値（と min_confidence）以上のときだけ。
 */
export function autoFillMark(prediction: OnnxPrediction | undefined, markTypes: string[], activeModelId: string | null): string | null {
  if (!prediction || prediction.status !== 'ok' || prediction.modelId !== activeModelId) return null;
  const threshold = prediction.autoFillConfidence ?? null;
  const top = prediction.candidates[0];
  if (threshold === null || !top) return null;
  if (top.score < threshold || top.score < prediction.minConfidence) return null;
  if (!markTypes.includes(top.label) || NO_AUTO_FILL.includes(top.label)) return null;
  return top.label;
}

interface AutoFillPoint<F extends FileLike> extends PointLike<F> {
  markType: string;
  markSource?: 'ai';
}

/**
 * 「未設定」の点に AI の標識を入れ、印（markSource: 'ai'）を付ける。
 * すでに AI が入れた点（手で変えていない点）は今の結果で入れ直し、使えなければ「未設定」に戻す。
 * 手で選んだ標識・SURVIA から来た標識・計算点には触れない。
 * 判別できなかった写真（status:'error'）も「使えない」扱いで「未設定」に戻す。
 */
export function applyAutoFill<F extends FileLike, P extends AutoFillPoint<F>>(points: P[], markTypes: string[], activeModelId: string | null): P[] {
  let changed = false;
  const next = points.map(p => {
    if (p.markType !== UNSET_MARK && p.markSource !== 'ai') return p;
    const prediction = predictionForPoint(p);
    // 使用中モデルの結果が無い（旧モデルの結果・近景なし）間は、AI が入れた標識もそのまま
    if (p.markSource === 'ai' && prediction?.modelId !== activeModelId) return p;
    const mark = autoFillMark(prediction, markTypes, activeModelId);
    if (mark) {
      if (p.markType === mark && p.markSource === 'ai') return p;
      changed = true;
      return { ...p, markType: mark, markSource: 'ai' as const };
    }
    if (p.markSource !== 'ai') return p;
    changed = true;
    return { ...p, markType: UNSET_MARK, markSource: undefined };
  });
  return changed ? next : points;
}
