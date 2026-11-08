import { useState, useMemo, useEffect, useRef } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import {
  Camera, Settings2, Image, LayoutGrid, Upload, FolderOpen,
  PlusCircle, GripVertical, Trash2, X, AlertCircle,
  Calendar, Printer, Send
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useOnnxModels, type OnnxPrediction } from './ai/useOnnxModels';
import { ModelManager } from './ai/ModelManager';
import { PredictionBadge } from './ai/PredictionBadge';
import { addNewDefaults, DEFAULT_MARK_TYPES } from './utils/markTypes';
import { aiTargetFiles, applyAutoFill, applyPrediction, isAiTargetView, predictionForPoint } from './ai/pointPrediction';
import { isoDate, readHandoffRef, receiveFromSurvia, sendMarksToSurvia, stripHandoffRef, type SurviaRef } from './utils/surviaHandoff';
import { COMPRESSION_MODES, compressImage, isImageFile, mapPool, type CompressionModeKey } from './utils/imageLoad';
import { clearWork, deleteOriginals, loadOriginals, loadWork, putOriginal, saveWork } from './utils/workStore';

// --- 定数 ---

const DEFAULT_LEDGER_TYPES = ["境界標識設置写真", "器械点設置写真", "測点写真"];

type ViewId = 'far' | 'middle' | 'close' | 'macro';
const VIEW_TYPES: { id: ViewId; label: string }[] = [
  { id: 'far', label: '遠景' },
  { id: 'middle', label: '中景' },
  { id: 'close', label: '近景' },
  { id: 'macro', label: 'マクロ' }
];

// --- 型定義 ---

interface FileData {
  id: string;
  fileName: string;
  baseName: string;
  viewType: ViewId;
  direction: number;
  url: string;
  lastModified: string;
  modifiedMs?: number; // 撮影日（ファイルの更新日時）。SURVIA へ戻すときに使う
  onnx?: OnnxPrediction; // PC内AIの候補（しきい値以上なら「未設定」の標識へ自動入力）
}

interface BoundaryPoint {
  id: string;
  pointName: string;
  markType: string;
  markSource?: 'ai'; // AI が自動入力した標識（手で選び直すと消える）
  directions: Record<number, Partial<Record<ViewId, FileData>>>;
  selectedDirection: number;
  notes: string;
}

interface LedgerSettings {
  ledgerType: string;
  customLedgerType: string;
  siteName: string;
}

type ViewVisibility = Record<ViewId, boolean>;

// --- アイコンマッピング ---

const ICON_MAP: Record<string, LucideIcon> = {
  Camera, Settings2, Image, LayoutGrid, Upload, FolderOpen,
  PlusCircle, GripVertical, Trash2, X, AlertCircle,
  Calendar, Printer, Send
};

function Icon({ name, size = 20, className = "" }: { name: string; size?: number; className?: string }) {
  const LucideIconComponent = ICON_MAP[name];
  if (!LucideIconComponent) return null;
  return <LucideIconComponent size={size} className={className} />;
}

// --- ユーティリティ ---

function getStorageItem<T>(key: string, initialValue: T): T {
  try {
    const item = window.localStorage.getItem(key);
    return item ? JSON.parse(item) as T : initialValue;
  } catch { return initialValue; }
}

function setStorageItem<T>(key: string, value: T): void {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

function parseFileName(fileName: string): { baseName: string; viewType: ViewId; direction: number } {
  const nameWithoutExt = fileName.substring(0, fileName.lastIndexOf('.')) || fileName;
  const pattern = /^(.*?)(\.?)(遠景|近景|中景|マクロ|[EKMC])(\d*)$/i;
  const match = nameWithoutExt.match(pattern);
  let baseName: string;
  let viewType: ViewId = 'far';
  let direction = 1;
  if (match) {
    baseName = match[1];
    const typeKeyword = match[3].toUpperCase();
    if (typeKeyword === 'E' || typeKeyword === '遠景') viewType = 'far';
    else if (typeKeyword === 'C' || typeKeyword === '中景') viewType = 'middle';
    else if (typeKeyword === 'K' || typeKeyword === '近景') viewType = 'close';
    else if (typeKeyword === 'M' || typeKeyword === 'マクロ') viewType = 'macro';
    direction = match[4] ? parseInt(match[4], 10) : 1;
  } else {
    baseName = nameWithoutExt;
  }
  return { baseName, viewType, direction };
}

function newFileId(): string {
  return Math.random().toString(36).substr(2, 9);
}

// --- メインアプリケーション ---

export default function App() {
  const [activeTab, setActiveTab] = useState<'import' | 'edit' | 'preview'>('import');
  const [points, setPoints] = useState<BoundaryPoint[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });

  // Settings with localStorage
  const [markTypes, setMarkTypes] = useState(() => addNewDefaults(getStorageItem('markTypes', DEFAULT_MARK_TYPES), getStorageItem<string[] | null>('markTypeDefaults', null)));
  const [itemsPerPage, setItemsPerPage] = useState(() => getStorageItem('itemsPerPage', 3));
  const [showDate, setShowDate] = useState(() => getStorageItem('showDate', false));
  const [compressionMode, setCompressionMode] = useState<CompressionModeKey>(() => getStorageItem('compressionMode', 'medium'));
  const [ledgerSettings, setLedgerSettings] = useState<LedgerSettings>(() => getStorageItem('ledgerSettings', {
    ledgerType: DEFAULT_LEDGER_TYPES[0],
    customLedgerType: '',
    siteName: ''
  }));
  const [viewVisibility, setViewVisibility] = useState<ViewVisibility>(() => getStorageItem('viewVisibility', { far: true, middle: false, close: true, macro: false }));

  const [errorMessage, setErrorMessage] = useState("");
  const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);
  const [newMarkType, setNewMarkType] = useState("");

  // PC内AI（ONNX）。判別し直せるよう、近景写真の元ファイル（圧縮前）への参照を保持する
  const ai = useOnnxModels();
  const originalFilesRef = useRef(new Map<string, File>());
  const [reclassifying, setReclassifying] = useState(false);

  // localStorage sync
  // Gemini 判別は廃止（2026-11-05 ユーザー決定）。以前保存した API キーを PC に残さない
  useEffect(() => { try { window.localStorage.removeItem('apiKey'); } catch { /* ignore */ } }, []);
  useEffect(() => setStorageItem('markTypes', markTypes), [markTypes]);
  useEffect(() => setStorageItem('markTypeDefaults', DEFAULT_MARK_TYPES), []);
  useEffect(() => setStorageItem('itemsPerPage', itemsPerPage), [itemsPerPage]);
  useEffect(() => setStorageItem('showDate', showDate), [showDate]);
  useEffect(() => setStorageItem('compressionMode', compressionMode), [compressionMode]);
  useEffect(() => setStorageItem('ledgerSettings', ledgerSettings), [ledgerSettings]);
  useEffect(() => setStorageItem('viewVisibility', viewVisibility), [viewVisibility]);

  const handleAddMarkType = () => {
    if (newMarkType && !markTypes.includes(newMarkType)) {
      setMarkTypes([...markTypes, newMarkType]);
      setNewMarkType("");
    }
  };

  const handleDeleteMarkType = (type: string) => {
    if (confirm(`「${type}」を削除しますか？`)) {
      setMarkTypes(markTypes.filter(t => t !== type));
    }
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = ''; // 同じファイルをもう一度選んでも読み込めるように
    const { skipped } = await addFiles(files);
    if (skipped > 0) setNotice(`読めないファイル ${skipped} 件は飛ばしました`);
  };

  /** 近景の元写真を手放す（メモリと自動保存の両方から） */
  const dropOriginals = (ids: string[]) => {
    ids.forEach(id => originalFilesRef.current.delete(id));
    void deleteOriginals(ids).catch(() => undefined);
  };

  /**
   * 写真を読み込む（ファイル選択・フォルダ読込・SURVIA から）。marks は SURVIA の境界標（標識が未設定の点に入れる）。
   * 画像以外・画像として開けないファイルは飛ばし、その数を返す。圧縮は数枚ずつ同時に進める（AI 判別は1枚ずつ順番）。
   */
  const addFiles = async (all: File[], marks: { name: string; markType: string }[] = []): Promise<{ added: number; skipped: number }> => {
    const files = all.filter(isImageFile);
    if (files.length === 0) return { added: 0, skipped: all.length };
    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: files.length });
    let finished = 0;
    const results = await mapPool(files, 4, async (file): Promise<FileData | null> => {
      const { baseName, viewType, direction } = parseFileName(file.name);
      const id = newFileId();
      const aiTarget = isAiTargetView(viewType);
      try {
        // 近景のみ、圧縮前の元画像でPC内AI判別（失敗しても読込は続行）
        const [compressedUrl, prediction] = await Promise.all([
          compressImage(file, compressionMode),
          aiTarget ? ai.classify(file).catch(() => null) : Promise.resolve(null),
        ]);
        if (aiTarget) {
          originalFilesRef.current.set(id, file);
          void putOriginal(id, file).catch(() => undefined);
        }
        return {
          id,
          fileName: file.name, baseName, viewType, direction, url: compressedUrl,
          lastModified: new Date(file.lastModified).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          modifiedMs: file.lastModified,
          onnx: prediction ?? undefined
        };
      } catch {
        return null; // 画像として開けない（HEIC など）
      } finally {
        finished++;
        setProcessingProgress(prev => ({ ...prev, current: finished }));
      }
    });
    const newFileData = results.filter((x): x is FileData => x !== null);
    setPoints(prev => {
      const updated = [...prev];
      const replacedIds: string[] = [];
      newFileData.forEach(data => {
        const idx = updated.findIndex(p => p.pointName === data.baseName);
        if (idx > -1) {
          const point = updated[idx];
          const views = point.directions[data.direction] || {};
          const replaced = views[data.viewType];
          if (replaced && replaced.id !== data.id) replacedIds.push(replaced.id);
          updated[idx] = { ...point, directions: { ...point.directions, [data.direction]: { ...views, [data.viewType]: data } } };
        } else {
          updated.push({
            id: newFileId(),
            pointName: data.baseName, markType: "未設定",
            directions: { [data.direction]: { [data.viewType]: data } },
            selectedDirection: data.direction, notes: ""
          });
        }
      });
      if (replacedIds.length) dropOriginals(replacedIds);
      // SURVIA の境界標（同じ点名で、標識が未設定の点だけ）。AI の自動入力より優先
      const withMarks = updated.map(p => {
        const m = marks.find(x => x.markType && x.name.normalize('NFKC').trim() === p.pointName.normalize('NFKC').trim());
        return m && p.markType === "未設定" ? { ...p, markType: m.markType } : p;
      });
      return applyAutoFill(withMarks, markTypes, ai.currentModelId());
    });
    setIsProcessing(false);
    if (newFileData.length > 0) setActiveTab('edit');
    return { added: newFileData.length, skipped: all.length - newFileData.length };
  };

  // SURVIA から開かれたとき: 写真・現場名・境界標を受け取る（1回だけ。受け渡し口の場所はすぐ URL から消す）
  const [survia] = useState<SurviaRef | null>(() => readHandoffRef(window.location.hash));
  const [notice, setNotice] = useState("");
  // 知らせは数秒で消す（プレビューの印刷ボタンに重ならないように）
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);
  const [sending, setSending] = useState(false);
  const surviaStarted = useRef(false);
  useEffect(() => {
    if (surviaStarted.current) return;
    surviaStarted.current = true;
    const ref = survia;
    if (!ref) return;
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${stripHandoffRef(window.location.hash)}`);
    void (async () => {
      try {
        const got = await receiveFromSurvia(ref);
        if (got.siteName) setLedgerSettings(s => ({ ...s, siteName: got.siteName }));
        // SURVIA の案件で始め直す（前回の自動保存は使わない）
        await clearWork().catch(() => undefined);
        const { added, skipped } = await addFiles(got.files, got.marks);
        setNotice(`SURVIA から写真 ${added} 枚を受け取りました${skipped ? `（${skipped} 件は読めず）` : ''}`);
      } catch (e) {
        setErrorMessage(e instanceof Error ? e.message : String(e));
      }
    })();
    // 最初の1回だけ（addFiles は毎回作り直されるが、受け取りは1回）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 作業の自動保存。起動時に前回の作業を開き、それ以降の変更を保存する（SURVIA から開いたときは前回分を開かない）
  // 前回分を読めなかったときは保存しない（空で上書きして前回分を消さないため）
  const [workLoaded, setWorkLoaded] = useState(false);
  const saveFailedShown = useRef(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (survia) { setWorkLoaded(true); return; }
      let pts: BoundaryPoint[];
      try {
        pts = (await loadWork<BoundaryPoint>())?.points ?? [];
      } catch {
        return; // 保存先が使えない環境では自動保存なしで使う
      }
      if (cancelled) return;
      // 元写真が読めなくても作業本体は開く（再判別できないだけ）
      try {
        const originals = await loadOriginals();
        if (cancelled) return;
        const keep = new Set(aiTargetFiles(pts).map(fd => fd.id));
        const stale: string[] = [];
        originals.forEach((file, id) => { if (keep.has(id)) originalFilesRef.current.set(id, file); else stale.push(id); });
        void deleteOriginals(stale).catch(() => undefined);
      } catch { /* ignore */ }
      if (pts.length > 0) {
        setPoints(prev => prev.length > 0 ? prev : pts);
        setActiveTab('edit');
        setNotice('前回の作業を開きました');
      }
      setWorkLoaded(true);
    })();
    return () => { cancelled = true; };
  }, [survia]);
  useEffect(() => {
    if (!workLoaded) return;
    const t = window.setTimeout(() => {
      saveWork(points).then(() => { saveFailedShown.current = false; }, () => {
        if (saveFailedShown.current) return;
        saveFailedShown.current = true;
        setErrorMessage('自動保存できません（PCの空き容量を確認してください）');
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [points, workLoaded]);

  /** 作業中の点と写真をすべて消して、新しく始める */
  const clearAll = () => {
    if (points.length === 0 || !confirm('作業中の点と写真をすべて消しますか？')) return;
    originalFilesRef.current.clear();
    setPoints([]);
    void clearWork().catch(() => undefined);
    setActiveTab('import');
  };

  /** 台帳の点名・標識・撮影日（左・右の写真）を SURVIA へ戻す。 */
  const sendToSurvia = async () => {
    if (!survia || sending) return;
    const [left, right] = VIEW_TYPES.filter(vt => viewVisibility[vt.id]);
    const sent = points.filter(p => p.pointName.trim()).map(p => {
      const dir = p.directions[p.selectedDirection] || {};
      return {
        name: p.pointName, markType: p.markType === "未設定" ? "" : p.markType,
        photoDates: [isoDate(left && dir[left.id]?.modifiedMs), isoDate(right && dir[right.id]?.modifiedMs)] as [string, string],
      };
    });
    setSending(true);
    setErrorMessage("");
    try {
      const n = await sendMarksToSurvia(survia, sent);
      setNotice(`SURVIA へ ${n} 点を戻しました`);
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  // 近景写真は読込時に元ファイルを保持している（再判別の対象）
  const reclassifyTargets = aiTargetFiles(points);

  const reclassifyAll = async () => {
    if (reclassifying) return;
    setReclassifying(true);
    try {
      for (const fd of reclassifyTargets) {
        const file = originalFilesRef.current.get(fd.id);
        if (!file) continue;
        const prediction = (await ai.classify(file).catch(() => null)) ?? undefined;
        setPoints(prev => applyAutoFill(applyPrediction(prev, fd.id, prediction), markTypes, ai.currentModelId()));
      }
    } finally {
      setReclassifying(false);
    }
  };

  const addCalculationPoint = () => {
    const newPoint: BoundaryPoint = {
      id: Math.random().toString(36).substr(2, 9),
      pointName: "",
      markType: "計算点",
      directions: { 1: {} },
      selectedDirection: 1,
      notes: ""
    };
    setPoints(prev => [...prev, newPoint]);
  };

  const handleDragStart = (e: DragEvent<HTMLDivElement>, index: number) => { setDraggedItemIndex(index); e.dataTransfer.effectAllowed = "move"; };
  const handleDragOver = (e: DragEvent<HTMLDivElement>, index: number) => {
    e.preventDefault();
    if (draggedItemIndex === null || draggedItemIndex === index) return;
    const newPoints = [...points];
    const item = newPoints.splice(draggedItemIndex, 1)[0];
    newPoints.splice(index, 0, item);
    setDraggedItemIndex(index);
    setPoints(newPoints);
  };

  const updatePoint = (id: string, updates: Partial<BoundaryPoint>) => setPoints(prev => prev.map(p => p.id === id ? { ...p, ...updates } : p));
  const deletePoint = (id: string) => {
    const target = points.find(p => p.id === id);
    if (target) dropOriginals(aiTargetFiles([target]).map(fd => fd.id));
    setPoints(prev => prev.filter(p => p.id !== id));
  };

  const chunkedPoints = useMemo(() => {
    const chunks: BoundaryPoint[][] = [];
    for (let i = 0; i < points.length; i += itemsPerPage) chunks.push(points.slice(i, i + itemsPerPage));
    return chunks;
  }, [points, itemsPerPage]);

  const displayLedgerName = ledgerSettings.ledgerType === "その他" ? ledgerSettings.customLedgerType : ledgerSettings.ledgerType;
  const enabledViewTypes = VIEW_TYPES.filter(vt => viewVisibility[vt.id]);

  // --- ファイル入力のref ---
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex flex-col h-full print:h-auto">
      {errorMessage && (
        <div className="no-print fixed top-16 left-1/2 -translate-x-1/2 z-[100] bg-red-600 text-white px-6 py-3 rounded-2xl shadow-xl flex items-center gap-3">
          <Icon name="AlertCircle" size={18} /><span className="text-sm font-bold">{errorMessage}</span>
          <button onClick={() => setErrorMessage("")} className="hover:bg-red-700 p-1 rounded">×</button>
        </div>
      )}

      {notice && (
        <div className="no-print fixed top-16 left-1/2 -translate-x-1/2 z-[100] bg-blue-600 text-white px-6 py-3 rounded-2xl shadow-xl flex items-center gap-3" role="status">
          <span className="text-sm font-bold">{notice}</span>
          <button onClick={() => setNotice("")} className="hover:bg-blue-700 p-1 rounded">×</button>
        </div>
      )}

      <header className="bg-white border-b border-slate-200 px-6 py-2 flex items-center justify-between no-print shrink-0">
        <div className="flex items-center gap-2">
          <div className="bg-blue-600 p-1 rounded-lg"><Icon name="Camera" size={18} className="text-white" /></div>
          <h1 className="font-bold text-slate-800 text-sm">境界点写真管理</h1>
        </div>
        <nav className="flex bg-slate-100 p-1 rounded-xl">
          {(['import', 'edit', 'preview'] as const).map(tab => (
            <button key={tab} onClick={() => setActiveTab(tab)} className={`px-5 py-1.5 rounded-lg text-xs font-bold transition ${activeTab === tab ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-500'}`}>
              {tab === 'import' ? '読込' : tab === 'edit' ? '編集' : 'プレビュー'}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2">
        {survia && (
          <button onClick={sendToSurvia} disabled={sending || points.length === 0} title="点名・標識・撮影日を SURVIA へ" className="bg-blue-600 text-white px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-blue-700 flex items-center gap-2 disabled:opacity-50">
            <Icon name="Send" size={14} /> SURVIAへ戻す
          </button>
        )}
        </div>
      </header>

      <main className="flex-1 overflow-hidden print:overflow-visible print:block relative">
        {isProcessing && (
          <div className="absolute inset-0 z-50 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center">
            <div className="bg-white p-8 rounded-3xl shadow-2xl flex flex-col items-center gap-4">
              <div className="w-10 h-10 border-4 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
              <p className="font-bold text-sm">最適化中 ({processingProgress.current}/{processingProgress.total})</p>
            </div>
          </div>
        )}

        {/* === 読込タブ === */}
        {activeTab === 'import' && (
          <div className="overflow-y-auto h-full p-8 max-w-5xl mx-auto space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* 基本設定 */}
              <div className="bg-white p-5 rounded-2xl border shadow-sm space-y-3">
                <h2 className="text-xs font-black text-slate-400 uppercase flex items-center gap-2"><Icon name="Settings2" size={14} />基本設定</h2>
                <select value={ledgerSettings.ledgerType} onChange={e => setLedgerSettings({ ...ledgerSettings, ledgerType: e.target.value })} className="w-full bg-slate-50 border rounded-lg px-3 py-2 text-sm font-bold">
                  {DEFAULT_LEDGER_TYPES.map(t => <option key={t}>{t}</option>)}<option>その他</option>
                </select>
                {ledgerSettings.ledgerType === "その他" && <input type="text" value={ledgerSettings.customLedgerType} onChange={e => setLedgerSettings({ ...ledgerSettings, customLedgerType: e.target.value })} className="w-full bg-slate-50 border rounded-lg px-3 py-2 text-sm font-bold" placeholder="台帳名を入力" />}
                <input type="text" value={ledgerSettings.siteName} onChange={e => setLedgerSettings({ ...ledgerSettings, siteName: e.target.value })} className="w-full bg-slate-50 border rounded-lg px-3 py-2 text-sm font-bold" placeholder="現場名称" />
                <div className="mt-4 pt-4 border-t">
                  <label className="text-xs font-bold text-slate-400 block mb-2">標識リスト</label>
                  <div className="flex gap-1 mb-2">
                    <input type="text" value={newMarkType} onChange={e => setNewMarkType(e.target.value)} placeholder="追加" className="flex-1 bg-slate-50 border rounded px-2 py-1 text-sm font-bold" />
                    <button onClick={handleAddMarkType} className="bg-blue-600 text-white px-2 rounded text-xs font-bold">追加</button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {markTypes.map(t => <span key={t} className="px-2 py-0.5 bg-slate-100 border rounded text-xs font-bold flex items-center gap-1">{t}<button onClick={() => handleDeleteMarkType(t)}><Icon name="X" size={10} /></button></span>)}
                  </div>
                </div>
              </div>
              {/* 画質設定 */}
              <div className="bg-white p-5 rounded-2xl border shadow-sm space-y-3">
                <h2 className="text-xs font-black text-slate-400 uppercase flex items-center gap-2"><Icon name="Image" size={14} />画質設定</h2>
                {(Object.entries(COMPRESSION_MODES) as [CompressionModeKey, typeof COMPRESSION_MODES[CompressionModeKey]][]).map(([k, v]) => <button key={k} onClick={() => setCompressionMode(k)} className={`w-full text-left p-2 rounded-lg border text-sm font-bold transition ${compressionMode === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 border-slate-200'}`}>{v.label}</button>)}
              </div>
              {/* 表示設定 */}
              <div className="bg-white p-5 rounded-2xl border shadow-sm space-y-3">
                <h2 className="text-xs font-black text-slate-400 uppercase flex items-center gap-2"><Icon name="LayoutGrid" size={14} />表示設定</h2>
                <div className="flex gap-2">{[1, 2, 3].map(n => <button key={n} onClick={() => setItemsPerPage(n)} className={`flex-1 py-1 rounded-lg border text-sm font-bold ${itemsPerPage === n ? 'bg-blue-600 text-white' : 'bg-slate-50'}`}>{n}点/頁</button>)}</div>
                <button onClick={() => setShowDate(!showDate)} className={`w-full py-1.5 rounded-lg text-sm font-bold border flex items-center justify-center gap-2 transition ${showDate ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-400'}`}><Icon name="Calendar" size={12} /> 撮影日: {showDate ? 'ON' : 'OFF'}</button>
                <div className="grid grid-cols-2 gap-2 mt-2">{VIEW_TYPES.map(vt => <button key={vt.id} onClick={() => setViewVisibility(v => ({ ...v, [vt.id]: !v[vt.id] }))} className={`px-2 py-1 border rounded text-sm font-bold flex justify-between items-center transition ${viewVisibility[vt.id] ? 'border-blue-300 bg-blue-50 text-blue-700' : 'text-slate-400 bg-slate-50'}`}>{vt.label}<span>{viewVisibility[vt.id] ? '●' : '○'}</span></button>)}</div>
              </div>
            </div>
            <ModelManager ai={ai} onReclassify={reclassifyAll} reclassifyCount={reclassifyTargets.length} reclassifying={reclassifying} />
            <div className="grid grid-cols-2 gap-6">
              <label className="flex flex-col items-center justify-center border-4 border-dashed border-slate-200 bg-white rounded-3xl p-12 cursor-pointer hover:border-blue-400 group transition">
                <Icon name="Upload" size={48} className="text-slate-200 mb-2 group-hover:text-blue-200" />
                <span className="font-bold text-slate-400 text-sm">ファイル選択</span>
                <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileUpload} accept="image/*" />
              </label>
              <label className="flex flex-col items-center justify-center border-4 border-dashed border-slate-200 bg-white rounded-3xl p-12 cursor-pointer hover:border-blue-400 group transition">
                <Icon name="FolderOpen" size={48} className="text-slate-200 mb-2 group-hover:text-blue-200" />
                <span className="font-bold text-slate-400 text-sm">フォルダ読込</span>
                {/* @ts-expect-error webkitdirectory is a non-standard attribute */}
                <input ref={folderInputRef} type="file" webkitdirectory="true" className="hidden" onChange={handleFileUpload} />
              </label>
            </div>
          </div>
        )}

        {/* === 編集タブ === */}
        {activeTab === 'edit' && (
          <div className="flex h-full no-print bg-slate-100">
            <aside className="w-56 border-r bg-white overflow-hidden flex flex-col shrink-0">
              <div className="p-3 border-b flex flex-col gap-2">
                <button onClick={addCalculationPoint} className="w-full bg-slate-900 text-white py-2 rounded-lg text-[10px] font-bold flex items-center justify-center gap-2 hover:bg-slate-800 transition">
                  <Icon name="PlusCircle" size={14} /> 計算点を追加
                </button>
                <button onClick={clearAll} disabled={points.length === 0} title="作業中の点と写真をすべて消して新しく始めます" className="w-full border border-slate-200 text-slate-500 py-1.5 rounded-lg text-[10px] font-bold flex items-center justify-center gap-2 hover:border-red-300 hover:text-red-500 transition disabled:opacity-40">
                  <Icon name="Trash2" size={12} /> すべて消去
                </button>
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {points.map((p, i) => (
                  <div key={p.id} draggable onDragStart={e => handleDragStart(e, i)} onDragOver={e => handleDragOver(e, i)} onDragEnd={() => setDraggedItemIndex(null)} className={`text-[10px] font-bold p-2 bg-slate-50 border rounded truncate flex items-center gap-2 cursor-grab transition-colors ${draggedItemIndex === i ? 'drag-ghost' : 'hover:border-blue-300 hover:bg-blue-50'}`}>
                    <Icon name="GripVertical" size={12} className="text-slate-300" />
                    <span className="truncate">{p.pointName || "(未入力)"}</span>
                    {p.markType === "計算点" && <span className="ml-auto text-[8px] bg-slate-200 px-1 rounded">計</span>}
                    {p.markSource === 'ai' && <span className="ml-auto text-[8px] bg-emerald-100 text-emerald-700 px-1 rounded" title="AIが自動入力">AI</span>}
                  </div>
                ))}
              </div>
            </aside>
            <section className="flex-1 overflow-y-auto p-6 space-y-4">
              {points.map(point => {
                const dirData = point.directions[point.selectedDirection] || {};
                const prediction = predictionForPoint(point);
                const aiFilled = point.markSource === 'ai';
                const aiScore = prediction?.status === 'ok' ? prediction.candidates[0]?.score : undefined;
                return (
                  <div key={point.id} className="bg-white rounded-xl border shadow-sm p-4 transition">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-4">
                        <div className="flex flex-col">
                          <span className="text-[9px] font-bold text-slate-400">点名</span>
                          <input type="text" value={point.pointName} onChange={e => updatePoint(point.id, { pointName: e.target.value })} className="text-sm font-black bg-transparent border-b-2 border-transparent focus:border-blue-500 focus:outline-none w-32 px-1" />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] font-bold text-slate-400">標識</span>
                          <div className="flex items-center gap-2">
                            <select value={point.markType} onChange={e => updatePoint(point.id, { markType: e.target.value, markSource: undefined })} title={aiFilled ? `AIが自動入力${aiScore !== undefined ? `（${Math.round(aiScore * 100)}%）` : ''}。選び直すと手入力になります` : undefined} data-testid="mark-select" data-ai-filled={aiFilled ? 'true' : undefined} className={`border rounded px-2 py-1 text-xs font-bold h-8 ${aiFilled ? 'bg-emerald-50 border-emerald-400 text-emerald-800' : 'bg-slate-50'}`}>
                              <option value="未設定">未設定</option>
                              {markTypes.map(t => <option key={t}>{t}</option>)}
                              {point.markType !== "未設定" && !markTypes.includes(point.markType) && <option key={point.markType}>{point.markType}</option>}
                            </select>
                            {point.markType !== "計算点" && <PredictionBadge prediction={prediction} markTypes={markTypes} activeModelId={ai.activeId} />}
                          </div>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] font-bold text-slate-400">備考</span>
                          <input type="text" value={point.notes} onChange={e => updatePoint(point.id, { notes: e.target.value })} title="台帳の点名の横に印刷されます" data-testid="notes-input" className="text-xs font-bold bg-slate-50 border rounded px-2 h-8 w-48 focus:border-blue-500 focus:outline-none" />
                        </div>
                      </div>
                      <div className="flex gap-1 items-center">
                        {Object.keys(point.directions).sort((a, b) => Number(a) - Number(b)).map(d => (
                          <button key={d} onClick={() => updatePoint(point.id, { selectedDirection: parseInt(d) })} className={`px-3 py-1 rounded border text-[10px] font-bold transition ${point.selectedDirection === parseInt(d) ? 'bg-blue-600 text-white' : 'bg-white text-slate-400'}`}>方向 {d}</button>
                        ))}
                        <button onClick={() => deletePoint(point.id)} className="ml-2 text-slate-300 hover:text-red-500"><Icon name="Trash2" size={16} /></button>
                      </div>
                    </div>
                    <div className="grid grid-cols-4 gap-2 bg-slate-900 p-2 rounded-lg">
                      {enabledViewTypes.map(vt => (
                        <div key={vt.id} className="aspect-[4/3] bg-black/40 rounded flex items-center justify-center overflow-hidden relative border border-white/5">
                          {dirData[vt.id] ? <img src={dirData[vt.id]!.url} className="max-h-full max-w-full object-contain" /> : <Icon name="Camera" size={24} className="text-white/10" />}
                          <span className="absolute top-1 left-1 text-[8px] text-white bg-black/50 px-1 rounded font-bold uppercase">{vt.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </section>
          </div>
        )}

        {/* === プレビュータブ === */}
        {activeTab === 'preview' && (
          <div className="h-full overflow-y-auto p-8 bg-slate-300/50 flex flex-col items-center gap-6 print:p-0 print:bg-white print:block">
            <button onClick={() => window.print()} className="no-print bg-slate-900 text-white px-10 py-2.5 rounded-xl font-bold flex items-center gap-2 shadow-lg hover:bg-slate-800 transition">
              <Icon name="Printer" size={18} /> 印刷画面を開く
            </button>
            <div className="a4-page-container print:block">
              {chunkedPoints.map((pagePoints, pi) => (
                <div key={pi} className="a4-sheet bg-white shadow-2xl flex flex-col print:shadow-none mb-8 print:mb-0">
                  <div className="border-b-2 border-black pb-1 flex justify-between items-baseline mb-4 shrink-0">
                    <h1 className="text-xl font-black">{displayLedgerName || "境界点写真台帳"}</h1>
                    <span className="text-xs font-bold">現場名: {ledgerSettings.siteName || "---"}</span>
                  </div>
                  <div className="flex-1 space-y-2 min-h-0">
                    {pagePoints.map(p => {
                      const dirData = p.directions[p.selectedDirection] || {};
                      const representative = Object.values(dirData)[0];
                      return (
                        <div key={p.id} className={`point-card-box border border-black flex flex-col overflow-hidden ${itemsPerPage === 1 ? 'h-[230mm]' : itemsPerPage === 2 ? 'h-[110mm]' : 'h-[75mm]'}`}>
                          <div className="bg-slate-50 px-3 py-1 border-b border-black flex justify-between items-center shrink-0">
                            <div className="flex items-center gap-6">
                              <span className="text-sm font-black">点名: {p.pointName || "---"}</span>
                              <span className="text-xs font-bold">標識: {p.markType}</span>
                              {p.notes && <span className="text-xs font-bold">備考: {p.notes}</span>}
                            </div>
                            {showDate && representative && <div className="text-[9px] font-bold text-slate-500">撮影日: {representative.lastModified}</div>}
                          </div>
                          <div className="p-1 flex-1 grid gap-1 min-h-0 overflow-hidden" style={{ gridTemplateColumns: `repeat(${enabledViewTypes.length === 1 ? 1 : 2}, minmax(0, 1fr))` }}>
                            {enabledViewTypes.map(vt => (
                              <div key={vt.id} className="border border-black flex flex-col overflow-hidden bg-white">
                                <div className="flex-1 flex items-center justify-center overflow-hidden">
                                  {dirData[vt.id] ? <img src={dirData[vt.id]!.url} className="max-h-full max-w-full object-contain" /> : null}
                                </div>
                                <div className="text-xs text-center bg-slate-50 border-t border-black font-black uppercase tracking-widest py-0.5">{vt.label}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[9px] text-right mt-2 text-slate-400 font-bold shrink-0">{pi + 1} / {chunkedPoints.length} ページ</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
