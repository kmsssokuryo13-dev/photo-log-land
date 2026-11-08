// 写真の読込：画像かどうかの判定、圧縮、並列処理。
// 画像として開けないファイル（PDF・Thumbs.db・ブラウザが表示できない HEIC など）は例外にして、呼び出し側で飛ばす。

export type CompressionModeKey = 'original' | 'medium' | 'high';

export const COMPRESSION_MODES: Record<CompressionModeKey, { label: string; maxDim: number; quality: number; desc: string }> = {
  original: { label: 'オリジナル', maxDim: Infinity, quality: 1.0, desc: '無加工' },
  medium: { label: '中圧縮', maxDim: 1600, quality: 0.8, desc: '14枚で4〜6MB' },
  high: { label: '高圧縮', maxDim: 1024, quality: 0.6, desc: '40枚で3〜5MB' }
};

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|heic|heif|avif)$/i;

/** 画像ファイルらしいか（種類か拡張子で判定）。フォルダ読込に混ざる PDF・Thumbs.db などを除く */
export function isImageFile(file: { name: string; type: string }): boolean {
  if (file.type) return file.type.startsWith('image/');
  return IMAGE_EXT.test(file.name);
}

/** 長辺を maxDim 以下に収めた大きさ（拡大はしない） */
export function fitSize(width: number, height: number, maxDim: number): { width: number; height: number } {
  const ratio = Math.min(maxDim / width, maxDim / height, 1);
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('ファイルを読めません'));
    reader.readAsDataURL(file);
  });
}

/** 画像を開く（EXIF の向きを反映）。開けなければ例外 */
async function decode(file: Blob): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error('画像として開けません');
  }
}

/** 写真を画質設定に合わせて data URL にする。画像として開けないときは例外 */
export async function compressImage(file: File, mode: CompressionModeKey): Promise<string> {
  const settings = COMPRESSION_MODES[mode];
  const bitmap = await decode(file);
  try {
    // オリジナルはそのまま（開けることだけ確かめる）
    if (mode === 'original') return await readAsDataUrl(file);
    const { width, height } = fitSize(bitmap.width, bitmap.height, settings.maxDim);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画像を縮小できません');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', settings.quality);
  } finally {
    bitmap.close();
  }
}

/** items を最大 limit 件ずつ同時に処理する。結果は items と同じ順番 */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
