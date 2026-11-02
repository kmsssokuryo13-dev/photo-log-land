// 写真（FileData）へのAI候補の付与。標識(markType)などの手動入力には一切触れない。

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
