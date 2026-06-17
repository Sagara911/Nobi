// 参考窗的「右键菜单」独立小窗（label=ref-tools，main.tsx 按 #reftools 路由）。
// 为什么独立成窗：参考窗可能被缩得很小，菜单画在它里面会被 webview 裁掉。独立小窗不受其大小限制。
// 通讯：菜单里的调节 → emit("ref-apply",{target,patch}) → 目标参考窗监听并应用。失焦自动关。
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalSize } from "@tauri-apps/api/dpi";
import "./RefToolsWindow.css";

function parseHash() {
  const q = location.hash.includes("?") ? location.hash.slice(location.hash.indexOf("?") + 1) : "";
  const p = new URLSearchParams(q);
  const num = (k: string, d: number) => {
    const v = parseFloat(p.get(k) || "");
    return Number.isFinite(v) ? v : d;
  };
  return {
    target: p.get("target") || "",
    flip: p.get("flip") === "1",
    gray: p.get("gray") === "1",
    invert: p.get("invert") === "1",
    through: p.get("through") === "1",
    rot: num("rot", 0),
    opacity: num("opacity", 1),
    contrast: num("contrast", 1),
    bright: num("bright", 1),
    multi: p.get("multi") === "1",
    idx: num("idx", 0),
    count: num("count", 1),
  };
}

export default function RefToolsWindow() {
  const p = useRef(parseHash()).current;
  const target = p.target;
  const win = () => getCurrentWebviewWindow();

  const [flip, setFlip] = useState(p.flip);
  const [gray, setGray] = useState(p.gray);
  const [invert, setInvert] = useState(p.invert);
  const [rot, setRot] = useState(p.rot);
  const [opacity, setOpacity] = useState(p.opacity);
  const [contrast, setContrast] = useState(p.contrast);
  const [bright, setBright] = useState(p.bright);
  const [through, setThrough] = useState(p.through);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 把菜单窗高度收到刚好包住内容（有没有多图那行都对），别留一截空
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const h = Math.ceil(el.offsetHeight); // root 高度随内容（见 css，不再 inset:0）
    if (h > 0) void win().setSize(new LogicalSize(196, h)).catch(() => {});
  }, []);

  const apply = (patch: Record<string, unknown>) => {
    void emit("ref-apply", { target, patch });
  };
  const close = () => void win().close().catch(() => {});

  // 失焦（点到参考窗或别处）即关；Esc 也关
  useEffect(() => {
    const onBlur = () => close();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return (
    <div className="rt-root" ref={rootRef}>
      {p.multi && (
        <div className="rt-nav">
          <button onClick={() => apply({ cycle: -1 })}>◀ 上一张</button>
          <span>{Math.min(p.idx, p.count - 1) + 1}/{p.count}</span>
          <button onClick={() => apply({ cycle: 1 })}>下一张 ▶</button>
        </div>
      )}
      <div className="rt-toggles">
        <button className={flip ? "on" : ""} onClick={() => { const v = !flip; setFlip(v); apply({ flip: v }); }}>⇋ 镜像</button>
        <button className={gray ? "on" : ""} onClick={() => { const v = !gray; setGray(v); apply({ gray: v }); }}>◑ 灰度</button>
        <button className={invert ? "on" : ""} onClick={() => { const v = !invert; setInvert(v); apply({ invert: v }); }}>▣ 反色</button>
        <button onClick={() => { const v = (rot + 90) % 360; setRot(v); apply({ rot: v }); }}>⟳ 旋转</button>
      </div>
      <label className="rt-slider">
        <span>透明度 {Math.round(opacity * 100)}%</span>
        <input type="range" min={0.2} max={1} step={0.05} value={opacity} onChange={(e) => { const v = Number(e.target.value); setOpacity(v); apply({ opacity: v }); }} />
      </label>
      <label className="rt-slider">
        <span>对比 {contrast.toFixed(2)}</span>
        <input type="range" min={0.3} max={2} step={0.05} value={contrast} onChange={(e) => { const v = Number(e.target.value); setContrast(v); apply({ contrast: v }); }} />
      </label>
      <label className="rt-slider">
        <span>亮度 {bright.toFixed(2)}</span>
        <input type="range" min={0.3} max={2} step={0.05} value={bright} onChange={(e) => { const v = Number(e.target.value); setBright(v); apply({ bright: v }); }} />
      </label>
      <div className="rt-row">
        <button
          className={through ? "on" : ""}
          onClick={() => { const v = !through; setThrough(v); void invoke("set_ref_click_through", { on: v }).catch(() => {}); }}
        >
          ⤢ 点击穿透
        </button>
        <button onClick={() => { setContrast(1); setBright(1); apply({ contrast: 1, bright: 1 }); }}>复位调色</button>
      </div>
      <button
        className="rt-close"
        onClick={() => {
          apply({ closeWin: true }); // 让参考窗关
          close(); // 菜单窗自己也关，别留在桌面
        }}
      >
        ✕ 关闭参考窗
      </button>
    </div>
  );
}
