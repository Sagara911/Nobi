// 看球入口弹窗：输入网址或搜索词 → 直接开「直开」置顶小窗（Rust web_open_direct，记住几何）。
// 引擎选择与菜单「工具→看球搜索引擎」同源（App 持有状态，双向同步）。
import { useState } from "react";
import * as api from "../api";

const LS_KEY = "nobi.webmirror.url";
const RECENTS_KEY = "nobi.webmirror.recents";

// 搜索引擎前缀（与 Rust 侧 Alt+E 一致）
const ENGINE_PREFIX: Record<string, string> = {
  google: "https://www.google.com/search?q=",
  bing: "https://www.bing.com/search?q=",
  baidu: "https://www.baidu.com/s?wd=",
};

function loadRecents(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) || "[]");
    return Array.isArray(v) ? v.slice(0, 8) : [];
  } catch {
    return [];
  }
}

// 浏览器地址栏逻辑：像网址（带协议 / 无空格且带点号且无中文）→ 直跳；否则用所选引擎搜
function normalizeUrl(s: string, engine: string): string {
  const t = s.trim();
  if (!t) return "";
  const hasProto = /^[a-z]+:\/\//i.test(t);
  const likeUrl = hasProto || (!/\s/.test(t) && /\./.test(t) && !/[一-鿿]/.test(t));
  if (likeUrl) return hasProto ? t : `https://${t}`;
  return `${ENGINE_PREFIX[engine] ?? ENGINE_PREFIX.google}${encodeURIComponent(t)}`;
}

const KEYS: [string, string][] = [
  ["Alt+1/2", "透明度 淡 / 浓"],
  ["Alt+Q/W", "页面 缩 / 放"],
  ["Alt+3", "标题栏 召出 / 收回"],
  ["Alt+4", "点击穿透 开 / 关"],
  ["Alt+E", "换台 / 搜索"],
  ["Alt+Z/X", "网页 后退 / 前进"],
  ["Alt+R", "静音 开 / 关"],
  ["Alt+S", "截图进素材库"],
  ["Alt+D", "贴角（循环四角）"],
  ["Alt+`", "老板键：藏+静音 / 恢复"],
];

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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>📺 看球小窗</h3>
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
        <div className="webtv-keys">
          {KEYS.map(([k, desc]) => (
            <div key={k} className="webtv-key">
              <kbd>{k}</kbd>
              <span>{desc}</span>
            </div>
          ))}
        </div>
        <p className="modal-hint webtv-note">
          Alt+1/2、Q/W 按住不松可连调；按键只在看球窗可见时占用，藏起 / 全关即归还系统。
        </p>
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void open()}>
            ↗ 直开
          </button>
        </div>
      </div>
    </div>
  );
}
