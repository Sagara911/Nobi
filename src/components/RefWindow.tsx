// 悬浮参考浮窗：从库里把一张图"拉到桌面"，无边框/透明/永远置顶，浮在绘图软件上方。
// 这是独立的第二个 WebviewWindow（label=ref-*），main.tsx 按 #ref 路由到这里。
// 画师用法：拖动随便摆、拽右下角缩放、滑杆压透明度别挡画布、镜像/灰度换看法。
import { useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
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
  const aspect = useRef(0); // 图片 高/宽，载入后用于锁比例缩放（消灭透明留白，手柄始终贴图右下角）
  // 惰性取窗：放进事件回调里，避免无 Tauri 运行时（如纯浏览器预览）渲染期就抛错
  const win = () => getCurrentWebviewWindow();

  // 自驱缩放：手柄拖动时我们直接 setSize（不走 OS startResizeDragging，避免与系统拖拽
  // 抢节奏造成闪烁/抖动）；宽度跟手、高度按图片比例回算，rAF 合帧限流。
  const onResizeGrip = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startX = e.screenX;
    const startW = window.innerWidth; // 逻辑像素
    const a = aspect.current || window.innerHeight / Math.max(1, window.innerWidth);
    const w = win();
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    let nextW = startW;
    let raf = 0;
    const apply = () => {
      raf = 0;
      void w.setSize(new LogicalSize(Math.round(nextW), Math.round(nextW * a)));
    };
    const move = (ev: PointerEvent) => {
      nextW = Math.max(80, startW + (ev.screenX - startX));
      if (!raf) raf = requestAnimationFrame(apply);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      void w.setSize(new LogicalSize(Math.round(nextW), Math.round(nextW * a))); // 落定最终尺寸
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

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
      <div className="rw-resize" title="拖动缩放" onPointerDown={onResizeGrip} />
    </div>
  );
}
