// 推論結果の後処理（純粋関数）

import { displayNameOf, type ModelConfig } from './modelConfig';

export interface Candidate {
  cls: string; // モデルのクラス名
  label: string; // 表示名
  score: number; // 0〜1
}

export function softmax(values: ArrayLike<number>): number[] {
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) max = Math.max(max, values[i]);
  const exps = Array.from(values, v => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(e => e / sum);
}

export function toCandidates(raw: ArrayLike<number>, config: ModelConfig): Candidate[] {
  if (raw.length !== config.classes.length) {
    throw new Error(`出力数(${raw.length})がクラス数(${config.classes.length})と一致しません`);
  }
  for (let i = 0; i < raw.length; i++) {
    if (!Number.isFinite(raw[i])) throw new Error('出力に数値でない値が含まれています');
  }
  const probs = config.output.type === 'logits' ? softmax(raw) : Array.from(raw);
  return probs
    .map((score, i) => ({ cls: config.classes[i], label: displayNameOf(config, config.classes[i]), score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, config.topK);
}
