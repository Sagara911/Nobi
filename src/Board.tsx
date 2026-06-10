import { Tldraw, AssetRecordType, type Editor, type TLAssetId } from "tldraw";
import "tldraw/tldraw.css";
import { convertFileSrc } from "@tauri-apps/api/core";

export interface BoardImage {
  id: number;
  path: string;
  name: string;
  width: number;
  height: number;
}

function addImages(editor: Editor, images: BoardImage[]) {
  if (!images.length) return;
  const MAX = 320;
  const perRow = 4;
  const gap = 28;
  let col = 0;
  let x = 0;
  let y = 0;
  let rowH = 0;

  for (const img of images) {
    const ratio = img.width && img.height ? img.height / img.width : 1;
    const w = MAX;
    const h = Math.max(40, Math.round(MAX * ratio));
    const assetId: TLAssetId = AssetRecordType.createId();

    editor.createAssets([
      {
        id: assetId,
        type: "image",
        typeName: "asset",
        props: {
          name: img.name,
          src: convertFileSrc(img.path),
          w,
          h,
          mimeType: "image/png",
          isAnimated: false,
        },
        meta: {},
      },
    ]);
    editor.createShape({ type: "image", x, y, props: { assetId, w, h } });

    col++;
    rowH = Math.max(rowH, h);
    x += w + gap;
    if (col >= perRow) {
      col = 0;
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
  }
  editor.zoomToFit();
}

export default function Board({
  images,
  onClose,
}: {
  images: BoardImage[];
  onClose: () => void;
}) {
  return (
    <div className="board-overlay">
      <div className="board-top">
        <span className="brand">
          参考板 <small>拖动 / 缩放 / 标注 · 自动保存</small>
        </span>
        <button className="btn" onClick={onClose}>
          关闭参考板
        </button>
      </div>
      <div className="board-canvas">
        <Tldraw persistenceKey="gringotts-refboard" onMount={(editor) => addImages(editor, images)} />
      </div>
    </div>
  );
}
