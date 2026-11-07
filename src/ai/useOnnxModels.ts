// 登録モデルの管理と推論を画面へ提供するフック。
// どの処理も例外を外へ投げず、失敗時は AI なし（手動運用）で写真台帳作成を続けられるようにする。

import { useCallback, useEffect, useRef, useState } from 'react';
import { diffClasses, parseModelConfig, type ModelConfig } from './modelConfig';
import { openModelStore, type ModelMeta, type ModelStore } from './modelStore';
import { errorText, OnnxClassifier } from './onnxClassifier';
import type { Candidate } from './postprocess';

export type OnnxPrediction =
  | { status: 'ok'; modelId: string; modelLabel: string; candidates: Candidate[]; minConfidence: number; autoFillConfidence: number | null }
  | { status: 'error'; modelId: string; modelLabel: string; message: string };

export type EngineStatus =
  | { kind: 'loading' }
  | { kind: 'none' } // モデル未使用（手動のみ）
  | { kind: 'ready'; modelId: string }
  | { kind: 'error'; message: string }; // 使用中モデルが読めない（手動のみ）

export function modelLabel(config: ModelConfig): string {
  return `${config.modelName} ${config.modelVersion}`;
}

export interface OnnxModels {
  models: ModelMeta[];
  activeId: string | null;
  status: EngineStatus;
  persistent: boolean;
  busy: boolean;
  register(files: File[]): Promise<{ ok: true; meta: ModelMeta } | { ok: false; message: string }>;
  activate(id: string | null): Promise<{ ok: boolean; message?: string }>;
  remove(id: string): Promise<void>;
  /** モデル未使用なら null。失敗しても例外は投げず status:'error' を返す */
  classify(file: Blob): Promise<OnnxPrediction | null>;
  /** いま推論に使っているモデル（自動入力の対象判定用。描画を待たずに最新を返す） */
  currentModelId(): string | null;
}

function readFileText(f: Blob): Promise<string> {
  return f.text();
}

export function useOnnxModels(): OnnxModels {
  const storeRef = useRef<ModelStore | null>(null);
  const classifierRef = useRef<{ id: string; classifier: OnnxClassifier } | null>(null);
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [activeId, setActiveIdState] = useState<string | null>(null);
  const [status, setStatus] = useState<EngineStatus>({ kind: 'loading' });
  const [persistent, setPersistent] = useState(true);
  const [busy, setBusy] = useState(false);
  // 起動時の使用中モデル読込。読込中に来た推論はこれを待つ
  const initRef = useRef<Promise<void> | null>(null);

  const swapClassifier = useCallback((next: { id: string; classifier: OnnxClassifier } | null) => {
    const prev = classifierRef.current;
    classifierRef.current = next;
    if (prev && prev.classifier !== next?.classifier) void prev.classifier.dispose();
  }, []);

  const loadById = useCallback(async (store: ModelStore, id: string, metas: ModelMeta[]): Promise<OnnxClassifier> => {
    const meta = metas.find(m => m.id === id);
    const blob = await store.getModel(id);
    if (!meta || !blob) throw new Error('登録モデルが見つかりません');
    const { classifier } = await OnnxClassifier.load(await blob.arrayBuffer(), meta.config);
    return classifier;
  }, []);

  // 起動時：登録済みモデルと使用中モデルを読み込む
  useEffect(() => {
    let cancelled = false;
    initRef.current = (async () => {
      try {
        const store = await openModelStore();
        if (cancelled) return;
        storeRef.current = store;
        setPersistent(store.persistent);
        const metas = await store.list();
        const id = await store.getActiveId();
        if (cancelled) return;
        setModels(metas);
        setActiveIdState(id);
        if (!id) { setStatus({ kind: 'none' }); return; }
        try {
          const classifier = await loadById(store, id, metas);
          if (cancelled) { void classifier.dispose(); return; }
          swapClassifier({ id, classifier });
          setStatus({ kind: 'ready', modelId: id });
        } catch (e) {
          if (!cancelled) setStatus({ kind: 'error', message: errorText(e) });
        }
      } catch (e) {
        if (!cancelled) setStatus({ kind: 'error', message: errorText(e) });
      }
    })();
    return () => {
      cancelled = true;
      swapClassifier(null);
    };
  }, [loadById, swapClassifier]);

  const register = useCallback<OnnxModels['register']>(async (files) => {
    const store = storeRef.current;
    if (!store) return { ok: false, message: '準備中です' };
    const modelFile = files.find(f => f.name.toLowerCase().endsWith('.onnx'));
    const configFile = files.find(f => f.name.toLowerCase().endsWith('.json'));
    if (!modelFile || !configFile) return { ok: false, message: '.onnx と model_config.json を一緒に選んでください' };
    setBusy(true);
    let loaded: OnnxClassifier | null = null;
    try {
      let rawConfig: unknown;
      try { rawConfig = JSON.parse(await readFileText(configFile)); }
      catch { return { ok: false, message: `${configFile.name} をJSONとして読めません` }; }
      let config: ModelConfig;
      try { config = parseModelConfig(rawConfig); }
      catch (e) { return { ok: false, message: `設定ファイル: ${errorText(e)}` }; }

      const metas = await store.list();
      if (metas.some(m => m.config.modelName === config.modelName && m.config.modelVersion === config.modelVersion)) {
        return { ok: false, message: `${modelLabel(config)} は登録済みです（model_version を変えてください）` };
      }

      const bytes = await modelFile.arrayBuffer();
      let compatibility;
      try {
        ({ classifier: loaded, compatibility } = await OnnxClassifier.load(bytes, config));
      } catch (e) {
        return { ok: false, message: errorText(e) };
      }

      const notes: string[] = [];
      const current = metas.find(m => m.id === classifierRef.current?.id);
      if (current) {
        const { added, removed } = diffClasses(current.config, config);
        if (added.length) notes.push(`追加クラス: ${added.join(', ')}`);
        if (removed.length) notes.push(`削除クラス: ${removed.join(', ')}`);
        if (current.config.input.width !== config.input.width || current.config.input.height !== config.input.height) {
          notes.push(`入力サイズ変更: ${current.config.input.width}×${current.config.input.height} → ${config.input.width}×${config.input.height}`);
        }
      }

      const meta: ModelMeta = {
        id: `${config.modelName}@${config.modelVersion}#${Date.now().toString(36)}`,
        config,
        modelFileName: modelFile.name,
        configFileName: configFile.name,
        sizeBytes: modelFile.size,
        addedAt: new Date().toISOString(),
        validation: { ok: true, checkedAt: new Date().toISOString(), ...compatibility, notes },
      };
      try {
        await store.put({ ...meta, model: new Blob([bytes], { type: 'application/octet-stream' }) });
        await store.setActiveId(meta.id);
      } catch (e) {
        return { ok: false, message: `保存できません: ${errorText(e)}` };
      }
      swapClassifier({ id: meta.id, classifier: loaded });
      loaded = null;
      setModels(await store.list());
      setActiveIdState(meta.id);
      setStatus({ kind: 'ready', modelId: meta.id });
      return { ok: true, meta };
    } catch (e) {
      return { ok: false, message: errorText(e) };
    } finally {
      if (loaded) void loaded.dispose();
      setBusy(false);
    }
  }, [swapClassifier]);

  const activate = useCallback<OnnxModels['activate']>(async (id) => {
    const store = storeRef.current;
    if (!store) return { ok: false, message: '準備中です' };
    setBusy(true);
    try {
      if (id === null) {
        await store.setActiveId(null);
        swapClassifier(null);
        setActiveIdState(null);
        setStatus({ kind: 'none' });
        return { ok: true };
      }
      const metas = await store.list();
      let classifier: OnnxClassifier;
      try {
        classifier = await loadById(store, id, metas);
      } catch (e) {
        // 切替先が使えない場合は現在のモデルを使い続ける
        return { ok: false, message: errorText(e) };
      }
      await store.setActiveId(id);
      swapClassifier({ id, classifier });
      setActiveIdState(id);
      setStatus({ kind: 'ready', modelId: id });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errorText(e) };
    } finally {
      setBusy(false);
    }
  }, [loadById, swapClassifier]);

  const remove = useCallback<OnnxModels['remove']>(async (id) => {
    const store = storeRef.current;
    if (!store) return;
    if ((await store.getActiveId()) === id) {
      await store.setActiveId(null);
      swapClassifier(null);
      setActiveIdState(null);
      setStatus({ kind: 'none' });
    }
    await store.remove(id);
    setModels(await store.list());
  }, [swapClassifier]);

  const classify = useCallback<OnnxModels['classify']>(async (file) => {
    if (!classifierRef.current && initRef.current) await initRef.current.catch(() => undefined);
    const current = classifierRef.current;
    if (!current) return null;
    const label = modelLabel(current.classifier.config);
    try {
      const candidates = await current.classifier.classify(file);
      return { status: 'ok', modelId: current.id, modelLabel: label, candidates, minConfidence: current.classifier.config.minConfidence, autoFillConfidence: current.classifier.config.autoFillConfidence ?? null };
    } catch (e) {
      return { status: 'error', modelId: current.id, modelLabel: label, message: errorText(e) };
    }
  }, []);

  const currentModelId = useCallback(() => classifierRef.current?.id ?? null, []);

  return { models, activeId, status, persistent, busy, register, activate, remove, classify, currentModelId };
}
