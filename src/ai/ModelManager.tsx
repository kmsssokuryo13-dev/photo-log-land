// PC内AIモデルの登録・切替（ロールバック）・削除

import { useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Cpu, Trash2, Upload, RefreshCw } from 'lucide-react';
import { displayNameOf } from './modelConfig';
import type { ModelMeta } from './modelStore';
import { modelLabel, type OnnxModels } from './useOnnxModels';

function describe(m: ModelMeta): string {
  const c = m.config;
  return [
    modelLabel(c),
    `登録: ${new Date(m.addedAt).toLocaleString('ja-JP')}`,
    `ファイル: ${m.modelFileName} / ${m.configFileName}（${(m.sizeBytes / 1024 / 1024).toFixed(1)}MB）`,
    `入力: ${c.input.width}×${c.input.height}`,
    `クラス: ${c.classes.map(x => displayNameOf(c, x)).join(', ')}`,
    ...m.validation.notes,
  ].join('\n');
}

export function ModelManager({ ai, onReclassify, reclassifyCount, reclassifying }: {
  ai: OnnxModels;
  onReclassify: () => void;
  reclassifyCount: number;
  reclassifying: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const handleFiles = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const r = await ai.register(files);
    setMessage(r.ok
      ? { ok: true, text: `${modelLabel(r.meta.config)} を使用中${r.meta.validation.notes.length ? '（クラス変更あり）' : ''}` }
      : { ok: false, text: r.message });
  };

  const handleActivate = async (id: string | null) => {
    const r = await ai.activate(id);
    setMessage(r.ok ? null : { ok: false, text: `切替できません: ${r.message}` });
  };

  const handleRemove = async (m: ModelMeta) => {
    if (!confirm(`${modelLabel(m.config)} を削除しますか？`)) return;
    await ai.remove(m.id);
  };

  const status = ai.status;
  const dot = status.kind === 'ready' ? 'bg-emerald-500' : status.kind === 'error' ? 'bg-red-500' : status.kind === 'loading' ? 'bg-slate-300 animate-pulse' : 'bg-slate-300';
  const statusTip = status.kind === 'ready' ? '近景写真を読込時に判別します（候補表示のみ）'
    : status.kind === 'error' ? `モデルを使えません（手動で選択）: ${status.message}`
    : status.kind === 'loading' ? '準備中'
    : 'AI未使用（手動で選択）';

  return (
    <div className="bg-white p-5 rounded-2xl border shadow-sm space-y-3" data-testid="model-manager">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-black text-slate-400 uppercase flex items-center gap-2" title={statusTip}>
          <Cpu size={14} />PC内AI<span className={`w-2 h-2 rounded-full ${dot}`} data-testid="ai-status" data-status={status.kind}></span>
        </h2>
        <div className="flex gap-1">
          {ai.activeId && reclassifyCount > 0 && (
            <button onClick={onReclassify} disabled={reclassifying || ai.busy} title="読込済みの近景写真を使用中のモデルで判別し直す" className="text-xs font-bold px-2 py-1 rounded-lg border bg-slate-50 hover:bg-slate-100 flex items-center gap-1 disabled:opacity-50">
              <RefreshCw size={12} className={reclassifying ? 'animate-spin' : ''} />再判別
            </button>
          )}
          <button onClick={() => inputRef.current?.click()} disabled={ai.busy || status.kind === 'loading'} title={'モデル(.onnx)と model_config.json を一緒に選択\n検証に通ると使用中になります。前のモデルは残ります'} className="text-xs font-bold px-2 py-1 rounded-lg bg-blue-600 text-white flex items-center gap-1 disabled:opacity-50">
            <Upload size={12} />{ai.busy ? '検証中' : 'モデル追加'}
          </button>
        </div>
        <input ref={inputRef} type="file" multiple accept=".onnx,.json,application/json" className="hidden" onChange={handleFiles} data-testid="model-input" />
      </div>

      {ai.models.length > 0 && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm font-bold text-slate-500 px-2 py-1 rounded hover:bg-slate-50 cursor-pointer">
            <input type="radio" name="onnx-model" checked={ai.activeId === null} onChange={() => handleActivate(null)} disabled={ai.busy} />
            使わない
          </label>
          {ai.models.map(m => (
            <div key={m.id} className={`flex items-center gap-2 px-2 py-1 rounded border text-sm font-bold ${ai.activeId === m.id ? 'border-blue-300 bg-blue-50' : 'border-transparent hover:bg-slate-50'}`} title={describe(m)}>
              <label className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer">
                <input type="radio" name="onnx-model" checked={ai.activeId === m.id} onChange={() => handleActivate(m.id)} disabled={ai.busy} />
                <span className="truncate">{modelLabel(m.config)}</span>
                {m.validation.notes.length > 0 && <span className="text-[10px] text-amber-600 shrink-0">クラス変更</span>}
              </label>
              <button onClick={() => handleRemove(m)} disabled={ai.busy} className="text-slate-300 hover:text-red-500 disabled:opacity-30" title="削除"><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
      )}

      {!ai.persistent && <p className="text-[10px] font-bold text-amber-600" title="ブラウザの保存領域が使えないため、再読込で登録が消えます">一時登録</p>}
      {message && <p className={`text-xs font-bold ${message.ok ? 'text-emerald-600' : 'text-red-600'}`} data-testid="model-message">{message.text}</p>}
    </div>
  );
}
