// AI候補と確信度の表示のみ（標識の選択は変更しない）

import type { OnnxPrediction } from './useOnnxModels';

function pct(score: number): string {
  return `${Math.round(score * 100)}%`;
}

// 自動確定させない種類（候補は常に参考扱いの色）
const ADVISORY_ONLY = ['計算点'];

export function PredictionBadge({ prediction, markTypes, activeModelId }: { prediction: OnnxPrediction | undefined; markTypes: string[]; activeModelId: string | null }) {
  if (!prediction) return null;
  const stale = prediction.modelId !== activeModelId;

  if (prediction.status === 'error') {
    return (
      <span title={`AI判別できませんでした（手動で選択）\n${prediction.message}\n${prediction.modelLabel}`} className="text-[10px] font-bold text-slate-400 bg-slate-100 border rounded px-1.5 py-0.5 cursor-help">
        AI ×
      </span>
    );
  }

  const top = prediction.candidates[0];
  if (!top) return null;
  const lowConfidence = top.score < prediction.minConfidence;
  const inList = markTypes.includes(top.label) && !ADVISORY_ONLY.includes(top.label);
  const lines = [
    '候補表示のみ。標識は手動で選択してください。',
    ...prediction.candidates.map((c, i) => `${i + 1}. ${c.label} ${pct(c.score)}${markTypes.includes(c.label) ? '' : '（標識リスト外）'}`),
    prediction.modelLabel,
  ];
  if (lowConfidence) lines.splice(1, 0, '確信度が低いため参考外');
  if (stale) lines.splice(1, 0, '旧モデルの結果（「再判別」で更新）');

  return (
    <span
      title={lines.join('\n')}
      data-testid="ai-candidate"
      className={`text-[10px] font-bold border rounded px-1.5 py-0.5 cursor-help whitespace-nowrap ${lowConfidence || stale ? 'text-slate-400 bg-slate-50 border-slate-200' : inList ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-amber-700 bg-amber-50 border-amber-200'}`}
    >
      AI {lowConfidence ? '?' : top.label} {pct(top.score)}
    </span>
  );
}
