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
  needsPermission: boolean; // フォルダは選んであるが、開き直した後でまだ許可していない
  choose(): Promise<void>;
  /** 書き込みの許可を聞く（ボタンを押した直後に、ほかの処理より先に呼ぶ） */
  allow(): Promise<boolean>;
  forget(): Promise<void>;
  /** 許可済みの時だけ保存する。フォルダ未選択・許可なしなら null。続けて呼ばれても1つずつ順に保存する */
  save(args: Parameters<typeof saveLearnSamples>[1]): Promise<SaveResult | null>;
}

export function useLearnFolder(): LearnFolder {
  const supported = folderSupported();
  const handleRef = useRef<Handle | null>(null);
  const [folderName, setFolderName] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [needsPermission, setNeedsPermission] = useState(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());

  const refresh = useCallback(async (h: Handle) => {
    setNeedsPermission(false);
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
      else setNeedsPermission(true);
    })();
  }, [supported, refresh]);

  const choose = useCallback(async () => {
    const h = await pickFolder();
    if (!h) return;
    handleRef.current = h;
    setFolderName(h.name);
    if (await ensurePermission(h, true)) await refresh(h);
    else setNeedsPermission(true);
  }, [refresh]);

  const allow = useCallback(async () => {
    const h = handleRef.current;
    if (!h) return false;
    if (await ensurePermission(h, true)) {
      if (needsPermission) await refresh(h);
      return true;
    }
    setNeedsPermission(true);
    return false;
  }, [needsPermission, refresh]);

  const forget = useCallback(async () => {
    handleRef.current = null;
    setFolderName(null);
    setCounts(null);
    setNeedsPermission(false);
    await forgetFolder();
  }, []);

  const save = useCallback<LearnFolder['save']>(args => {
    const run = async () => {
      const h = handleRef.current;
      if (!h || !(await ensurePermission(h, false))) return null;
      const r = await saveLearnSamples(h, args);
      await refresh(h);
      return r;
    };
    const next = queueRef.current.then(run, run);
    queueRef.current = next.catch(() => undefined);
    return next;
  }, [refresh]);

  return { supported, folderName, counts, needsPermission, choose, allow, forget, save };
}

