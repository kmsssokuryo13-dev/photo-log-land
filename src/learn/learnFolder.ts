// 学習フォルダ（PCのフォルダ）へ正解写真を保存する。Chrome / Edge の File System Access API を使う。
// 写真も記録もPCのフォルダに置くだけで、PCの外へは送らない。
// 選んだフォルダはブラウザの IndexedDB に覚えておき、次からは許可を聞くだけにする。

import {
  caseKeyOf, collectCandidates, parseIndex, planSample,
  type LearnIndex, type LearnCandidate,
} from './learnSamples';

export const INDEX_FILE = 'samples.json';

// --- File System Access API の型（TypeScript の DOM 型に無い部分だけ） ---
type PermissionMode = { mode: 'readwrite' };
interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission?(o: PermissionMode): Promise<PermissionState>;
  requestPermission?(o: PermissionMode): Promise<PermissionState>;
}
type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: 'readwrite' }) => Promise<DirHandle> };

export function folderSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

// --- 選んだフォルダを覚える ---
const DB_NAME = 'photo-log-land-learn';
const STORE = 'handles';
const KEY = 'folder';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB が使えません')); return; }
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

export async function loadFolder(): Promise<DirHandle | null> {
  try { return (await idb<DirHandle | undefined>('readonly', s => s.get(KEY) as IDBRequest<DirHandle | undefined>)) ?? null; } catch { return null; }
}

export async function forgetFolder(): Promise<void> {
  try { await idb('readwrite', s => s.delete(KEY)); } catch { /* ignore */ }
}

/** フォルダを選ぶ（ボタンを押した時だけ呼ぶ） */
export async function pickFolder(): Promise<DirHandle | null> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (!picker) return null;
  try {
    const h = await picker({ id: 'boundary-learn', mode: 'readwrite' });
    try { await idb('readwrite', s => s.put(h, KEY)); } catch { /* 覚えられなくても今回は使える */ }
    return h;
  } catch {
    return null; // 取り消し
  }
}

/** 書き込みの許可。ask=true はボタンを押した直後だけ（ブラウザが許可の窓を出す） */
export async function ensurePermission(h: DirHandle, ask: boolean): Promise<boolean> {
  const o: PermissionMode = { mode: 'readwrite' };
  try {
    if (!h.queryPermission) return true;
    if ((await h.queryPermission(o)) === 'granted') return true;
    if (!ask || !h.requestPermission) return false;
    return (await h.requestPermission(o)) === 'granted';
  } catch {
    return false;
  }
}

// --- 読み書き ---
async function readText(dir: FileSystemDirectoryHandle, name: string): Promise<string | null> {
  try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch { return null; }
}

async function writeFile(dir: FileSystemDirectoryHandle, path: string, data: Blob | string): Promise<void> {
  const parts = path.split('/');
  let d = dir;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
  const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

async function removeFile(dir: FileSystemDirectoryHandle, path: string): Promise<void> {
  const parts = path.split('/');
  try {
    let d = dir;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
    await d.removeEntry(parts[parts.length - 1]);
  } catch { /* 既に無い */ }
}

export async function readIndex(dir: FileSystemDirectoryHandle): Promise<LearnIndex> {
  return parseIndex(await readText(dir, INDEX_FILE));
}

export async function sha256Hex(file: Blob): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function extOf(name: string): string {
  const m = /\.[^.]+$/.exec(name);
  return m ? m[0] : '.jpg';
}

export interface SaveResult { added: number; relabeled: number; total: number }

/**
 * 台帳の点から正解写真を学習フォルダへ保存する。元写真をそのまま（圧縮せず）書く。
 * 同じ写真は2回入れず、標識を直していれば種類のフォルダを移す。
 */
export async function saveLearnSamples(dir: FileSystemDirectoryHandle, args: {
  points: Parameters<typeof collectCandidates>[0];
  markTypes: string[];
  originals: Map<string, File>;
  siteName: string;
  modelDisplayNames?: Record<string, string>;
}): Promise<SaveResult> {
  const candidates: LearnCandidate[] = collectCandidates(args.points, args.markTypes, id => args.originals.has(id));
  const index = await readIndex(dir);
  const now = new Date().toISOString();
  const caseKey = caseKeyOf(args.siteName, candidates);
  let added = 0, relabeled = 0, changed = false;
  for (const c of candidates) {
    const file = args.originals.get(c.fileId)!;
    const sha = await sha256Hex(file);
    const plan = planSample(index, c, sha, extOf(file.name), { caseKey, siteName: args.siteName.trim(), now, modelDisplayNames: args.modelDisplayNames });
    if (plan.kind === 'same') continue;
    if (plan.kind === 'new' || plan.kind === 'relabel') await writeFile(dir, plan.record.path, file);
    if (plan.kind === 'relabel') { await removeFile(dir, plan.oldPath); relabeled++; }
    if (plan.kind === 'new') added++;
    index.samples[sha] = plan.record;
    changed = true;
  }
  if (changed) await writeFile(dir, INDEX_FILE, JSON.stringify(index, null, 1));
  return { added, relabeled, total: Object.keys(index.samples).length };
}
