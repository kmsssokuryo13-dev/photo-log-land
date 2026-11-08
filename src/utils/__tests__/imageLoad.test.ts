import { describe, expect, it } from 'vitest';
import { fitSize, isImageFile, mapPool } from '../imageLoad';

describe('isImageFile', () => {
  it('画像の種類・拡張子だけを通す', () => {
    expect(isImageFile({ name: 'P1.K.jpg', type: 'image/jpeg' })).toBe(true);
    expect(isImageFile({ name: 'P1.K.HEIC', type: '' })).toBe(true);
    expect(isImageFile({ name: 'Thumbs.db', type: '' })).toBe(false);
    expect(isImageFile({ name: '図面.pdf', type: 'application/pdf' })).toBe(false);
    expect(isImageFile({ name: 'memo.txt', type: 'text/plain' })).toBe(false);
  });
});

describe('fitSize', () => {
  it('長辺を上限に収め、拡大はしない', () => {
    expect(fitSize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitSize(3000, 4000, 1024)).toEqual({ width: 768, height: 1024 });
    expect(fitSize(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(800, 600, Infinity)).toEqual({ width: 800, height: 600 });
  });
});

describe('mapPool', () => {
  it('同時実行数を守り、結果は元の順番', async () => {
    let running = 0;
    let peak = 0;
    const out = await mapPool([30, 5, 20, 1, 10, 2], 3, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, ms));
      running--;
      return i * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50]);
    expect(peak).toBe(3);
  });
  it('空なら空', async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
  });
});
