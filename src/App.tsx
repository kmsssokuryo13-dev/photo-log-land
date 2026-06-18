import { useState, useMemo, useEffect, useRef } from 'react';
import type { DragEvent, ChangeEvent } from 'react';
import {
  Camera, Settings2, Image, LayoutGrid, Upload, FolderOpen,
  PlusCircle, GripVertical, Sparkles, Trash2, X, AlertCircle,
  Calendar, Printer
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

// --- 定数 ---

const INITIAL_MARK_TYPES = ["金属鋲", "金属標", "プラスチック杭", "コンクリート杭", "コンクリート角", "木杭", "刻印", "計算点", "真鍮標識"];
const DEFAULT_LEDGER_TYPES = ["境界標識設置写真", "器械点設置写真", "測点写真"];

type ViewId = 'far' | 'middle' | 'close' | 'macro';
const VIEW_TYPES: { id: ViewId; label: string }[] = [
  { id: 'far', label: '遠景' },
  { id: 'middle', label: '中景' },
  { id: 'close', label: '近景' },
  { id: 'macro', label: 'マクロ' }
];

type CompressionModeKey = 'original' | 'medium' | 'high';
const COMPRESSION_MODES: Record<CompressionModeKey, { label: string; maxDim: number; quality: number; desc: string }> = {
  original: { label: 'オリジナル', maxDim: Infinity, quality: 1.0, desc: '無加工' },
  medium: { label: '中圧縮', maxDim: 1600, quality: 0.8, desc: '14枚で4〜6MB' },
  high: { label: '高圧縮', maxDim: 1024, quality: 0.6, desc: '40枚で3〜5MB' }
};

// --- 型定義 ---

interface FileData {
  id: string;
  fileName: string;
  baseName: string;
  viewType: ViewId;
  direction: number;
  url: string;
  lastModified: string;
}

interface BoundaryPoint {
  id: string;
  pointName: string;
  markType: string;
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
  PlusCircle, GripVertical, Sparkles, Trash2, X, AlertCircle,
  Calendar, Printer
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

async function callGemini(payload: object, currentApiKey: string, retries = 5, delay = 1000): Promise<{ candidates?: { content?: { parts?: { text?: string }[] } }[] }> {
  if (!currentApiKey) throw new Error("APIキーが未設定です。");
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${currentApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error((data as { error?: { message?: string } }).error?.message || "Gemini APIエラー");
    }
    return await response.json();
  } catch (error) {
    if (retries > 0 && !(error instanceof Error && (error.message.includes("403") || error.message.includes("400")))) {
      await new Promise(r => setTimeout(r, delay));
      return callGemini(payload, currentApiKey, retries - 1, delay * 2);
    }
    throw error;
  }
}

function compressImage(file: File, mode: CompressionModeKey): Promise<string> {
  return new Promise((resolve) => {
    const settings = COMPRESSION_MODES[mode];
    if (mode === 'original') {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target?.result as string);
      reader.readAsDataURL(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const width = img.width;
        const height = img.height;
        const ratio = Math.min(settings.maxDim / width, settings.maxDim / height, 1);
        canvas.width = width * ratio;
        canvas.height = height * ratio;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', settings.quality));
        }
      };
      img.src = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  });
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

// --- メインアプリケーション ---

export default function App() {
  const [activeTab, setActiveTab] = useState<'import' | 'edit' | 'preview'>('import');
  const [points, setPoints] = useState<BoundaryPoint[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState({ current: 0, total: 0 });

  // Settings with localStorage
  const [apiKey, setApiKey] = useState(() => getStorageItem('apiKey', ''));
  const [markTypes, setMarkTypes] = useState(() => getStorageItem('markTypes', INITIAL_MARK_TYPES));
  const [itemsPerPage, setItemsPerPage] = useState(() => getStorageItem('itemsPerPage', 3));
  const [showDate, setShowDate] = useState(() => getStorageItem('showDate', false));
  const [compressionMode, setCompressionMode] = useState<CompressionModeKey>(() => getStorageItem('compressionMode', 'medium'));
  const [ledgerSettings, setLedgerSettings] = useState<LedgerSettings>(() => getStorageItem('ledgerSettings', {
    ledgerType: DEFAULT_LEDGER_TYPES[0],
    customLedgerType: '',
    siteName: ''
  }));
  const [viewVisibility, setViewVisibility] = useState<ViewVisibility>(() => getStorageItem('viewVisibility', { far: true, middle: false, close: true, macro: false }));

  const [aiProcessingIds, setAiProcessingIds] = useState<Set<string>>(new Set());
  const [errorMessage, setErrorMessage] = useState("");
  const [draggedItemIndex, setDraggedItemIndex] = useState<number | null>(null);
  const [newMarkType, setNewMarkType] = useState("");

  // localStorage sync
  useEffect(() => setStorageItem('apiKey', apiKey), [apiKey]);
  useEffect(() => setStorageItem('markTypes', markTypes), [markTypes]);
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
    if (files.length === 0) return;
    setIsProcessing(true);
    setProcessingProgress({ current: 0, total: files.length });
    const newFileData: FileData[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const { baseName, viewType, direction } = parseFileName(file.name);
      const compressedUrl = await compressImage(file, compressionMode);
      newFileData.push({
        id: Math.random().toString(36).substr(2, 9),
        fileName: file.name, baseName, viewType, direction, url: compressedUrl,
        lastModified: new Date(file.lastModified).toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' })
      });
      setProcessingProgress(prev => ({ ...prev, current: i + 1 }));
    }
    setPoints(prev => {
      const updated = [...prev];
      newFileData.forEach(data => {
        const idx = updated.findIndex(p => p.pointName === data.baseName);
        if (idx > -1) {
          if (!updated[idx].directions[data.direction]) updated[idx].directions[data.direction] = {};
          updated[idx].directions[data.direction][data.viewType] = data;
        } else {
          updated.push({
            id: Math.random().toString(36).substr(2, 9),
            pointName: data.baseName, markType: "未設定",
            directions: { [data.direction]: { [data.viewType]: data } },
            selectedDirection: data.direction, notes: ""
          });
        }
      });
      return updated;
    });
    setIsProcessing(false);
    if (newFileData.length > 0) setActiveTab('edit');
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

  const performAIIdentification = async (point: BoundaryPoint) => {
    const dirData = point.directions[point.selectedDirection] || {};
    const photo = dirData.macro || dirData.close || dirData.middle || dirData.far;
    if (!photo) return;
    const base64Data = photo.url.split(',')[1];
    const customPrompt = markTypes.filter(t => !INITIAL_MARK_TYPES.includes(t)).length > 0
      ? `\n追加選択肢: [${markTypes.filter(t => !INITIAL_MARK_TYPES.includes(t)).join(', ')}]` : "";

    const promptText = `境界標識判別: [金属鋲, 金属標, プラスチック杭, コンクリート杭, コンクリート角, 木杭, 刻印, 真鍮標識]${customPrompt} から1つ選んで名称のみ返せ。`;
    const result = await callGemini({ contents: [{ parts: [{ text: promptText }, { inlineData: { mimeType: "image/jpeg", data: base64Data } }] }] }, apiKey);
    let aiText = result?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    aiText = typeof aiText === 'string' ? aiText.replace(/[`*#\n\r]/g, "").trim() : "";
    const matchedType = markTypes.find(t => aiText.includes(t));
    if (matchedType) setPoints(prev => prev.map(p => p.id === point.id ? { ...p, markType: matchedType } : p));
  };

  const identifyMarkWithAI = async (pointId: string) => {
    const point = points.find(p => p.id === pointId);
    if (!point || !apiKey) return;
    setAiProcessingIds(prev => new Set(prev).add(pointId));
    setErrorMessage("");
    try { await performAIIdentification(point); }
    catch (error) { setErrorMessage("AIエラー: " + (error instanceof Error ? error.message : String(error))); }
    finally { setAiProcessingIds(prev => { const next = new Set(prev); next.delete(pointId); return next; }); }
  };

  const identifyAllWithAI = async () => {
    const targets = points.filter(p => p.markType === "未設定" && !aiProcessingIds.has(p.id));
    if (targets.length === 0 || !apiKey) return;
    setErrorMessage("");
    const chunkSize = 5;
    for (let i = 0; i < targets.length; i += chunkSize) {
      const chunk = targets.slice(i, i + chunkSize);
      setAiProcessingIds(prev => { const next = new Set(prev); chunk.forEach(p => next.add(p.id)); return next; });
      await Promise.all(chunk.map(async (point) => {
        try { await performAIIdentification(point); } catch { /* ignore */ }
        finally { setAiProcessingIds(prev => { const next = new Set(prev); next.delete(point.id); return next; }); }
      }));
    }
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
  const deletePoint = (id: string) => setPoints(prev => prev.filter(p => p.id !== id));

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
        <button onClick={identifyAllWithAI} disabled={points.length === 0 || aiProcessingIds.size > 0} className="bg-indigo-50 text-indigo-600 px-4 py-1.5 rounded-lg text-xs font-bold hover:bg-indigo-100 flex items-center gap-2 disabled:opacity-50">
          <Icon name="Sparkles" size={14} className={aiProcessingIds.size > 0 ? "animate-spin" : ""} /> 一括AI判別
        </button>
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
                <h2 className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-2"><Icon name="Settings2" size={14} />基本設定</h2>
                <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="Gemini APIキー" className="w-full bg-slate-50 border rounded-lg px-2 py-1.5 text-xs font-bold" />
                <select value={ledgerSettings.ledgerType} onChange={e => setLedgerSettings({ ...ledgerSettings, ledgerType: e.target.value })} className="w-full bg-slate-50 border rounded-lg px-3 py-2 text-xs font-bold">
                  {DEFAULT_LEDGER_TYPES.map(t => <option key={t}>{t}</option>)}<option>その他</option>
                </select>
                {ledgerSettings.ledgerType === "その他" && <input type="text" value={ledgerSettings.customLedgerType} onChange={e => setLedgerSettings({ ...ledgerSettings, customLedgerType: e.target.value })} className="w-full bg-slate-50 border rounded-lg px-3 py-2 text-xs font-bold" placeholder="台帳名を入力" />}
                <input type="text" value={ledgerSettings.siteName} onChange={e => setLedgerSettings({ ...ledgerSettings, siteName: e.target.value })} className="w-full bg-slate-50 border rounded-lg px-3 py-2 text-xs font-bold" placeholder="現場名称" />
                <div className="mt-4 pt-4 border-t">
                  <label className="text-[9px] font-bold text-slate-400 block mb-2">標識リスト</label>
                  <div className="flex gap-1 mb-2">
                    <input type="text" value={newMarkType} onChange={e => setNewMarkType(e.target.value)} placeholder="追加" className="flex-1 bg-slate-50 border rounded px-2 py-1 text-xs font-bold" />
                    <button onClick={handleAddMarkType} className="bg-blue-600 text-white px-2 rounded text-[10px] font-bold">追加</button>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {markTypes.map(t => <span key={t} className="px-2 py-0.5 bg-slate-100 border rounded text-[9px] font-bold flex items-center gap-1">{t}<button onClick={() => handleDeleteMarkType(t)}><Icon name="X" size={10} /></button></span>)}
                  </div>
                </div>
              </div>
              {/* 画質設定 */}
              <div className="bg-white p-5 rounded-2xl border shadow-sm space-y-3">
                <h2 className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-2"><Icon name="Image" size={14} />画質設定</h2>
                {(Object.entries(COMPRESSION_MODES) as [CompressionModeKey, typeof COMPRESSION_MODES[CompressionModeKey]][]).map(([k, v]) => <button key={k} onClick={() => setCompressionMode(k)} className={`w-full text-left p-2 rounded-lg border text-[10px] font-bold transition ${compressionMode === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 border-slate-200'}`}>{v.label}</button>)}
              </div>
              {/* 表示設定 */}
              <div className="bg-white p-5 rounded-2xl border shadow-sm space-y-3">
                <h2 className="text-[10px] font-black text-slate-400 uppercase flex items-center gap-2"><Icon name="LayoutGrid" size={14} />表示設定</h2>
                <div className="flex gap-2">{[1, 2, 3].map(n => <button key={n} onClick={() => setItemsPerPage(n)} className={`flex-1 py-1 rounded-lg border text-[10px] font-bold ${itemsPerPage === n ? 'bg-blue-600 text-white' : 'bg-slate-50'}`}>{n}点/頁</button>)}</div>
                <button onClick={() => setShowDate(!showDate)} className={`w-full py-1.5 rounded-lg text-[10px] font-bold border flex items-center justify-center gap-2 transition ${showDate ? 'bg-blue-50 text-blue-600' : 'bg-slate-50 text-slate-400'}`}><Icon name="Calendar" size={12} /> 撮影日: {showDate ? 'ON' : 'OFF'}</button>
                <div className="grid grid-cols-2 gap-2 mt-2">{VIEW_TYPES.map(vt => <button key={vt.id} onClick={() => setViewVisibility(v => ({ ...v, [vt.id]: !v[vt.id] }))} className={`px-2 py-1 border rounded text-[9px] font-bold flex justify-between items-center transition ${viewVisibility[vt.id] ? 'border-blue-300 bg-blue-50 text-blue-700' : 'text-slate-400 bg-slate-50'}`}>{vt.label}<span>{viewVisibility[vt.id] ? '●' : '○'}</span></button>)}</div>
              </div>
            </div>
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
              </div>
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {points.map((p, i) => (
                  <div key={p.id} draggable onDragStart={e => handleDragStart(e, i)} onDragOver={e => handleDragOver(e, i)} onDragEnd={() => setDraggedItemIndex(null)} className={`text-[10px] font-bold p-2 bg-slate-50 border rounded truncate flex items-center gap-2 cursor-grab transition-colors ${draggedItemIndex === i ? 'drag-ghost' : 'hover:border-blue-300 hover:bg-blue-50'}`}>
                    <Icon name="GripVertical" size={12} className="text-slate-300" />
                    {aiProcessingIds.has(p.id) && <div className="w-2 h-2 bg-blue-500 rounded-full animate-ping shrink-0"></div>}
                    <span className="truncate">{p.pointName || "(未入力)"}</span>
                    {p.markType === "計算点" && <span className="ml-auto text-[8px] bg-slate-200 px-1 rounded">計</span>}
                  </div>
                ))}
              </div>
            </aside>
            <section className="flex-1 overflow-y-auto p-6 space-y-4">
              {points.map(point => {
                const dirData = point.directions[point.selectedDirection] || {};
                const isAiWorking = aiProcessingIds.has(point.id);
                return (
                  <div key={point.id} className={`bg-white rounded-xl border shadow-sm p-4 transition ${isAiWorking ? 'ring-2 ring-blue-500/20' : ''}`}>
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-4">
                        <div className="flex flex-col">
                          <span className="text-[9px] font-bold text-slate-400">点名</span>
                          <input type="text" value={point.pointName} onChange={e => updatePoint(point.id, { pointName: e.target.value })} className="text-sm font-black bg-transparent border-b-2 border-transparent focus:border-blue-500 focus:outline-none w-32 px-1" />
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[9px] font-bold text-slate-400">標識</span>
                          <div className="flex items-center gap-2">
                            <select value={point.markType} onChange={e => updatePoint(point.id, { markType: e.target.value })} className="border rounded px-2 py-1 text-xs font-bold bg-slate-50 h-8">
                              <option value="未設定">未設定</option>
                              {markTypes.map(t => <option key={t}>{t}</option>)}
                            </select>
                            <button onClick={() => identifyMarkWithAI(point.id)} disabled={isAiWorking || point.markType === "計算点"} className={`w-8 h-8 rounded-lg border flex items-center justify-center transition ${isAiWorking ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white text-blue-600 border-blue-200 hover:bg-blue-50 disabled:opacity-30'}`}>
                              {isAiWorking ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div> : <Icon name="Sparkles" size={14} />}
                            </button>
                          </div>
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
                            </div>
                            {showDate && representative && <div className="text-[9px] font-bold text-slate-500">撮影日: {representative.lastModified}</div>}
                          </div>
                          <div className="p-1 flex-1 grid gap-1 min-h-0 overflow-hidden" style={{ gridTemplateColumns: `repeat(${enabledViewTypes.length === 1 ? 1 : 2}, minmax(0, 1fr))` }}>
                            {enabledViewTypes.map(vt => (
                              <div key={vt.id} className="border border-black flex flex-col overflow-hidden bg-white">
                                <div className="flex-1 flex items-center justify-center overflow-hidden">
                                  {dirData[vt.id] ? <img src={dirData[vt.id]!.url} className="max-h-full max-w-full object-contain" /> : null}
                                </div>
                                <div className="text-[8px] text-center bg-slate-50 border-t border-black font-black uppercase tracking-widest">{vt.label}</div>
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
