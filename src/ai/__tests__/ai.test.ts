import { describe, expect, it } from 'vitest';
import { diffClasses, parseModelConfig, ModelConfigError } from '../modelConfig';
import { computeDrawRect, rgbaToNchw } from '../preprocess';
import { softmax, toCandidates } from '../postprocess';
import { aiTargetFiles, applyPrediction, isAiTargetView, predictionForPoint } from '../pointPrediction';
import { MemoryModelStore } from '../modelStore';
import type { OnnxPrediction } from '../useOnnxModels';

const base = { model_version: '1.0.0', classes: ['metal_tack', 'concrete_post', 'plastic_post'] };

describe('parseModelConfig', () => {
  it('既定値は学習時の前処理（640・114パディング・0〜1・RGB・EXIF補正）', () => {
    const c = parseModelConfig(base);
    expect(c.input).toEqual({ name: null, width: 640, height: 640 });
    expect(c.preprocess).toEqual({
      exifTranspose: true, letterbox: true, padColor: [114, 114, 114], padPosition: 'center',
      channelOrder: 'RGB', scale: 255, mean: [0, 0, 0], std: [1, 1, 1],
    });
    expect(c.output.type).toBe('probabilities');
    expect(c.topK).toBe(3);
  });

  it('設定ファイルの入力サイズ・前処理・表示名に従う', () => {
    const c = parseModelConfig({
      ...base, input: { name: 'images', size: 320 }, preprocess: { pad_color: [0, 0, 0], scale: 1, channel_order: 'BGR' },
      output: { name: 'out', type: 'logits' }, display_names: { metal_tack: '金属鋲' }, top_k: 10,
    });
    expect(c.input).toEqual({ name: 'images', width: 320, height: 320 });
    expect(c.preprocess.padColor).toEqual([0, 0, 0]);
    expect(c.preprocess.channelOrder).toBe('BGR');
    expect(c.output).toEqual({ name: 'out', type: 'logits' });
    expect(c.displayNames.metal_tack).toBe('金属鋲');
    expect(c.topK).toBe(3); // クラス数で頭打ち
  });

  it('Ultralytics 形式の names を受け付ける', () => {
    const c = parseModelConfig({ model_version: 'v2', names: { 1: 'b', 0: 'a' } });
    expect(c.classes).toEqual(['a', 'b']);
  });

  it.each([
    [null],
    [{ classes: ['a', 'b'] }], // version なし
    [{ ...base, classes: ['a'] }],
    [{ ...base, classes: ['a', 'a'] }],
    [{ ...base, task: 'detect' }],
    [{ ...base, input: { layout: 'NHWC' } }],
    [{ ...base, input: { width: 0 } }],
    [{ ...base, preprocess: { std: [1, 0, 1] } }],
    [{ ...base, preprocess: { pad_color: [300, 0, 0] } }],
    [{ ...base, display_names: { unknown: 'x' } }],
    [{ model_version: '1', names: { 0: 'a', 2: 'b' } }],
    [{ ...base, min_confidence: 2 }],
  ])('不正な設定は拒否する %#', (raw) => {
    expect(() => parseModelConfig(raw)).toThrow(ModelConfigError);
  });

  it('新旧モデルのクラス差分', () => {
    const a = parseModelConfig({ ...base, display_names: { metal_tack: '金属鋲' } });
    const b = parseModelConfig({ model_version: '2', classes: ['金属鋲', 'concrete_post', 'wood_post'] });
    expect(diffClasses(a, b)).toEqual({ added: ['wood_post'], removed: ['plastic_post'] });
  });
});

describe('computeDrawRect（全画像保持・正方形パディング）', () => {
  it('横長：上下に均等パディング', () => {
    // 4000×3000 → 4000角の正方形、上に500px → 640角では 80px
    expect(computeDrawRect(4000, 3000, 640, 640, true, 'center')).toEqual({ x: 0, y: 80, width: 640, height: 480 });
  });
  it('縦長：左右に均等パディング（Pillow と同じく切り捨て）', () => {
    const r = computeDrawRect(3, 4, 640, 640, true, 'center');
    expect(r.x).toBe(0); // floor((4-3)/2)=0
    expect(r.width).toBe(480);
    expect(r.height).toBe(640);
  });
  it('正方形はそのまま', () => {
    expect(computeDrawRect(1000, 1000, 640, 640, true, 'center')).toEqual({ x: 0, y: 0, width: 640, height: 640 });
  });
  it('左上寄せ・パディングなし', () => {
    expect(computeDrawRect(4000, 3000, 640, 640, true, 'top-left')).toEqual({ x: 0, y: 0, width: 640, height: 480 });
    expect(computeDrawRect(4000, 3000, 640, 640, false, 'center')).toEqual({ x: 0, y: 0, width: 640, height: 640 });
  });
});

describe('rgbaToNchw', () => {
  const pre = parseModelConfig(base).preprocess;
  it('NCHW・0〜1スケール・アルファ無視', () => {
    // 2×1 画素: (255,0,114,0) (0,51,255,255)
    const t = rgbaToNchw([255, 0, 114, 0, 0, 51, 255, 255], 2, 1, pre);
    expect(Array.from(t)).toEqual([1, 0, 0, 0.2, 114 / 255, 1].map(v => Math.fround(v)));
  });
  it('BGR・mean/std', () => {
    const t = rgbaToNchw([10, 20, 30, 255], 1, 1, { ...pre, channelOrder: 'BGR', scale: 1, mean: [1, 2, 3], std: [2, 2, 2] });
    expect(Array.from(t)).toEqual([(30 - 1) / 2, (20 - 2) / 2, (10 - 3) / 2]);
  });
});

describe('toCandidates', () => {
  it('確率をそのまま使い上位順', () => {
    const c = parseModelConfig({ ...base, display_names: { concrete_post: 'コンクリート杭' }, top_k: 2 });
    const r = toCandidates([0.1, 0.7, 0.2], c);
    expect(r.map(x => x.label)).toEqual(['コンクリート杭', 'plastic_post']);
    expect(r[0].score).toBeCloseTo(0.7);
  });
  it('logits は softmax', () => {
    const c = parseModelConfig({ ...base, output: { type: 'logits' } });
    const r = toCandidates([0, 0, Math.log(2)], c);
    expect(r[0].cls).toBe('plastic_post');
    expect(r[0].score).toBeCloseTo(0.5);
    expect(softmax([1000, 1000]).every(v => v === 0.5)).toBe(true);
  });
  it('出力数がクラス数と違えばエラー', () => {
    expect(() => toCandidates([0.5, 0.5], parseModelConfig(base))).toThrow();
    expect(() => toCandidates([NaN, 0, 0], parseModelConfig(base))).toThrow();
  });
});

describe('AI候補は手動確定を上書きしない', () => {
  type F = { id: string; viewType: string; url: string; onnx?: OnnxPrediction };
  const pred: OnnxPrediction = { status: 'ok', modelId: 'm', modelLabel: 'm 1', minConfidence: 0, candidates: [{ cls: 'a', label: '金属鋲', score: 0.9 }] };
  const make = () => [
    { id: 'p1', pointName: 'K1', markType: 'コンクリート杭', selectedDirection: 1, notes: '',
      directions: { 1: { far: { id: 'f1', viewType: 'far', url: 'x' } as F, close: { id: 'f2', viewType: 'close', url: 'y' } as F } } },
    { id: 'p2', pointName: 'K2', markType: '計算点', selectedDirection: 1, notes: '', directions: { 1: {} as Record<string, F> } },
  ];

  it('対象は近景のみ', () => {
    expect(isAiTargetView('close')).toBe(true);
    for (const v of ['far', 'middle', 'macro']) expect(isAiTargetView(v)).toBe(false);
    expect(aiTargetFiles(make()).map(f => f.id)).toEqual(['f2']);
  });

  it('候補を付けても標識・点名・他の写真は変わらない', () => {
    const before = make();
    const after = applyPrediction(before, 'f2', pred);
    expect(after[0].markType).toBe('コンクリート杭');
    expect(after[0].pointName).toBe('K1');
    expect(after[1]).toBe(before[1]);
    expect(after[1].markType).toBe('計算点');
    expect(after[0].directions[1].far).toBe(before[0].directions[1].far);
    expect(predictionForPoint(after[0])).toBe(pred);
    expect(predictionForPoint(before[0])).toBeUndefined(); // 元の配列は変更しない
  });

  it('該当写真がなければ同じ配列を返す', () => {
    const before = make();
    expect(applyPrediction(before, 'nope', pred)).toBe(before);
  });
});

describe('MemoryModelStore（新旧モデルの別管理）', () => {
  it('版ごとに保持し、使用中を切り替えられる', async () => {
    const s = new MemoryModelStore();
    const cfg = parseModelConfig(base);
    const meta = (id: string, addedAt: string) => ({
      id, config: cfg, modelFileName: 'm.onnx', configFileName: 'model_config.json', sizeBytes: 1, addedAt,
      validation: { ok: true, checkedAt: addedAt, inputName: 'images', outputName: 'out', outputSize: 3, notes: [] },
      model: new Blob([new Uint8Array([1])]),
    });
    await s.put(meta('old', '2026-01-01'));
    await s.put(meta('new', '2026-02-01'));
    await s.setActiveId('new');
    expect((await s.list()).map(m => m.id)).toEqual(['new', 'old']);
    await s.setActiveId('old'); // ロールバック
    expect(await s.getActiveId()).toBe('old');
    expect(await s.getModel('new')).not.toBeNull();
    expect('model' in (await s.list())[0]).toBe(false);
  });
});
