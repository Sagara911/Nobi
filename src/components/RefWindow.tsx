// 悬浮参考浮窗：从库里把一张图"拉到桌面"，无边框/透明/永远置顶，浮在绘图软件上方。
// 这是独立的第二个 WebviewWindow（label=ref-*），main.tsx 按 #ref 路由到这里。
// 画师用法：拖动随便摆、拽右下角缩放、滑杆压透明度别挡画布、镜像/灰度换看法。
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalSize } from "@tauri-apps/api/dpi";
import "./RefWindow.css";

function parseHash() {
  const q = location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?") + 1) : "";
  const p = new URLSearchParams(q);
  return { path: p.get("p") || "", name: p.get("n") || "" };
}

// 防御：无 Tauri 运行时（如纯浏览器预览）convertFileSrc 会抛，渲染不该因此整窗空白
function safeSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}

export default function RefWindow() {
  const meta = useRef(parseHash()).current;
  const [opacity, setOpacity] = useState(1);
  const [flip, setFlip] = useState(false);
  const [gray, setGray] = useState(false);
  const aspect = useRef(0); // 图片 高/宽，载入后用于锁窗口比例（消灭透明留白，缩放手柄始终贴图右下角）
  // 惰性取窗：放进事件回调里，避免无 Tauri 运行时（如纯浏览器预览）渲染期就抛错
  const win = () => getCurrentWebviewWindow();

  // 锁定窗口宽高比 = 图片比例：缩放时按当前宽度回算高度，图始终铺满、无留白
  useEffect(() => {
    let un = () => {};
    let busy = false;
    try {
      const w = getCurrentWebviewWindow();
      w.onResized(({ payload }) => {
        const a = aspect.current;
        if (!a || busy) return;
        const desiredH = Math.round(payload.width * a);
        if (Math.abs(payload.height - desiredH) > 2) {
          busy = true;
          void w.setSize(new PhysicalSize(payload.width, desiredH)).finally(() => {
            busy = false;
          });
        }
      })
        .then((f) => (un = f))
        .catch(() => {});
    } catch {
      /* 无 Tauri 运行时（预览）忽略 */
    }
    return () => un();
  }, []);

  // 在图/标题上按下即拖整窗（系统级移动）
  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    void win().startDragging();
  };

  return (
    <div className="rw-root" style={{ opacity }}>
      <img
        className="rw-img"
        src={safeSrc(meta.path)}
        alt={meta.name}
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth) aspect.current = img.naturalHeight / img.naturalWidth;
        }}
        onPointerDown={startDrag}
        style={{
          filter: gray ? "grayscale(1)" : "none",
          transform: flip ? "scaleX(-1)" : "none",
        }}
      />

      <div className="rw-bar">
        <span className="rw-name" title={meta.name} onPointerDown={startDrag}>
          {meta.name}
        </span>
        <button
          className={flip ? "on" : ""}
          title="镜像（翻转看构图）"
          onClick={() => setFlip((v) => !v)}
        >
          ⇋
        </button>
        <button
          className={gray ? "on" : ""}
          title="灰度（看明暗）"
          onClick={() => setGray((v) => !v)}
        >
          ◑
        </button>
        <input
          className="rw-opacity"
          type="range"
          min={0.2}
          max={1}
          step={0.05}
          value={opacity}
          title="不透明度（压低别挡画布）"
          onChange={(e) => setOpacity(Number(e.target.value))}
        />
        <button className="rw-close" title="关闭" onClick={() => void win().close()}>
          ✕
        </button>
      </div>

      {/* 右下角缩放手柄 */}
      <div
        className="rw-resize"
        title="拖动缩放"
        onPointerDown={(e) => {
          if (e.button === 0) void win().startResizeDragging("SouthEast");
        }}
      />
    </div>
  );
}
