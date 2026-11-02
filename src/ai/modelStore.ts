// 登録モデルの保存先（ブラウザの IndexedDB。PCの外へは送らない）
// モデルは版ごとに別レコードで保持し、使用中のモデルを切り替えて元に戻せるようにする。
// IndexedDB が使えない環境ではメモリ上だけで保持する（再読込で消える）。

import type { ModelConfig } from './modelConfig';

export interface ValidationReport {
  ok: boolean;
  checkedAt: string;
  inputName: string;
  outputName: string;
  outputSize: number;
  notes: string[]; // 互換性の注意（旧モデルとのクラス差分など）
}

export interface ModelMeta {
  id: string;
  config: ModelConfig;
  modelFileName: string;
  configFileName: string;
  sizeBytes: number;
  addedAt: string;
  validation: ValidationReport;
}

export interface StoredModel extends ModelMeta {
  model: Blob;
}

export interface ModelStore {
  readonly persistent: boolean;
  list(): Promise<ModelMeta[]>;
  getModel(id: string): Promise<Blob | null>;
  put(record: StoredModel): Promise<void>;
  remove(id: string): Promise<void>;
  getActiveId(): Promise<string | null>;
  setActiveId(id: string | null): Promise<void>;
}

const DB_NAME = 'photo-log-land-ai';
const DB_VERSION = 1;
const MODELS = 'models';
const META = 'meta';
const ACTIVE_KEY = 'activeModelId';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(MODELS)) db.createObjectStore(MODELS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('IndexedDB が他のタブで使用中です'));
  });
}

function stripBlob(r: StoredModel): ModelMeta {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { model, ...meta } = r;
  return meta;
}

class IdbModelStore implements ModelStore {
  readonly persistent = true;
  private db: IDBDatabase;
  constructor(db: IDBDatabase) {
    this.db = db;
  }

  private store(name: string, mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }

  async list(): Promise<ModelMeta[]> {
    const all = await req(this.store(MODELS, 'readonly').getAll() as IDBRequest<StoredModel[]>);
    return all.map(stripBlob).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }

  async getModel(id: string): Promise<Blob | null> {
    const r = await req(this.store(MODELS, 'readonly').get(id) as IDBRequest<StoredModel | undefined>);
    return r?.model ?? null;
  }

  async put(record: StoredModel): Promise<void> {
    await req(this.store(MODELS, 'readwrite').put(record));
  }

  async remove(id: string): Promise<void> {
    await req(this.store(MODELS, 'readwrite').delete(id));
  }

  async getActiveId(): Promise<string | null> {
    const v = await req(this.store(META, 'readonly').get(ACTIVE_KEY));
    return typeof v === 'string' ? v : null;
  }

  async setActiveId(id: string | null): Promise<void> {
    const s = this.store(META, 'readwrite');
    if (id === null) await req(s.delete(ACTIVE_KEY));
    else await req(s.put(id, ACTIVE_KEY));
  }
}

export class MemoryModelStore implements ModelStore {
  readonly persistent = false;
  private records = new Map<string, StoredModel>();
  private activeId: string | null = null;

  async list(): Promise<ModelMeta[]> {
    return [...this.records.values()].map(stripBlob).sort((a, b) => b.addedAt.localeCompare(a.addedAt));
  }
  async getModel(id: string): Promise<Blob | null> {
    return this.records.get(id)?.model ?? null;
  }
  async put(record: StoredModel): Promise<void> {
    this.records.set(record.id, record);
  }
  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }
  async getActiveId(): Promise<string | null> {
    return this.activeId;
  }
  async setActiveId(id: string | null): Promise<void> {
    this.activeId = id;
  }
}

export async function openModelStore(): Promise<ModelStore> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB なし');
    return new IdbModelStore(await openDb());
  } catch {
    return new MemoryModelStore();
  }
}
