import React, { useState, useMemo } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  rectSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Trash2, Plus, GripVertical, Download, MapPin, Settings, X, UploadCloud, RotateCw } from 'lucide-react';

// --- ユーティリティ関数 ---

// 配列をN個ずつのチャンク（塊）に分割
const chunkArray = <T,>(arr: T[], size: number): T[][] => {
  const chunked = [];
  for (let i = 0; i < arr.length; i += size) {
    chunked.push(arr.slice(i, i + size));
  }
  return chunked;
};

// クライアントサイドでの画像圧縮処理
const compressImage = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new window.Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const MAX_WIDTH = 1200;
        const MAX_HEIGHT = 1200;
        let width = img.width;
        let height = img.height;

        if (width > height) {
          if (width > MAX_WIDTH) {
            height *= MAX_WIDTH / width;
            width = MAX_WIDTH;
          }
        } else {
          if (height > MAX_HEIGHT) {
            width *= MAX_HEIGHT / height;
            height = MAX_HEIGHT;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', 0.8));
        } else {
          reject(new Error('Canvas context not available'));
        }
      };
      img.onerror = (e) => reject(e);
    };
    reader.onerror = (e) => reject(e);
  });
};

// 画像データを90度回転させる処理
const rotateImageData = (url: string): Promise<string> => {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.src = url;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.height;
      canvas.height = img.width;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate((90 * Math.PI) / 180);
        ctx.drawImage(img, -img.width / 2, -img.height / 2);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      } else {
        resolve(url);
      }
    };
    img.onerror = () => resolve(url);
  });
};

// --- 型定義 ---
type Photo = { id: string; url: string };
type BoundaryPoint = {
  id: string;
  name: string;
  photos: Photo[];
};
type PhotoWithCaption = Photo & { caption: string; pointId: string };

// --- コンポーネント群 ---

// ドラッグ可能な写真アイテムコンポーネント
const SortablePhotoItem = ({
  id,
  url,
  caption,
  onRemove,
  onRotate
}: {
  id: string,
  url: string,
  caption: string,
  onRemove: (id: string) => void,
  onRotate: (id: string) => void
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative group bg-white border rounded-lg shadow-sm overflow-hidden flex flex-col ${
        isDragging ? 'opacity-50 ring-2 ring-green-500 border-green-500' : 'border-gray-200'
      }`}
    >
      {/* 左上：回転ボタン */}
      <div className="absolute top-2 left-2 z-20 print:hidden flex items-center gap-2">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onRotate(id);
          }}
          className="p-1 bg-white/90 backdrop-blur-sm rounded-md shadow-sm hover:bg-gray-100 text-gray-700 cursor-pointer border border-gray-200"
          title="90度回転"
        >
          <RotateCw size={14} />
        </button>
      </div>

      {/* 右上：操作ボタン */}
      <div className="absolute top-2 right-2 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1 print:hidden">
        <button
          {...attributes}
          {...listeners}
          className="p-1.5 bg-white/90 backdrop-blur-sm rounded-md shadow-sm hover:bg-gray-100 text-gray-700 cursor-grab active:cursor-grabbing"
          title="ドラッグして並び替え"
        >
          <GripVertical size={16} />
        </button>
        <button
          onClick={() => onRemove(id)}
          className="p-1.5 bg-red-500/90 backdrop-blur-sm rounded-md shadow-sm hover:bg-red-600 text-white cursor-pointer"
          title="削除"
        >
          <Trash2 size={16} />
        </button>
      </div>

      <div className="flex-1 aspect-square bg-gray-50 flex items-center justify-center overflow-hidden">
        <img src={url} alt={caption} className="w-full h-full object-cover" />
      </div>
      <div className="p-2.5 text-center text-sm font-semibold text-slate-800 bg-slate-50 border-t border-gray-200">
        {caption}
      </div>
    </div>
  );
};

// 印刷用プレビューレイアウト
const PrintLayout = ({ allPhotos }: { allPhotos: PhotoWithCaption[] }) => {
  const chunks = chunkArray(allPhotos, 8);

  return (
    <div className="w-full bg-white text-black">
      <style>{`
        @page { size: A4 portrait; margin: 15mm; }
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; margin: 0; background: white; }
          .page-break { page-break-after: always; }
          .page-break:last-child { page-break-after: auto; }
          .avoid-break { page-break-inside: avoid; }
        }
      `}</style>

      {chunks.map((chunk, i) => (
        <div key={`chunk-${i}`} className="page-break w-full pt-2">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            {chunk.map((photo) => (
              <div key={photo.id} className="flex flex-col items-center justify-start h-[230px] avoid-break">
                <img src={photo.url} alt={photo.caption} className="w-full h-[200px] object-contain mb-1" />
                <p className="text-sm font-medium text-center text-gray-800">{photo.caption}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

// --- メインアプリケーション ---
export default function App() {
  const [boundaryPoints, setBoundaryPoints] = useState<BoundaryPoint[]>([
    { id: crypto.randomUUID(), name: '境界点 1', photos: [] }
  ]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // センサー設定 (DnD)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // 全写真をキャプション付きでフラット化
  const allPhotosWithCaption: PhotoWithCaption[] = useMemo(() => {
    return boundaryPoints.flatMap((point) =>
      point.photos.map((photo, photoIndex) => ({
        ...photo,
        pointId: point.id,
        caption: point.photos.length > 1
          ? `${point.name} - ${photoIndex + 1}`
          : point.name
      }))
    );
  }, [boundaryPoints]);

  // 境界点の追加
  const handleAddPoint = () => {
    const nextNum = boundaryPoints.length + 1;
    setBoundaryPoints(prev => [
      ...prev,
      { id: crypto.randomUUID(), name: `境界点 ${nextNum}`, photos: [] }
    ]);
  };

  // 境界点の削除
  const handleRemovePoint = (pointId: string) => {
    setBoundaryPoints(prev => prev.filter(p => p.id !== pointId));
  };

  // 境界点名の変更
  const handleUpdatePointName = (pointId: string, name: string) => {
    setBoundaryPoints(prev =>
      prev.map(p => p.id === pointId ? { ...p, name } : p)
    );
  };

  // 写真追加ハンドラー
  const handleAddPhotos = async (e: React.ChangeEvent<HTMLInputElement>, pointId: string) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;

    setIsProcessing(true);
    try {
      const newPhotos = await Promise.all(
        files.map(async (file) => {
          const url = await compressImage(file);
          return { id: crypto.randomUUID(), url };
        })
      );

      setBoundaryPoints(prev =>
        prev.map(p =>
          p.id === pointId
            ? { ...p, photos: [...p.photos, ...newPhotos] }
            : p
        )
      );
    } catch (error) {
      console.error("画像の処理中にエラーが発生しました:", error);
      alert("画像の読み込みに失敗しました。");
    } finally {
      setIsProcessing(false);
      e.target.value = '';
    }
  };

  // 写真削除ハンドラー
  const handleRemovePhoto = (photoId: string, pointId: string) => {
    setBoundaryPoints(prev =>
      prev.map(p =>
        p.id === pointId
          ? { ...p, photos: p.photos.filter(ph => ph.id !== photoId) }
          : p
      )
    );
  };

  // 写真回転処理
  const handleRotatePhoto = async (photoId: string, pointId: string) => {
    const point = boundaryPoints.find(p => p.id === pointId);
    if (!point) return;
    const photo = point.photos.find(ph => ph.id === photoId);
    if (!photo) return;

    const newUrl = await rotateImageData(photo.url);

    setBoundaryPoints(prev =>
      prev.map(p =>
        p.id === pointId
          ? { ...p, photos: p.photos.map(ph => ph.id === photoId ? { ...ph, url: newUrl } : ph) }
          : p
      )
    );
  };

  // 並び替え完了ハンドラー
  const handleDragEnd = (event: DragEndEvent, pointId: string) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setBoundaryPoints(prev =>
        prev.map(p => {
          if (p.id !== pointId) return p;
          const oldIndex = p.photos.findIndex(ph => ph.id === active.id);
          const newIndex = p.photos.findIndex(ph => ph.id === over.id);
          return { ...p, photos: arrayMove(p.photos, oldIndex, newIndex) };
        })
      );
    }
  };

  // 印刷をトリガーする関数
  const handlePrint = () => {
    const printArea = document.getElementById('print-area');
    if (!printArea) {
      window.print();
      return;
    }

    const clone = printArea.cloneNode(true) as HTMLElement;
    clone.classList.remove('hidden', 'print:block');
    clone.style.display = 'block';

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('ポップアップがブロックされました。ブラウザのアドレスバー付近からポップアップを許可していただくか、キーボードの Ctrl+P (Macは Cmd+P) を押して直接印刷してください。');
      window.print();
      return;
    }

    const htmlContent = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>写真台帳（土地） - 印刷プレビュー</title>
          <script src="https://cdn.tailwindcss.com"><${""}/script>
          <style>
            @page { size: A4 portrait; margin: 15mm; }
            body {
              -webkit-print-color-adjust: exact;
              print-color-adjust: exact;
              margin: 0;
              background: white;
              color: black;
              font-family: sans-serif;
            }
            .page-break { page-break-before: always; }
            .avoid-break { page-break-inside: avoid; }
          </style>
        </head>
        <body>
          ${clone.outerHTML}
          <script>
            setTimeout(() => {
              window.print();
            }, 800);
          <${""}/script>
        </body>
      </html>
    `;

    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
  };

  const totalPhotos = boundaryPoints.reduce((sum, p) => sum + p.photos.length, 0);

  return (
    <>
      <div className="min-h-screen bg-slate-50 text-slate-900 font-sans pb-20 print:hidden">
        {/* ヘッダー */}
        <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-50 shadow-sm">
          <h1 className="text-xl font-bold flex items-center gap-2 text-slate-800">
            <MapPin className="text-green-600" />
            写真台帳（土地）
          </h1>

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="flex items-center gap-2 bg-white border border-gray-300 hover:bg-gray-50 text-slate-700 px-4 py-2 rounded-md font-medium transition-colors shadow-sm lg:hidden"
            >
              <Settings size={18} />
            </button>
            {totalPhotos > 0 && (
              <button
                onClick={handlePrint}
                className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-md font-medium transition-colors shadow-sm"
              >
                <Download size={18} />
                PDFを出力
              </button>
            )}
          </div>
        </header>

        <main className="max-w-7xl mx-auto p-6 flex flex-col lg:flex-row gap-8 items-start">

          {/* 左サイドバー: 境界点設定 */}
          <aside className={`w-full lg:w-80 bg-white border border-gray-200 rounded-xl shadow-sm p-5 shrink-0 sticky top-24 ${showSettings ? '' : 'hidden lg:block'}`}>
            <div className="flex items-center gap-2 mb-4 border-b border-gray-100 pb-3">
              <Settings size={20} className="text-slate-500" />
              <h2 className="text-lg font-bold text-slate-800">境界点設定</h2>
            </div>
            <p className="text-xs text-slate-500 mb-4">
              境界点を追加し、名前を設定します。各境界点に写真を登録できます。
            </p>

            <div className="space-y-3 mb-4 max-h-[60vh] overflow-y-auto">
              {boundaryPoints.map((point, index) => (
                <div key={point.id} className="p-3 bg-slate-50 border border-slate-200 rounded-lg relative group/item">
                  {boundaryPoints.length > 1 && (
                    <button
                      onClick={() => handleRemovePoint(point.id)}
                      className="absolute -top-2 -right-2 bg-red-100 text-red-600 hover:bg-red-500 hover:text-white rounded-full p-1 opacity-0 group-hover/item:opacity-100 transition-opacity"
                    >
                      <X size={14} />
                    </button>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-green-600 bg-green-50 px-2 py-0.5 rounded">
                      {index + 1}
                    </span>
                    <input
                      type="text"
                      value={point.name}
                      onChange={(e) => handleUpdatePointName(point.id, e.target.value)}
                      placeholder="境界点名"
                      className="flex-1 px-2 py-1.5 text-sm border rounded focus:ring-2 focus:ring-green-500 outline-none"
                    />
                  </div>
                  <div className="mt-2 text-xs text-slate-400">
                    写真: {point.photos.length}枚
                  </div>
                </div>
              ))}
            </div>

            <button
              onClick={handleAddPoint}
              className="w-full flex items-center justify-center gap-1 py-2 border-2 border-dashed border-slate-300 text-slate-600 rounded-lg hover:border-green-400 hover:text-green-600 transition-colors text-sm font-medium"
            >
              <Plus size={16} /> 境界点を追加
            </button>
          </aside>

          {/* メイン: 写真エリア */}
          <div className="flex-1 w-full space-y-10">
            {boundaryPoints.map((point) => (
              <section key={point.id}>
                <div className="flex items-center justify-between mb-4 border-b border-gray-200 pb-2">
                  <div className="flex items-center gap-3">
                    <MapPin size={20} className="text-green-600" />
                    <h2 className="text-xl font-bold text-slate-800">{point.name}</h2>
                    <span className="text-sm text-slate-400">({point.photos.length}枚)</span>
                  </div>

                  <label className="cursor-pointer flex items-center gap-1.5 bg-white border border-gray-300 hover:bg-gray-50 text-slate-700 px-4 py-2 rounded-md text-sm font-medium transition-colors shadow-sm">
                    <UploadCloud size={16} />
                    写真を追加
                    <input
                      type="file"
                      multiple
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => handleAddPhotos(e, point.id)}
                      disabled={isProcessing}
                    />
                  </label>
                </div>

                {point.photos.length === 0 ? (
                  <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-xl p-10 text-center text-slate-500">
                    <MapPin className="mx-auto mb-2 opacity-50" size={32} />
                    <p>右上のボタンから境界点の写真を追加してください。</p>
                  </div>
                ) : (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => handleDragEnd(e, point.id)}>
                    <SortableContext items={point.photos.map(p => p.id)} strategy={rectSortingStrategy}>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                        {point.photos.map((photo, photoIndex) => {
                          const caption = point.photos.length > 1
                            ? `${point.name} - ${photoIndex + 1}`
                            : point.name;
                          return (
                            <SortablePhotoItem
                              key={photo.id}
                              id={photo.id}
                              url={photo.url}
                              caption={caption}
                              onRemove={(id) => handleRemovePhoto(id, point.id)}
                              onRotate={(id) => handleRotatePhoto(id, point.id)}
                            />
                          );
                        })}
                      </div>
                    </SortableContext>
                  </DndContext>
                )}
              </section>
            ))}
          </div>
        </main>

        {/* 処理中のオーバーレイ */}
        {isProcessing && (
          <div className="fixed inset-0 bg-white/50 backdrop-blur-sm z-[100] flex items-center justify-center">
            <div className="bg-white px-6 py-4 rounded-lg shadow-lg border border-slate-200 flex items-center gap-3">
              <div className="w-5 h-5 border-2 border-green-600 border-t-transparent rounded-full animate-spin"></div>
              <span className="font-medium text-slate-700">写真を処理しています...</span>
            </div>
          </div>
        )}
      </div>

      {/* 印刷用のレイアウト */}
      <div id="print-area" className="hidden print:block">
        <PrintLayout allPhotos={allPhotosWithCaption} />
      </div>
    </>
  );
}
