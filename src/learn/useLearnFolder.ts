// 学習フォルダの状態（選んだフォルダ・種類ごとの枚数）と保存

import { useCallback, useEffect, useRef, useState } from 'react';
import { ensurePermission, folderSupported, forgetFolder, loadFolder, pickFolder, readIndex, saveLearnSamples, type SaveResult } from './learnFolder';
import { countByLabel } from './learnSamples';

type Handle = NonNullable<Awaited<ReturnType<typeof loadFolder>>>;
type Counts = ReturnType<typeof countByLabel>;

export interface LearnFolder {
  supported: boolean;
  folderName: string | null;
  counts: Counts | null; // 許可がまだで読めない間は null
  choose(): Promise<void>;
  forget(): Promise<void>;
  /** ボタンを押した直後に呼ぶ（許可の窓を出せるように）。フォルダ未選択なら何もしない */
  save(args: Parameters<typeof saveLearnSamples>[1]): Promise<SaveResult | null>;
}

export function useLearnFolder(): LearnFolder {
  const supported = folderSupported();
  const handleRef = useRef<Handle | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);

  const refresh = useCallback(async (h: Handle) => {
    try { setCounts(countByLabel(await readIndex(h))); } catch { setCounts(null); }
  }, []);

  useEffect(() => {
    if (!supported) return;
    void (async () => {
      const h = await loadFolder();
      if (!h) return;
      handleRef.current = h;
      setFolderName(h.name);
      if (await ensurePermission(h, false)) await refresh(h);
    })();
  }, [supported, refresh]);

  const choose = useCallback(async () => {
    const h = await pickFolder();
    if (!h) return;
    handleRef.current = h;
    setFolderName(h.name);
    if (await ensurePermission(h, true)) await refresh(h);
  }, [refresh]);

  const forget = useCallback(async () => {
    handleRef.current = null;
    setFolderName(null);
    setCounts(null);
    await forgetFolder();
  }, []);

  const save = useCallback<LearnFolder['save']>(async args => {
    const h = handleRef.current;
    if (!h || !(await ensurePermission(h, true))) return null;
    const r = await saveLearnSamples(h, args);
    await refresh(h);
    return r;
  }, [refresh]);

  return { supported, folderName, counts, choose, forget, save };
}

