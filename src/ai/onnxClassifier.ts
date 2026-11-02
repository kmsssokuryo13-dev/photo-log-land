// onnxruntime-web（WASM / CPU）による画像分類
// WASM 本体はビルド成果物に同梱し、推論時に外部へ通信しない。

import type { InferenceSession } from 'onnxruntime-web';
import type { ModelConfig } from './modelConfig';
import { toCandidates, type Candidate } from './postprocess';
import { preprocessImage } from './preprocess';

type Ort = typeof import('onnxruntime-web/wasm');

let ortPromise: Promise<Ort> | null = null;

/** onnxruntime-web を必要になった時点で読み込む（AIを使わない場合は読み込まない） */
export function loadOrt(): Promise<Ort> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const [ort, wasm] = await Promise.all([
        import('onnxruntime-web/wasm'),
        import('onnxruntime-web/ort-wasm-simd-threaded.wasm?url'),
      ]);
      // 同梱した WASM を使う（CDN から取得しない）
      ort.env.wasm.wasmPaths = { wasm: wasm.default };
      // GitHub Pages はクロスオリジン分離ヘッダーを付けられないため、単一スレッドで動かす
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      return ort;
    })();
    ortPromise.catch(() => { ortPromise = null; });
  }
  return ortPromise;
}

export interface CompatibilityResult {
  inputName: string;
  outputName: string;
  outputSize: number;
}

export class OnnxClassifier {
  private ort: Ort;
  private session: InferenceSession;
  readonly config: ModelConfig;
  readonly inputName: string;
  readonly outputName: string;
  private queue: Promise<unknown> = Promise.resolve();
  private disposed = false;

  private constructor(ort: Ort, session: InferenceSession, config: ModelConfig, inputName: string, outputName: string) {
    this.ort = ort;
    this.session = session;
    this.config = config;
    this.inputName = inputName;
    this.outputName = outputName;
  }

  /**
   * モデルを読み込み、設定ファイルとの互換性を検証する。
   * 入力名・出力名の存在、指定サイズでの試行推論、出力数とクラス数の一致を確認する。
   * 失敗した場合は例外（呼び出し側は旧モデルを使い続ける）。
   */
  static async load(modelBytes: ArrayBuffer, config: ModelConfig): Promise<{ classifier: OnnxClassifier; compatibility: CompatibilityResult }> {
    const ort = await loadOrt();
    let session: InferenceSession;
    try {
      session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    } catch (e) {
      throw new Error(`モデルを読み込めません（ファイルの破損・形式違いの可能性）: ${errorText(e)}`, { cause: e });
    }
    try {
      const inputName = config.input.name ?? session.inputNames[0];
      const outputName = config.output.name ?? session.outputNames[0];
      if (!session.inputNames.includes(inputName)) throw new Error(`入力「${inputName}」がモデルにありません（モデルの入力: ${session.inputNames.join(', ')}）`);
      if (!session.outputNames.includes(outputName)) throw new Error(`出力「${outputName}」がモデルにありません（モデルの出力: ${session.outputNames.join(', ')}）`);
      const classifier = new OnnxClassifier(ort, session, config, inputName, outputName);
      // 試行推論：パディング色だけの画像
      const { width, height } = config.input;
      const pre = config.preprocess;
      const data = new Float32Array(3 * width * height);
      const plane = width * height;
      const order = pre.channelOrder === 'BGR' ? [2, 1, 0] : [0, 1, 2];
      for (let c = 0; c < 3; c++) data.fill((pre.padColor[order[c]] / pre.scale - pre.mean[c]) / pre.std[c], c * plane, (c + 1) * plane);
      const raw = await classifier.runRaw(data, [1, 3, height, width]);
      toCandidates(raw, config); // 出力数・数値の検証
      return { classifier, compatibility: { inputName, outputName, outputSize: raw.length } };
    } catch (e) {
      await session.release().catch(() => undefined);
      throw new Error(`互換性検証に失敗: ${errorText(e)}`, { cause: e });
    }
  }

  private runRaw(data: Float32Array, dims: readonly number[]): Promise<Float32Array> {
    // 同じセッションで同時に推論しないよう直列化する
    const job = this.queue.then(async () => {
      if (this.disposed) throw new Error('モデルは解放済みです');
      const tensor = new this.ort.Tensor('float32', data, dims);
      const result = await this.session.run({ [this.inputName]: tensor });
      const out = result[this.outputName];
      if (!out) throw new Error(`出力「${this.outputName}」が得られません`);
      if (out.type !== 'float32') throw new Error(`出力の型 ${out.type} は未対応です`);
      return out.data as Float32Array;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  /** 元の写真ファイル（圧縮前）を分類し、上位候補を返す */
  async classify(file: Blob): Promise<Candidate[]> {
    const { data, dims } = await preprocessImage(file, this.config);
    const raw = await this.runRaw(data, dims);
    return toCandidates(raw, this.config);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.queue;
    await this.session.release().catch(() => undefined);
  }
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
