// 境界標の種類（手動プルダウンの既定）。2026-11-05 ユーザー決定でマンホール中心を追加。
export const DEFAULT_MARK_TYPES = ["金属鋲", "金属標", "プラスチック杭", "コンクリート杭", "コンクリート角", "木杭", "刻印", "計算点", "真鍮標識", "マンホール中心"];

// これまでに配った既定（この版より前の PC は V1 の既定を受け取り済みとみなす）
const V1_DEFAULTS = ["金属鋲", "金属標", "プラスチック杭", "コンクリート杭", "コンクリート角", "木杭", "刻印", "計算点", "真鍮標識"];

/** 保存済みリストに、まだ配っていない新しい既定だけを末尾に足す。ユーザーが消した既定は戻さない。 */
export function addNewDefaults(stored: string[], offered: string[] | null): string[] {
  const seen = new Set(offered ?? V1_DEFAULTS);
  const add = DEFAULT_MARK_TYPES.filter(t => !seen.has(t) && !stored.includes(t));
  return add.length ? [...stored, ...add] : stored;
}
