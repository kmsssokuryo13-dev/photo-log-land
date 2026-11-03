// SURVIA の「写真台帳」→「土地」→「土地写真台帳で開く」から、案件の写真・現場名・境界標を受け取り、
// 台帳で入れた点名・標識・撮影日を SURVIA へ戻す。
// - SURVIA は自分の PC の中（127.0.0.1）に受け渡し口を開き、http://localhost:5178/#/?survia=<port>.<token> で開く。
//   受け渡し口の場所は URL の # の後ろ（サーバーに送られない）。読んだらすぐ URL から消す。
// - 受け渡し口は manifest（現場名・境界標・写真の名前と更新日時）・photo/<番号>（写真の中身）・marks（点の戻し）。
// - 写真は「ファイル選択」と同じ扱い（ファイル名で分類・圧縮・撮影日）にするため File にして渡す。

export const SURVIA_HANDOFF_KIND = 'survia-photo-land-handoff';
export const SURVIA_MARKS_KIND = 'survia-photo-land-marks';
const PARAM = 'survia';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_PHOTOS = 300;
const MAX_POINTS = 200;

export type SurviaRef = { port: number; token: string };
export type SurviaMark = { name: string; markType: string };
export type SurviaManifest = { siteName: string; marks: SurviaMark[]; photos: { index: number; name: string; modified: number }[] };
/** SURVIA へ戻す点。photoDates は左・右の写真の撮影日（YYYY-MM-DD か空）。 */
export type SurviaPoint = { name: string; markType: string; photoDates: [string, string] };

/** URL の # の後ろから受け渡し口を読む。形が違えば null。 */
export const readHandoffRef = (hash = ''): SurviaRef | null => {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const value = new URLSearchParams(hash.slice(q + 1)).get(PARAM);
  const m = /^(\d{4,5})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535 ? { port, token: m[2] } : null;
};

/** # の後ろから受け渡し口を消した形（ほかの値は残す）。 */
export const stripHandoffRef = (hash = '') => {
  const q = hash.indexOf('?');
  if (q < 0) return hash;
  const params = new URLSearchParams(hash.slice(q + 1));
  params.delete(PARAM);
  const rest = params.toString();
  const head = hash.slice(0, q);
  return rest ? `${head}?${rest}` : head === '#/' ? '' : head;
};

const base = ({ port, token }: SurviaRef) => `http://127.0.0.1:${port}/survia-photo/${token}/`;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** 受け取った一覧の形を確かめる（違えば null）。 */
export const parseManifest = (v: unknown): SurviaManifest | null => {
  if (!isObj(v) || v.kind !== SURVIA_HANDOFF_KIND || v.version !== 1 || !Array.isArray(v.photos) || !Array.isArray(v.marks)) return null;
  if (v.photos.length > MAX_PHOTOS || v.marks.length > MAX_POINTS || !text(v.siteName, 100)) return null;
  const marks: SurviaMark[] = [];
  for (const m of v.marks) {
    if (!isObj(m) || !text(m.name, 50) || !text(m.markType, 50)) return null;
    marks.push({ name: m.name, markType: m.markType });
  }
  const photos: SurviaManifest['photos'] = [];
  for (const p of v.photos) {
    if (!isObj(p) || !Number.isInteger(p.index) || typeof p.name !== 'string' || !/\.(jpe?g|png)$/i.test(p.name) || /[\\/]/.test(p.name)) return null;
    const modified = typeof p.modified === 'number' && Number.isFinite(p.modified) && p.modified > 0 ? p.modified : 0;
    photos.push({ index: p.index as number, name: p.name, modified });
  }
  return { siteName: v.siteName, marks, photos };
};

const get = async (url: string) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), cache: 'no-store' });
  if (!res.ok) throw new Error(`SURVIA から受け取れませんでした（${res.status}）`);
  return res;
};

/** SURVIA から一覧と写真を受け取る（写真は File にする。更新日時はファイルの更新日時＝撮影日。onProgress は受け取った枚数）。 */
export const receiveFromSurvia = async (ref: SurviaRef, onProgress?: (done: number, total: number) => void) => {
  const manifest = parseManifest(await (await get(`${base(ref)}manifest`)).json());
  if (!manifest) throw new Error('SURVIA から受け取った中身が不正です');
  const files: File[] = [];
  for (const p of manifest.photos) {
    const res = await get(`${base(ref)}photo/${p.index}`);
    const type = /\.png$/i.test(p.name) ? 'image/png' : 'image/jpeg';
    files.push(new File([await res.blob()], p.name, { type, ...(p.modified ? { lastModified: p.modified } : {}) }));
    onProgress?.(files.length, manifest.photos.length);
  }
  return { siteName: manifest.siteName, marks: manifest.marks, files };
};

/** 日付（ファイルの更新日時）を YYYY-MM-DD に（無ければ空）。 */
export const isoDate = (ms: number | undefined) => {
  if (!ms || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// eslint-disable-next-line no-control-regex
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 50);

/** 台帳で入れた点名・標識・撮影日を SURVIA へ戻す。戻した点の数を返す。 */
export const sendMarksToSurvia = async (ref: SurviaRef, points: SurviaPoint[]) => {
  let res: Response;
  try {
    res = await fetch(`${base(ref)}marks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: SURVIA_MARKS_KIND, version: 1, points: points.slice(0, MAX_POINTS).map((p) => ({ ...p, name: clean(p.name), markType: clean(p.markType) })) }),
    });
  } catch {
    throw new Error('SURVIA に届きません。SURVIA から開き直してください。');
  }
  const body: unknown = await res.json().catch(() => null);
  if (res.ok && isObj(body) && body.kind === 'received' && typeof body.count === 'number') return body.count;
  throw new Error(isObj(body) && typeof body.reason === 'string' ? body.reason : `戻せませんでした（${res.status}）`);
};
