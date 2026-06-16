// 看球入口弹窗：输入网址或搜索词 → 开「直开」置顶小窗（Rust web_open_direct，记住几何）。
// 引擎选择与菜单同源（App 持有，双向同步）。快捷键可逐个点改（与别的软件冲突时自定义）。
import { useEffect, useState } from "react";
import * as api from "../api";

const LS_KEY = "nobi.webmirror.url";
const RECENTS_KEY = "nobi.webmirror.recents";

const ENGINE_PREFIX: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
};

// 动作 → 中文说明（顺序由后端返回，这里只查名）
const ACTION_LABEL: Record<string, string> = {
  opacityDown: "变淡",
  opacityUp: "变浓",
  titlebar: "标题栏",
  through: "点击穿透",
  zoomOut: "页面缩小",
  zoomIn: "页面放大",
  nav: "地址栏 / 搜索",
  back: "网页后退",
  forward: "网页前进",
  mute: "静音",
  shot: "截图入库",
  dock: "贴角",
  boss: "老板键",
};

// 加速键字符串（Alt+Digit1 / Alt+KeyQ / Alt+Backquote）→ 人话（Alt + 1）
function fmtAccel(a: string): string {
  return a
    .split("+")
    .map((t) => {
      if (t === "Control") return "Ctrl";
      if (t === "Super") return "Win";
      if (/^Digit\d$/.test(t)) return t.slice(5);
      if (/^Key[A-Z]$/.test(t)) return t.slice(3);
      if (t === "Backquote") return "`";
      if (t === "Minus") return "-";
      if (t === "Equal") return "=";
      if (t === "Space") return "Space";
      return t.replace(/^Arrow/, "");
    })
    .join(" + ");
}

function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(v) ? v.slice(0, 8) : [];
  } catch {
    return [];
  }
}

function normalizeUrl(s: string, engine: string): string {
  const t = s.trim();
  if (!t) return "";
  const hasProto = /^[a-z]+:\/\//i.test(t);
  const likeUrl = hasProto || (!/\s/.test(t) && /\./.test(t) && !/[一-鿿]/.test(t));
  if (likeUrl) return hasProto ? t : `https://${t}`;
  return `${ENGINE_PREFIX[engine] ?? ENGINE_PREFIX.google}${encodeURIComponent(t)}`;
}

export default function WebTVModal({
  onClose,
  engine,
  onEngine,
}: {
  onClose: () => void;
  engine: string;
  onEngine: (k: string) => void;
}) {
  const [input, setInput] = useState(() => {
    try {
      return localStorage.getItem(LS_KEY) || "";
    } catch {
      return "";
    }
  });
  const [recents] = useState<string[]>(loadRecents);
  const [err, setErr] = useState("");
  const [keys, setKeys] = useState<[string, string][]>([]);
  const [recording, setRecording] = useState<string | null>(null); // 正在录制哪个动作

  const reloadKeys = () => api.webGetKeys().then(setKeys).catch(() => {});
  useEffect(() => {
    reloadKeys();
  }, []);

  // 录制：捕获下一个按键组合 → 存为该动作的快捷键
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // 等真正的主键
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Control");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      const accel = [...mods, e.code].join("+");
      const action = recording;
      setRecording(null);
      setErr("");
      api
        .webSetKey(action, accel)
        .then(reloadKeys)
        .catch((x) => setErr(`${ACTION_LABEL[action] || action}：${x}`));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const open = async () => {
    const u = normalizeUrl(input, engine);
    if (!u) return;
    try {
      await api.webOpenDirect(u);
      try {
        localStorage.setItem(LS_KEY, u);
        const next = [u, ...loadRecents().filter((x) => x !== u)].slice(0, 8);
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      onClose();
    } catch (e) {
      setErr(`打开失败：${e}`);
    }
  };

  const resetKeys = () => {
    setErr("");
    api.webResetKeys().then(reloadKeys).catch((x) => setErr(String(x)));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>🌐 浏览窗</h3>
        <p className="modal-hint">无边框置顶小窗直开网页，登录 / 全屏正常。</p>
        <div className="webtv-pill">
          <span className="webtv-pill-icon">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <line x1="21" y1="21" x2="16.5" y2="16.5" />
            </svg>
          </span>
          <input
            autoFocus
            value={input}
            placeholder="搜索，或输入网址"
            spellCheck={false}
            list="webtv-recents"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void open();
            }}
          />
          <select
            className="webtv-pill-engine"
            value={engine}
            title="搜索词用哪个引擎"
            onChange={(e) => onEngine(e.target.value)}
          >
            <option value="google">Google</option>
            <option value="bing">Bing</option>
            <option value="baidu">百度</option>
          </select>
        </div>
        <datalist id="webtv-recents">
          {recents.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        {err && (
          <p className="modal-hint" style={{ color: "#ff9b9b" }}>
            {err}
          </p>
        )}

        <div className="webtv-keys-head">
          <span>快捷键（点右侧可改，跟别的软件冲突就换）</span>
          <button className="webtv-reset" onClick={resetKeys}>
            恢复默认
          </button>
        </div>
        <div className="webtv-keys">
          {keys.map(([action, accel]) => (
            <div key={action} className="webtv-key">
              <span className="webtv-key-desc">{ACTION_LABEL[action] || action}</span>
              <button
                className={"webtv-key-bind" + (recording === action ? " recording" : "")}
                onClick={() => setRecording(action)}
                title="点击后按下新的快捷键；Esc 取消"
              >
                {recording === action ? "按新组合… (Esc 取消)" : fmtAccel(accel)}
              </button>
            </div>
          ))}
        </div>
        <p className="modal-hint webtv-note">
          变淡/变浓、页面缩放可按住连调；老板键藏起会顺带静音。快捷键只在浏览窗可见时占用，
          藏起 / 全关即归还系统（藏起后别的软件能照常用）。
        </p>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void open()}>
            ↗ 直开
          </button>
        </div>
      </div>
    </div>
  );
}
