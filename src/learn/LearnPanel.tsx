// 学習フォルダの選択と、ためた正解写真の枚数（種類ごと）

import { GraduationCap } from 'lucide-react';
import type { LearnFolder } from './useLearnFolder';

export function LearnPanel({ learn }: { learn: LearnFolder }) {
  if (!learn.supported) return null;
  const total = learn.counts?.reduce((s, c) => s + c.count, 0) ?? 0;
  return (
    <div className="bg-white p-5 rounded-2xl border shadow-sm space-y-3" data-testid="learn-panel">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-black text-slate-400 uppercase flex items-center gap-2">
          <GraduationCap size={14} />学習データ
        </h2>
        <div className="flex items-center gap-2">
          {learn.folderName && (
            <span className="text-xs font-bold text-slate-600 truncate max-w-48" title="印刷・SURVIAへ戻す時に、標識が決まった近景写真をここへためます">
              {learn.folderName}{learn.counts ? `（${total}枚）` : ''}
            </span>
          )}
          <button onClick={() => void learn.choose()} className="border border-slate-200 text-slate-600 px-3 py-1 rounded-lg text-xs font-bold hover:border-blue-300" data-testid="learn-choose">
            {learn.folderName ? '変更' : 'フォルダを選ぶ'}
          </button>
          {learn.folderName && (
            <button onClick={() => void learn.forget()} className="text-slate-400 text-xs font-bold hover:text-red-500" title="ためるのをやめます（写真は消しません）">解除</button>
          )}
        </div>
      </div>
      {learn.counts && learn.counts.length > 0 && (
        <div className="flex flex-wrap gap-1" data-testid="learn-counts">
          {learn.counts.map(c => (
            <span key={c.label} className="px-2 py-0.5 bg-slate-100 border rounded text-xs font-bold" title={c.wrong ? `AIが外れた写真 ${c.wrong}枚` : undefined}>
              {c.label} {c.count}{c.wrong ? <span className="text-amber-600">（{c.wrong}）</span> : null}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
