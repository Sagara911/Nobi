// 悬浮参考浮窗：从库里把一张/多张图"拉到桌面"，无边框/透明/永远置顶，浮在绘图软件上方。
// 这是独立的第二个 WebviewWindow（label=ref-*），main.tsx 按 #ref 路由到这里。
// 交互：左键拖图=移窗；拖右下角小三角=按比例缩放；滚轮=多图轮播；
//       【右键图片】= 在鼠标处弹出「独立菜单小窗」(ref-tools，不受本窗大小限制、不会被裁)，
//       菜单里的调节通过 emit("ref-apply") 作用回本窗。窗口大小只受缩放/旋转影响 → 图永不跳。
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow, WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import "./RefWindow.css";

interface RefItem {
  path: string;
  name: string;
}

function parseHash() {
  const q = location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?") + 1) : "";
  const p = new URLSearchParams(q);
  return {
    path: p.get("p") || "",
    name: p.get("n") || "",
    key: p.get("key") || "",
    i: parseInt(p.get("i") || "0", 10) || 0,
  };
}

function safeSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return "";
  }
}

export default function RefWindow() {
  const init = useRef(parseHash()).current;
  const [items] = useState<RefItem[]>(() => {
    if (init.key) {
      try {
        const a = JSON.parse(localStorage.getItem(init.key) || "[]");
        if (Array.isArray(a) && a.length) return a as RefItem[];
      } catch {
        /* ignore */
      }
    }
    return [{ path: init.path, name: init.name }];
  });
  const [idx, setIdx] = useState(() => Math.min(Math.max(0, init.i), 9_999));
  const cur = items[Math.min(idx, items.length - 1)] || { path: "", name: "" };
  const multi = items.length > 1;

  const [opacity, setOpacity] = useState(1);
  const [flip, setFlip] = useState(false);
  const [gray, setGray] = useState(false);
  const [invert, setInvert] = useState(false);
  const [contrast, setContrast] = useState(1);
  const [bright, setBright] = useState(1);
  const [rot, setRot] = useState(0); // 0/90/180/270
  const [through, setThrough] = useState(false);

  const aspect = useRef(0); // 图片 高/宽
  const win = () => getCurrentWebviewWindow();

  const rotated = rot % 180 !== 0;
  const effAspect = useCallback(() => {
    const a = aspect.current || 0.72;
    return rotated ? 1 / a : a; // 高/宽
  }, [rotated]);

  // 窗口高度贴合图片比例（缩放/旋转/载图时）。菜单是独立窗，不改本窗 → 与本窗大小无关。
  const refit = useCallback(() => {
    if (!aspect.current) return;
    const w = Math.round(window.innerWidth);
    const h = Math.round(w * effAspect());
    if (Math.abs(window.innerHeight - h) <= 2) return;
    void win().setSize(new LogicalSize(w, h));
  }, [effAspect]);

  useEffect(() => {
    refit();
  }, [rot, refit]);

  useEffect(() => {
    const un = listen<boolean>("ref-through", (e) => setThrough(!!e.payload));
    return () => {
      un.then((f) => f());
    };
  }, []);

  // 菜单小窗回传的调节
  useEffect(() => {
    const me = win().label;
    const un = listen<{ target: string; patch: Record<string, unknown> }>("ref-apply", (e) => {
      if (!e.payload || e.payload.target !== me) return;
      const p = e.payload.patch || {};
      if (typeof p.flip === "boolean") setFlip(p.flip);
      if (typeof p.gray === "boolean") setGray(p.gray);
      if (typeof p.invert === "boolean") setInvert(p.invert);
      if (typeof p.rot === "number") setRot(p.rot);
      if (typeof p.opacity === "number") setOpacity(p.opacity);
      if (typeof p.contrast === "number") setContrast(p.contrast);
      if (typeof p.bright === "number") setBright(p.bright);
      if (typeof p.cycle === "number" && items.length > 1) {
        const d = p.cycle as number;
        setIdx((i) => (i + d + items.length) % items.length);
      }
      if (p.closeWin) void win().close().catch(() => {});
    });
    return () => {
      un.then((f) => f());
    };
  }, [items.length]);

  const cycle = (d: number) => {
    if (!multi) return;
    setIdx((i) => (i + d + items.length) % items.length);
  };

  // 右键 → 在鼠标处开「独立菜单小窗」，带上当前状态；先关掉已开的菜单窗
  const openTools = async (e: React.MouseEvent) => {
    e.preventDefault();
    const sp = new URLSearchParams({
      target: win().label,
      flip: flip ? "1" : "0",
      gray: gray ? "1" : "0",
      invert: invert ? "1" : "0",
      through: through ? "1" : "0",
      rot: String(rot),
      opacity: String(opacity),
      contrast: String(contrast),
      bright: String(bright),
      multi: multi ? "1" : "0",
      idx: String(idx),
      count: String(items.length),
    });
    try {
      const ex = await WebviewWindow.getByLabel("ref-tools");
      if (ex) await ex.close();
    } catch {
      /* ignore */
    }
    // 菜单的物理坐标 = 本窗物理位置 + 光标在窗内偏移×缩放。比浏览器 e.screenX 跨屏/跨 DPI 可靠得多。
    let px = Math.round(e.screenX);
    let py = Math.round(e.screenY);
    try {
      const sf = await win().scaleFactor();
      const pos = await win().outerPosition(); // 物理像素
      px = Math.round(pos.x + e.clientX * sf);
      py = Math.round(pos.y + e.clientY * sf);
    } catch {
      /* 退回 screenX/Y */
    }
    // 先隐藏着创建——绝不在错位置露面，避免「先闪一下再跳到光标」
    const tools = new WebviewWindow("ref-tools", {
      url: `index.html#reftools?${sp.toString()}`,
      width: 196,
      height: 348,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      shadow: true,
      visible: false,
      title: "参考工具",
    });
    // 创建后：物理坐标精确摆到光标处 → 再显示并聚焦（聚焦才能点别处失焦自动关）
    tools.once("tauri://created", () => {
      void (async () => {
        try {
          await tools.setPosition(new PhysicalPosition(px, py));
        } catch {
          /* ignore */
        }
        try {
          await tools.show();
          await tools.setFocus();
        } catch {
          /* ignore */
        }
      })();
    });
  };

  // 右下角手柄缩放：宽度跟手、高度 = 宽×图片比例，rAF 限流
  const onResizeGrip = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const startX = e.screenX;
    const startW = window.innerWidth;
    const a = effAspect();
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
      void w.setSize(new LogicalSize(Math.round(nextW), Math.round(nextW * a)));
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startDrag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    void win().startDragging();
  };

  const filter =
    [
      gray ? "grayscale(1)" : "",
      invert ? "invert(1)" : "",
      contrast !== 1 ? `contrast(${contrast})` : "",
      bright !== 1 ? `brightness(${bright})` : "",
    ]
      .filter(Boolean)
      .join(" ") || "none";

  const imgStyle: React.CSSProperties = rotated
    ? {
        position: "absolute",
        left: "50%",
        top: "50%",
        width: "100vh",
        height: "100vw",
        objectFit: "contain",
        opacity,
        filter,
        transform: `translate(-50%, -50%) rotate(${rot}deg) scaleX(${flip ? -1 : 1})`,
      }
    : {
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "contain",
        opacity,
        filter,
        transform: `rotate(${rot}deg) scaleX(${flip ? -1 : 1})`,
      };

  return (
    <div className="rw-root" onContextMenu={(e) => void openTools(e)}>
      <img
        className="rw-img"
        src={safeSrc(cur.path)}
        alt={cur.name}
        draggable={false}
        onLoad={(e) => {
          const img = e.currentTarget;
          if (img.naturalWidth && img.naturalHeight) {
            aspect.current = img.naturalHeight / img.naturalWidth;
            refit();
          }
        }}
        onPointerDown={startDrag}
        onWheel={(e) => {
          if (multi) cycle(e.deltaY > 0 ? 1 : -1);
        }}
        style={imgStyle}
      />

      {multi && <div className="rw-badge">{Math.min(idx, items.length - 1) + 1}/{items.length}</div>}

      {/* 右下角缩放手柄 */}
      <div className="rw-resize" title="拖动缩放" onPointerDown={onResizeGrip} />
    </div>
  );
}
