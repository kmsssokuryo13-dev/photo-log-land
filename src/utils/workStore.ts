// 作業中の台帳の自動保存（ブラウザの IndexedDB。PCの外へは送らない）
// 再読み込みやタブを閉じても、開き直したら続きから始められるようにする。
// 近景の元写真（圧縮前）も保存し、開き直した後も PC内AI で判別し直せるようにする。
// IndexedDB が使えない環境では何もしない（従来どおり再読込で消える）。

const DB_NAME = 'photo-log-land-work';
const DB_VERSION = 1;
const STATE = 'state';
const ORIGINALS = 'originals';
const CURRENT_KEY = 'current';

export interface SavedWork<P> {
  points: P[];
  savedAt: string;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました'));
  });
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB が使えません')); return; }
      const r = indexedDB.open(DB_NAME, DB_VERSION);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(STATE)) db.createObjectStore(STATE);
        if (!db.objectStoreNames.contains(ORIGINALS)) db.createObjectStore(ORIGINALS);
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onblocked = () => reject(new Error('IndexedDB が他のタブで使用中です'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

/** 前回の作業。無ければ null */
export async function loadWork<P>(): Promise<SavedWork<P> | null> {
  const db = await openDb();
  const v = await req(db.transaction(STATE, 'readonly').objectStore(STATE).get(CURRENT_KEY));
  if (!v || !Array.isArray((v as SavedWork<P>).points)) return null;
  return v as SavedWork<P>;
}

export async function saveWork<P>(points: P[]): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(STATE, 'readwrite');
  tx.objectStore(STATE).put({ points, savedAt: new Date().toISOString() } satisfies SavedWork<P>, CURRENT_KEY);
  await done(tx);
}

/** 保存してある元写真（写真ID → ファイル） */
export async function loadOriginals(): Promise<Map<string, File>> {
  const db = await openDb();
  const store = db.transaction(ORIGINALS, 'readonly').objectStore(ORIGINALS);
  const [keys, values] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
  const map = new Map<string, File>();
  keys.forEach((k, i) => { if (values[i] instanceof Blob) map.set(String(k), values[i] as File); });
  return map;
}

export async function putOriginal(id: string, file: File): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(ORIGINALS, 'readwrite');
  tx.objectStore(ORIGINALS).put(file, id);
  await done(tx);
}

export async function deleteOriginals(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(ORIGINALS, 'readwrite');
  const store = tx.objectStore(ORIGINALS);
  ids.forEach(id => store.delete(id));
  await done(tx);
}

/** 作業と元写真をすべて消す（新しく始めるとき） */
export async function clearWork(): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STATE, ORIGINALS], 'readwrite');
  tx.objectStore(STATE).clear();
  tx.objectStore(ORIGINALS).clear();
  await done(tx);
}
