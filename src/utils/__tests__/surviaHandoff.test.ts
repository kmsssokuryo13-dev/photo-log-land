import { afterEach, describe, expect, it, vi } from 'vitest';
import { isoDate, parseManifest, readHandoffRef, receiveFromSurvia, sendMarksToSurvia, stripHandoffRef } from '../surviaHandoff';

// SURVIA との受け渡し（土地）。架空のデータだけ。
const TOKEN = 'A'.repeat(43);

describe('受け渡し口の場所', () => {
  it('# の後ろの survia=<port>.<token> だけを読み、読んだら消す', () => {
    expect(readHandoffRef(`#/?survia=51234.${TOKEN}`)).toEqual({ port: 51234, token: TOKEN });
    expect(readHandoffRef('#/?survia=80.x')).toBeNull();
    expect(readHandoffRef('')).toBeNull();
    expect(stripHandoffRef(`#/?survia=51234.${TOKEN}`)).toBe('');
    expect(stripHandoffRef(`#/?a=1&survia=51234.${TOKEN}`)).toBe('#/?a=1');
  });
});

describe('一覧の形', () => {
  const ok = { kind: 'survia-photo-land-handoff', version: 1, groups: [], siteName: '架空市架空町地内', marks: [{ name: 'P1', markType: '金属標' }], photos: [{ index: 0, name: 'P1遠景.jpg', modified: 1762128000000 }] };
  it('現場名・境界標・写真（更新日時つき）を読む', () => {
    expect(parseManifest(ok)).toEqual({ siteName: '架空市架空町地内', marks: [{ name: 'P1', markType: '金属標' }], photos: [{ index: 0, name: 'P1遠景.jpg', modified: 1762128000000 }] });
  });
  it('建物の一覧・形の違うものは読まない', () => {
    expect(parseManifest({ ...ok, kind: 'survia-photo-building-handoff' })).toBeNull();
    expect(parseManifest({ ...ok, photos: [{ index: 0, name: '../a.jpg' }] })).toBeNull();
    expect(parseManifest({ ...ok, marks: 'x' })).toBeNull();
  });
});

describe('受け取りと戻し', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('写真は File にして、更新日時をそのまま撮影日にする', async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith('manifest')
      ? new Response(JSON.stringify({ kind: 'survia-photo-land-handoff', version: 1, siteName: '架空市架空町地内', marks: [], photos: [{ index: 0, name: 'P1近景.jpg', modified: 1762128000000 }] }))
      : new Response(new Blob([new Uint8Array([1, 2])])));
    vi.stubGlobal('fetch', fetch);
    const got = await receiveFromSurvia({ port: 51234, token: TOKEN });
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([`http://127.0.0.1:51234/survia-photo/${TOKEN}/manifest`, `http://127.0.0.1:51234/survia-photo/${TOKEN}/photo/0`]);
    expect(got.siteName).toBe('架空市架空町地内');
    expect(got.files[0].name).toBe('P1近景.jpg');
    expect(got.files[0].lastModified).toBe(1762128000000);
  });

  it('点名・標識・撮影日を marks へ送り、戻した数を返す', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ kind: 'survia-photo-land-marks', version: 1, points: [{ name: 'P1', markType: '金属標', photoDates: ['2025-11-03', ''] }] });
      return new Response(JSON.stringify({ kind: 'received', count: 1 }));
    });
    vi.stubGlobal('fetch', fetch);
    expect(await sendMarksToSurvia({ port: 51234, token: TOKEN }, [{ name: ' P1\n', markType: '金属標', photoDates: ['2025-11-03', ''] }])).toBe(1);
    expect(fetch.mock.calls[0][0]).toBe(`http://127.0.0.1:51234/survia-photo/${TOKEN}/marks`);
  });

  it('届かなければ開き直しを案内する。断られたら理由を出す', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('failed'); }));
    await expect(sendMarksToSurvia({ port: 51234, token: TOKEN }, [])).rejects.toThrow('SURVIA から開き直してください');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ kind: 'failed', reason: '中身が不正です' }), { status: 400 })));
    await expect(sendMarksToSurvia({ port: 51234, token: TOKEN }, [])).rejects.toThrow('中身が不正です');
  });

  it('撮影日は YYYY-MM-DD（無ければ空）', () => {
    expect(isoDate(new Date(2025, 10, 3, 12).getTime())).toBe('2025-11-03');
    expect(isoDate(undefined)).toBe('');
  });
});
