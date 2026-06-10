import {
  Tldraw,
  AssetRecordType,
  getSnapshot,
  loadSnapshot,
  type Editor,
  type TLAssetId,
} from "tldraw";
import "tldraw/tldraw.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import { loadBoard, saveBoard } from "./api";

export type BoardEditor = Editor;

export interface BoardImage {
  id: number;
  path: string;
  name: string;
  width: number;
  height: number;
}

/** 把一批图按网格摊到画布上 */
export function addImages(editor: Editor, images: BoardImage[]) {
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

/** 画板面板内容（tldraw 无限画布，强制深色）。
 *  持久化双层：tldraw 本地存储 = 快取（秒开）；SQLite 快照 = 权威副本。
 *  本地为空但库里有快照（换机/清缓存）→ 自动从 SQLite 恢复。 */
export default function BoardCanvas({ onMount }: { onMount: (editor: Editor) => void }) {
  return (
    <div className="board-canvas">
      <Tldraw
        persistenceKey="nobi-refboard"
        onMount={(editor) => {
          editor.user.updateUserPreferences({ colorScheme: "dark" });

          // 从素材网格拖图进画布：URL 落点生成真正的图片（默认行为是丑陋的书签卡片）
          editor.registerExternalContentHandler("url", async (content) => {
            const url = content.url;
            const isImg = /asset\.localhost|\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i.test(url);
            const point = content.point ?? editor.getViewportPageBounds().center;
            if (!isImg) return; // 参考板只收图片，忽略普通链接（避免书签卡片）
            const dims = await new Promise<{ w: number; h: number }>((res) => {
              const img = new Image();
              img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
              img.onerror = () => res({ w: 400, h: 400 });
              img.src = url;
            });
            const MAX = 360;
            const scale = Math.min(1, MAX / Math.max(dims.w, dims.h, 1));
            const w = Math.max(40, dims.w * scale);
            const h = Math.max(40, dims.h * scale);
            const assetId: TLAssetId = AssetRecordType.createId();
            editor.createAssets([
              {
                id: assetId,
                type: "image",
                typeName: "asset",
                props: {
                  name: "拖入图片",
                  src: url,
                  w,
                  h,
                  mimeType: "image/png",
                  isAnimated: false,
                },
                meta: {},
              },
            ]);
            editor.createShape({
              type: "image",
              x: point.x - w / 2,
              y: point.y - h / 2,
              props: { assetId, w, h },
            });
          });

          // 恢复：本地是空画板而 SQLite 有权威快照时
          (async () => {
            try {
              const saved = await loadBoard();
              if (saved && editor.getCurrentPageShapeIds().size === 0) {
                loadSnapshot(editor.store, JSON.parse(saved));
              }
            } catch {
              /* 快照损坏则保持本地内容 */
            }
          })();

          // 回写：用户改动后防抖 1.5s 把快照写入 SQLite
          let t: ReturnType<typeof setTimeout> | undefined;
          editor.store.listen(
            () => {
              clearTimeout(t);
              t = setTimeout(() => {
                try {
                  saveBoard(JSON.stringify(getSnapshot(editor.store)));
                } catch {
                  /* ignore */
                }
              }, 1500);
            },
            { scope: "document", source: "user" }
          );

          onMount(editor);
        }}
      />
    </div>
  );
}
