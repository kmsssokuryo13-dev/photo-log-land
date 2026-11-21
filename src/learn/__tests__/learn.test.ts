import { describe, expect, it } from 'vitest';
import { caseKeyOf, classKeyFor, collectCandidates, countByLabel, emptyIndex, parseIndex, planSample } from '../learnSamples';
import { INDEX_FILE, readIndex, saveLearnSamples } from '../learnFolder';
import type { OnnxPrediction } from '../../ai/useOnnxModels';

const MARKS = ['金属鋲', '金属標', 'コンクリート杭', '計算点', '木杭'];
const ok = (label: string, score: number): OnnxPrediction => ({
  status: 'ok', modelId: 'm', modelLabel: 'boundary v03', minConfidence: 0.5, autoFillConfidence: null,
  candidates: [{ classId: 'x', label, score }],
} as unknown as OnnxPrediction);
const close = (id: string, onnx?: OnnxPrediction) => ({ id, viewType: 'close', modifiedMs: Date.UTC(2026, 10, 5, 3), onnx });

describe('collectCandidates', () => {
  const points: Parameters<typeof collectCandidates>[0] = [
    { pointName: 'K1', markType: '金属鋲', directions: { 1: { close: close('a', ok('金属鋲', 0.95)) }, 2: { close: close('b', ok('金属標', 0.6)) } } },
    { pointName: 'K2', markType: '金属標', markSource: 'ai' as const, directions: { 1: { close: close('c', ok('金属標', 0.97)), far: { id: 'f', viewType: 'far' } } } },
    { pointName: 'K3', markType: '未設定', directions: { 1: { close: close('d') } } },
    { pointName: 'K4', markType: '計算点', directions: { 1: { close: close('e') } } },
    { pointName: 'K5', markType: 'リスト外', directions: { 1: { close: close('g') } } },
    { pointName: 'K6', markType: '木杭', fromSurvia: true, directions: { 1: { close: close('h') } } },
    { pointName: 'K7', markType: '金属鋲', directions: { 1: { close: close('nooriginal') } } },
  ];
  const c = collectCandidates(points, MARKS, id => id !== 'nooriginal');

  it('標識が決まった点の全方向の近景だけ。未設定・計算点・リスト外・元写真なしは入れない', () => {
    expect(c.map(x => x.fileId)).toEqual(['a', 'b', 'c', 'h']);
  });
  it('AI の1位が正解と違えば aiWrong、入れ方（手・AI・SURVIA）を残す', () => {
    expect(c.find(x => x.fileId === 'a')).toMatchObject({ source: 'manual', aiWrong: false, ai: { top: '金属鋲', score: 0.95 } });
    expect(c.find(x => x.fileId === 'b')).toMatchObject({ aiWrong: true, direction: 2 });
    expect(c.find(x => x.fileId === 'c')).toMatchObject({ source: 'ai', aiWrong: false });
    expect(c.find(x => x.fileId === 'h')).toMatchObject({ source: 'survia', ai: null, aiWrong: false, photoDate: '2026-11-05' });
  });
  it('案件の目印は現場名＋最初の撮影月', () => {
    expect(caseKeyOf(' 港町 ', c)).toBe('港町|2026-11');
    expect(caseKeyOf('', [])).toBe('現場名なし|');
  });
});

describe('classKeyFor', () => {
  it('既定（v03 と同じ英字）→ モデルのクラス名 → 文字コード', () => {
    expect(classKeyFor('金属鋲', { tack: '金属鋲' })).toBe('metal_pin'); // 既定が先（モデルの有無で変わらない）
    expect(classKeyFor('石杭', { stone: '石杭' })).toBe('stone');
    expect(classKeyFor('石杭')).toBe('mark_77f3676d');
    expect(classKeyFor('石杭')).toBe(classKeyFor('石杭'));
  });
});

describe('planSample', () => {
  const ctx = { caseKey: 'A|2026-11', siteName: 'A', now: '2026-11-20T00:00:00Z' };
  const cand = { fileId: 'a', label: '金属標', pointName: 'K1', direction: 1, photoDate: '2026-11-05', source: 'manual' as const, ai: { model: 'v03', top: '金属鋲', score: 0.9 }, aiWrong: true };
  it('新しい写真・同じ写真・標識を直した写真', () => {
    const idx = emptyIndex();
    const p1 = planSample(idx, cand, 'f'.repeat(64), '.JPG', ctx);
    expect(p1.kind).toBe('new');
    if (p1.kind !== 'new') return;
    expect(p1.record.path).toBe('metal_marker/ffffffffffffffff.jpg');
    idx.samples[p1.record.sha256] = p1.record;
    expect(planSample(idx, cand, 'f'.repeat(64), '.JPG', { ...ctx, now: 'later' }).kind).toBe('same');
    const p3 = planSample(idx, { ...cand, label: '金属鋲', aiWrong: false }, 'f'.repeat(64), '.JPG', { ...ctx, now: 'later' });
    expect(p3).toMatchObject({ kind: 'relabel', oldPath: 'metal_marker/ffffffffffffffff.jpg', record: { path: 'metal_pin/ffffffffffffffff.jpg', savedAt: ctx.now } });
  });
  it('一度外れと記録した写真は外れのまま。手で選んだ記録は AI のままの記録で上書きしない', () => {
    const idx = emptyIndex();
    const p1 = planSample(idx, cand, 'a'.repeat(64), '.jpg', ctx);
    if (p1.kind !== 'new') throw new Error();
    idx.samples[p1.record.sha256] = p1.record;
    const p2 = planSample(idx, { ...cand, source: 'ai', aiWrong: false, ai: { model: 'v04', top: '金属標', score: 0.99 } }, 'a'.repeat(64), '.jpg', ctx);
    expect(p2).toMatchObject({ kind: 'update', record: { aiWrong: true, source: 'manual' } });
  });
});

describe('parseIndex・countByLabel', () => {
  it('壊れた記録は空から作り直す', () => {
    expect(parseIndex('{x')).toEqual(emptyIndex());
    expect(parseIndex(null)).toEqual(emptyIndex());
  });
});

// --- 学習フォルダへの保存（File System Access API の代わりにメモリ上のフォルダ） ---
class MemFile { data: Blob; constructor(data: Blob) { this.data = data; } }
class MemDir {
  entries = new Map<string, MemDir | MemFile>();
  name: string;
  constructor(name = 'learn') { this.name = name; }
  async getDirectoryHandle(n: string, o?: { create?: boolean }) {
    let e = this.entries.get(n);
    if (!e && o?.create) { e = new MemDir(n); this.entries.set(n, e); }
    if (!(e instanceof MemDir)) throw new Error('NotFound');
    return e;
  }
  async getFileHandle(n: string, o?: { create?: boolean }) {
    let e = this.entries.get(n);
    if (!e && o?.create) { e = new MemFile(new Blob([])); this.entries.set(n, e); }
    if (!(e instanceof MemFile)) throw new Error('NotFound');
    const f = e;
    return {
      getFile: async () => f.data,
      createWritable: async () => { const parts: BlobPart[] = []; return { write: async (d: BlobPart) => { parts.push(d); }, close: async () => { f.data = new Blob(parts); } }; },
    };
  }
  async removeEntry(n: string) { if (!this.entries.delete(n)) throw new Error('NotFound'); }
  list(): string[] {
    return [...this.entries.entries()].flatMap(([k, v]) => v instanceof MemDir ? v.list().map(x => `${k}/${x}`) : [k]).sort();
  }
}

describe('saveLearnSamples', () => {
  it('種類ごとのフォルダへ元写真を書き、同じ写真は2回入れず、直したら移す', async () => {
    const dir = new MemDir();
    const originals = new Map([['a', new File(['photo-a'], 'K1-1-c.JPG')], ['b', new File(['photo-b'], 'K2-1-c.jpg')]]);
    const pts = (m1: string) => [
      { pointName: 'K1', markType: m1, directions: { 1: { close: close('a', ok('金属鋲', 0.95)) } } },
      { pointName: 'K2', markType: 'コンクリート杭', directions: { 1: { close: close('b') } } },
    ];
    const h = dir as unknown as FileSystemDirectoryHandle;
    const r1 = await saveLearnSamples(h, { points: pts('金属鋲'), markTypes: MARKS, originals, siteName: '港町' });
    expect(r1).toEqual({ added: 2, relabeled: 0, total: 2 });
    expect(dir.list()).toEqual([expect.stringMatching(/^concrete_stake\/[0-9a-f]{16}\.jpg$/), expect.stringMatching(/^metal_pin\/[0-9a-f]{16}\.jpg$/), INDEX_FILE]);
    expect(await saveLearnSamples(h, { points: pts('金属鋲'), markTypes: MARKS, originals, siteName: '港町' })).toEqual({ added: 0, relabeled: 0, total: 2 });
    const r3 = await saveLearnSamples(h, { points: pts('金属標'), markTypes: MARKS, originals, siteName: '港町' });
    expect(r3).toEqual({ added: 0, relabeled: 1, total: 2 });
    expect(dir.list().some(x => x.startsWith('metal_pin/'))).toBe(false);
    const idx = await readIndex(h);
    const moved = Object.values(idx.samples).find(s => s.pointName === 'K1')!;
    expect(moved).toMatchObject({ label: '金属標', classKey: 'metal_marker', aiWrong: true, caseKey: '港町|2026-11' });
    expect(await (originals.get('a')!).text()).toBe('photo-a');
    expect(countByLabel(idx)).toEqual([{ label: '金属標', count: 1, wrong: 1 }, { label: 'コンクリート杭', count: 1, wrong: 0 }]);
  });
});
