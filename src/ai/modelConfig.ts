// model_config.json の型と検証（純粋関数のみ。ブラウザAPIに依存しない）

export type PadPosition = 'center' | 'top-left';
export type OutputType = 'probabilities' | 'logits';

export interface ModelConfig {
  schemaVersion: 1;
  modelName: string;
  modelVersion: string;
  input: {
    name: string | null; // null の場合はモデルの先頭入力を使う
    width: number;
    height: number;
  };
  preprocess: {
    exifTranspose: boolean;
    letterbox: boolean; // true: 正方形パディング後にリサイズ / false: 縦横比を無視してリサイズ
    padColor: [number, number, number];
    padPosition: PadPosition;
    channelOrder: 'RGB' | 'BGR';
    scale: number; // 画素値をこの値で割る（255 なら 0〜1）
    mean: [number, number, number];
    std: [number, number, number];
  };
  output: {
    name: string | null;
    type: OutputType;
  };
  classes: string[];
  displayNames: Record<string, string>; // モデルのクラス名 → 画面表示名（標識リストの名称）
  topK: number;
  minConfidence: number;
  /** これ以上の確信度なら「未設定」の標識へ自動入力する。null は自動入力しない（候補表示のみ） */
  autoFillConfidence: number | null;
}

/** auto_fill_confidence を書いていないときのしきい値（2026-11-07 ユーザー決定）。null を書くと自動入力しない */
export const DEFAULT_AUTO_FILL_CONFIDENCE = 0.9;

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigError';
  }
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pick(obj: Json, ...keys: string[]): unknown {
  for (const k of keys) if (k in obj) return obj[k];
  return undefined;
}

function str(v: unknown, field: string, fallback?: string): string {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'string' || v.trim() === '') throw new ModelConfigError(`${field} は文字列で指定してください`);
  return v.trim();
}

function optStr(v: unknown, field: string): string | null {
  if (v === undefined || v === null) return null;
  return str(v, field);
}

function posInt(v: unknown, field: string, fallback?: number): number {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0 || v > 4096) throw new ModelConfigError(`${field} は 1〜4096 の整数で指定してください`);
  return v;
}

function num(v: unknown, field: string, fallback: number): number {
  if (v === undefined) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ModelConfigError(`${field} は数値で指定してください`);
  return v;
}

function bool(v: unknown, field: string, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new ModelConfigError(`${field} は true / false で指定してください`);
  return v;
}

function triple(v: unknown, field: string, fallback: [number, number, number], range?: [number, number]): [number, number, number] {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.length !== 3 || v.some(x => typeof x !== 'number' || !Number.isFinite(x))) {
    throw new ModelConfigError(`${field} は数値3つの配列で指定してください`);
  }
  if (range && v.some(x => x < range[0] || x > range[1])) throw new ModelConfigError(`${field} は ${range[0]}〜${range[1]} の範囲で指定してください`);
  return [v[0], v[1], v[2]];
}

/**
 * model_config.json を検証して正規化する。
 * snake_case / camelCase の両方を受け付ける。既定値は学習時の前処理
 * （EXIF回転補正・RGB・RGB(114,114,114)で正方形パディング・640×640・NCHW float32・0〜1）。
 */
export function parseModelConfig(raw: unknown): ModelConfig {
  if (!isObject(raw)) throw new ModelConfigError('設定ファイルがJSONオブジェクトではありません');

  const schemaVersion = pick(raw, 'schema_version', 'schemaVersion');
  if (schemaVersion !== undefined && schemaVersion !== 1) throw new ModelConfigError(`未対応の schema_version: ${String(schemaVersion)}`);

  const task = pick(raw, 'task');
  if (task !== undefined && task !== 'classify') throw new ModelConfigError(`未対応の task: ${String(task)}（classify のみ対応）`);

  const input = isObject(raw.input) ? raw.input : {};
  const layout = pick(input, 'layout');
  if (layout !== undefined && layout !== 'NCHW') throw new ModelConfigError('input.layout は NCHW のみ対応です');
  const dtype = pick(input, 'dtype');
  if (dtype !== undefined && dtype !== 'float32') throw new ModelConfigError('input.dtype は float32 のみ対応です');
  const size = pick(input, 'size', 'imgsz');
  const width = posInt(pick(input, 'width') ?? size, 'input.width', 640);
  const height = posInt(pick(input, 'height') ?? size, 'input.height', 640);

  const pre = isObject(raw.preprocess) ? raw.preprocess : {};
  const channelOrder = pick(pre, 'channel_order', 'channelOrder', 'color') ?? pick(input, 'color');
  if (channelOrder !== undefined && channelOrder !== 'RGB' && channelOrder !== 'BGR') throw new ModelConfigError('channel_order は RGB か BGR で指定してください');
  const padPosition = pick(pre, 'pad_position', 'padPosition');
  if (padPosition !== undefined && padPosition !== 'center' && padPosition !== 'top-left') throw new ModelConfigError('pad_position は center か top-left で指定してください');
  const scale = num(pick(pre, 'scale'), 'preprocess.scale', 255);
  if (scale <= 0) throw new ModelConfigError('preprocess.scale は正の数で指定してください');
  const std = triple(pick(pre, 'std'), 'preprocess.std', [1, 1, 1]);
  if (std.some(s => s === 0)) throw new ModelConfigError('preprocess.std に 0 は使えません');

  const output = isObject(raw.output) ? raw.output : {};
  const outputType = pick(output, 'type') ?? 'probabilities';
  if (outputType !== 'probabilities' && outputType !== 'logits') throw new ModelConfigError('output.type は probabilities か logits で指定してください');

  const rawClasses = pick(raw, 'classes', 'names');
  let classes: string[];
  if (Array.isArray(rawClasses)) {
    classes = rawClasses.map((c, i) => str(c, `classes[${i}]`));
  } else if (isObject(rawClasses)) {
    // Ultralytics 形式 {"0": "name", "1": "name"}
    const entries = Object.entries(rawClasses).map(([k, v]) => [Number(k), str(v, `classes.${k}`)] as const);
    if (entries.some(([k]) => !Number.isInteger(k) || k < 0)) throw new ModelConfigError('classes のキーは 0 以上の整数にしてください');
    entries.sort((a, b) => a[0] - b[0]);
    if (entries.some(([k], i) => k !== i)) throw new ModelConfigError('classes の番号が 0 から連番になっていません');
    classes = entries.map(([, v]) => v);
  } else {
    throw new ModelConfigError('classes（クラス名の配列）がありません');
  }
  if (classes.length < 2) throw new ModelConfigError('classes は2つ以上必要です');
  if (new Set(classes).size !== classes.length) throw new ModelConfigError('classes に重複があります');

  const rawDisplay = pick(raw, 'display_names', 'displayNames');
  const displayNames: Record<string, string> = {};
  if (rawDisplay !== undefined) {
    if (!isObject(rawDisplay)) throw new ModelConfigError('display_names はオブジェクトで指定してください');
    for (const [k, v] of Object.entries(rawDisplay)) {
      if (!classes.includes(k)) throw new ModelConfigError(`display_names の「${k}」は classes にありません`);
      displayNames[k] = str(v, `display_names.${k}`);
    }
  }

  const topK = posInt(pick(raw, 'top_k', 'topK'), 'top_k', 3);
  const minConfidence = num(pick(raw, 'min_confidence', 'minConfidence'), 'min_confidence', 0);
  if (minConfidence < 0 || minConfidence > 1) throw new ModelConfigError('min_confidence は 0〜1 で指定してください');
  const rawAutoFill = pick(raw, 'auto_fill_confidence', 'autoFillConfidence');
  let autoFillConfidence: number | null = rawAutoFill === null ? null : DEFAULT_AUTO_FILL_CONFIDENCE;
  if (rawAutoFill !== undefined && rawAutoFill !== null) {
    autoFillConfidence = num(rawAutoFill, 'auto_fill_confidence', 0);
    if (autoFillConfidence <= 0 || autoFillConfidence > 1) throw new ModelConfigError('auto_fill_confidence は 0 より大きく 1 以下で指定してください');
  }

  return {
    schemaVersion: 1,
    modelName: str(pick(raw, 'model_name', 'modelName'), 'model_name', 'model'),
    modelVersion: str(pick(raw, 'model_version', 'modelVersion', 'version'), 'model_version'),
    input: { name: optStr(pick(input, 'name'), 'input.name'), width, height },
    preprocess: {
      exifTranspose: bool(pick(pre, 'exif_transpose', 'exifTranspose'), 'preprocess.exif_transpose', true),
      letterbox: bool(pick(pre, 'letterbox', 'pad_to_square', 'padToSquare'), 'preprocess.letterbox', true),
      padColor: triple(pick(pre, 'pad_color', 'padColor'), 'preprocess.pad_color', [114, 114, 114], [0, 255]),
      padPosition: (padPosition as PadPosition | undefined) ?? 'center',
      channelOrder: (channelOrder as 'RGB' | 'BGR' | undefined) ?? 'RGB',
      scale,
      mean: triple(pick(pre, 'mean'), 'preprocess.mean', [0, 0, 0]),
      std,
    },
    output: { name: optStr(pick(output, 'name'), 'output.name'), type: outputType },
    classes,
    displayNames,
    topK: Math.min(topK, classes.length),
    minConfidence,
    autoFillConfidence,
  };
}

export function displayNameOf(config: ModelConfig, cls: string): string {
  return config.displayNames[cls] ?? cls;
}

/** 新旧モデルのクラス構成の違い（互換性確認用） */
export function diffClasses(prev: ModelConfig, next: ModelConfig): { added: string[]; removed: string[] } {
  const p = new Set(prev.classes.map(c => displayNameOf(prev, c)));
  const n = new Set(next.classes.map(c => displayNameOf(next, c)));
  return {
    added: [...n].filter(c => !p.has(c)),
    removed: [...p].filter(c => !n.has(c)),
  };
}
