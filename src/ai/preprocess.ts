// 推論用の前処理
// 学習時の前処理を再現する：EXIF回転補正 → RGB化 → 全画像を残したまま
// pad_color(既定 RGB 114,114,114) で正方形にパディング → 入力サイズ(既定 640×640)へリサイズ
// → NCHW float32、画素値 / scale（既定 255 で 0〜1）

import type { ModelConfig } from './modelConfig';

export interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 元画像(w×h)を出力(outW×outH)のどこに描くか。
 * letterbox=true: 一辺 max(w,h) の正方形の中央（または左上）に貼り付け、その正方形を出力サイズへ縮小した位置。
 * 貼り付け位置は Pillow の paste と同じく整数（切り捨て）。
 */
export function computeDrawRect(
  w: number,
  h: number,
  outW: number,
  outH: number,
  letterbox: boolean,
  padPosition: 'center' | 'top-left',
): DrawRect {
  if (!(w > 0 && h > 0)) throw new Error('画像サイズが不正です');
  if (!letterbox) return { x: 0, y: 0, width: outW, height: outH };
  const side = Math.max(w, h);
  const offX = padPosition === 'center' ? Math.floor((side - w) / 2) : 0;
  const offY = padPosition === 'center' ? Math.floor((side - h) / 2) : 0;
  const rx = outW / side;
  const ry = outH / side;
  return { x: offX * rx, y: offY * ry, width: w * rx, height: h * ry };
}

/** RGBA画素列（Canvas の ImageData）→ NCHW float32 */
export function rgbaToNchw(
  rgba: ArrayLike<number>,
  width: number,
  height: number,
  pre: ModelConfig['preprocess'],
): Float32Array {
  const plane = width * height;
  if (rgba.length < plane * 4) throw new Error('画素データが不足しています');
  const out = new Float32Array(plane * 3);
  const order = pre.channelOrder === 'BGR' ? [2, 1, 0] : [0, 1, 2];
  for (let c = 0; c < 3; c++) {
    const src = order[c];
    const mean = pre.mean[c];
    const std = pre.std[c];
    const base = c * plane;
    for (let i = 0; i < plane; i++) {
      out[base + i] = (rgba[i * 4 + src] / pre.scale - mean) / std;
    }
  }
  return out;
}

async function decode(file: Blob, exifTranspose: boolean): Promise<ImageBitmap> {
  // colorSpaceConversion:'none' … 埋め込みICCで色を変換しない（Pillow と同じく画素値をそのまま使う）
  return createImageBitmap(file, {
    imageOrientation: exifTranspose ? 'from-image' : 'none',
    colorSpaceConversion: 'none',
    premultiplyAlpha: 'none',
  });
}

function makeCanvas(w: number, h: number): { ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } {
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (ctx) return { ctx };
  }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas を初期化できません');
  return { ctx };
}

export interface PreprocessResult {
  data: Float32Array;
  dims: [1, 3, number, number];
  sourceWidth: number; // EXIF回転補正後の元画像サイズ
  sourceHeight: number;
}

/** 元の写真ファイル（圧縮前）から入力テンソルを作る */
export async function preprocessImage(file: Blob, config: ModelConfig): Promise<PreprocessResult> {
  const { width: outW, height: outH } = config.input;
  const pre = config.preprocess;
  const bitmap = await decode(file, pre.exifTranspose);
  try {
    const rect = computeDrawRect(bitmap.width, bitmap.height, outW, outH, pre.letterbox, pre.padPosition);
    const { ctx } = makeCanvas(outW, outH);
    const [r, g, b] = pre.padColor;
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, outW, outH);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, rect.x, rect.y, rect.width, rect.height);
    const pixels = ctx.getImageData(0, 0, outW, outH).data;
    return {
      data: rgbaToNchw(pixels, outW, outH, pre),
      dims: [1, 3, outH, outW],
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
    };
  } finally {
    bitmap.close();
  }
}
