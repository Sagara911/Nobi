import {
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  createContext,
  useContext,
} from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import { VirtuosoGrid } from "react-virtuoso";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewApi,
  type IDockviewPanelProps,
} from "dockview";
import "dockview/dist/styles/dockview.css";
import { textVector, imageVector } from "./clip";
import BoardCanvas, { addImages, type BoardImage, type BoardEditor } from "./Board";
import "./App.css";

const DOBBY_URL = "https://dobby-aih.pages.dev/";
const DOCK_KEY = "gringotts-dock-v1";

interface Asset {
  id: number;
  path: string;
  name: string;
  format: string;
  width: number;
  height: number;
  sizeBytes: number;
  folder: string;
  source: string;
  author: string;
  tags: string[];
  addedAt: number;
  thumb: string;
  colors: string[];
  missing: boolean;
  favorite: boolean;
}

type Filter =
  | { kind: "all" }
  | { kind: "tag"; value: string }
  | { kind: "folder"; value: string }
  | { kind: "color"; value: string }
  | { kind: "missing" }
  | { kind: "favorite" };

type SortKey = "time" | "name" | "size";

interface AiCmd {
  id: number;
  name: string;
  prompt: string;
}

const VIDEO_FORMATS = new Set(["MP4", "WEBM", "MOV", "MKV", "AVI"]);
const isVideo = (a: Asset) => VIDEO_FORMATS.has(a.format);

function humanSize(bytes: number): string {
  if (!bytes) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

// ===== 配色分桶 =====
const COLOR_BUCKETS = [
  { key: "red", name: "红", hex: "#d04a4a" },
  { key: "orange", name: "橙", hex: "#d98a3a" },
  { key: "yellow", name: "黄", hex: "#d4c24a" },
  { key: "green", name: "绿", hex: "#5aa85a" },
  { key: "cyan", name: "青", hex: "#4ab5b5" },
  { key: "blue", name: "蓝", hex: "#4a6fd0" },
  { key: "purple", name: "紫", hex: "#8a5ad0" },
  { key: "pink", name: "粉", hex: "#d05a9a" },
  { key: "mono", name: "黑白灰", hex: "#888888" },
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function bucketOf(hex?: string): string {
  if (!hex) return "mono";
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  if (s < 0.18 || l < 0.12 || l > 0.92) return "mono";
  if (h < 15 || h >= 345) return "red";
  if (h < 45) return "orange";
  if (h < 70) return "yellow";
  if (h < 170) return "green";
  if (h < 200) return "cyan";
  if (h < 255) return "blue";
  if (h < 290) return "purple";
  return "pink";
}

// 取画面里最鲜艳的色来归类（避免暗调图全被算成黑白灰）
function primaryBucket(colors: string[]): string {
  let best = "mono";
  let bestSat = -1;
  for (const c of colors) {
    const [r, g, b] = hexToRgb(c);
    const [, s, l] = rgbToHsl(r, g, b);
    if (s >= 0.18 && l >= 0.12 && l <= 0.92 && s > bestSat) {
      bestSat = s;
      best = bucketOf(c);
    }
  }
  return best;
}

function Inspector({
  asset,
  onAddTag,
  onRemoveTag,
  onAi,
  aiBusy,
  aiResult,
  onSimilar,
  onAddBoard,
  onFav,
  cmds,
  onAiCustom,
  onManageCmds,
}: {
  asset: Asset | null;
  onAddTag: (id: number, tag: string) => void;
  onRemoveTag: (id: number, tag: string) => void;
  onAi: (id: number, mode: string) => void;
  aiBusy: string | null;
  aiResult: string;
  onSimilar: (id: number) => void;
  onAddBoard: (id: number) => void;
  onFav: (id: number, fav: boolean) => void;
  cmds: AiCmd[];
  onAiCustom: (id: number, cmd: AiCmd) => void;
  onManageCmds: () => void;
}) {
  const [tagInput, setTagInput] = useState("");
  if (!asset) {
    return (
      <section className="inspector">
        <div className="empty">从网格中选择一张素材查看详情</div>
      </section>
    );
  }
  return (
    <section className="inspector">
      {isVideo(asset) ? (
        <video className="preview" src={convertFileSrc(asset.path)} controls muted loop />
      ) : (
        <img className="preview" src={convertFileSrc(asset.path)} alt={asset.name} />
      )}
      <h3 title={asset.name}>
        <button
          className={"fav-btn inline" + (asset.favorite ? " on" : "")}
          title={asset.favorite ? "取消收藏" : "收藏"}
          onClick={() => onFav(asset.id, !asset.favorite)}
        >
          ★
        </button>{" "}
        {asset.name}
      </h3>
      <div className="dim">
        {asset.format} · {asset.width}×{asset.height} · {humanSize(asset.sizeBytes)}
      </div>

      <div className="section">
        <h5>来源</h5>
        <div className="dim">
          {asset.source || "—"}
          {asset.author ? ` · 作者 ${asset.author}` : ""}
        </div>
        <div className="dim path" title={asset.path}>
          {asset.path}
        </div>
      </div>

      <div className="section">
        <h5>标签</h5>
        <div className="tags">
          {asset.tags.map((t) => (
            <span className="tag removable" key={t} onClick={() => onRemoveTag(asset.id, t)}>
              {t} <span className="x">×</span>
            </span>
          ))}
        </div>
        <input
          className="tag-input"
          placeholder="添加标签后回车（可用 / 分层，如 场景/夜景）"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tagInput.trim()) {
              onAddTag(asset.id, tagInput.trim());
              setTagInput("");
            }
          }}
        />
      </div>

      <div className="section">
        <h5>配色</h5>
        <div className="palette">
          {asset.colors.length === 0 ? (
            <span className="dim">—</span>
          ) : (
            asset.colors.map((c, i) => (
              <div className="swatch" key={c + i} style={{ background: c }} title={c} />
            ))
          )}
        </div>
      </div>

      <div className="section">
        <h5>AI 操作</h5>
        <div className="ai-actions">
          <button className="ai-btn" disabled={!!aiBusy} onClick={() => onAi(asset.id, "prompt")}>
            {aiBusy === "prompt" ? "生成中…" : "反推绘画提示词"}
            <span className="hint">从这张图生成 SD/MJ 提示词</span>
          </button>
          <button className="ai-btn" disabled={!!aiBusy} onClick={() => onAi(asset.id, "tags")}>
            {aiBusy === "tags" ? "识别中…" : "自动打标签"}
            <span className="hint">Gemma 看图生成标签并写入</span>
          </button>
          <button className="ai-btn" disabled={!!aiBusy} onClick={() => onAi(asset.id, "describe")}>
            {aiBusy === "describe" ? "分析中…" : "分析画面"}
            <span className="hint">打光 / 构图 / 配色拉片</span>
          </button>
          <button className="ai-btn" onClick={() => onSimilar(asset.id)}>
            找相似<span className="hint">语义向量检索视觉/题材近似</span>
          </button>
          <button className="ai-btn" onClick={() => onAddBoard(asset.id)}>
            加入参考板<span className="hint">摊到无限画布上对着画</span>
          </button>
          {cmds.map((c) => (
            <button
              key={c.id}
              className="ai-btn"
              disabled={!!aiBusy}
              onClick={() => onAiCustom(asset.id, c)}
            >
              {aiBusy === `c${c.id}` ? "执行中…" : c.name}
              <span className="hint">自定义指令</span>
            </button>
          ))}
          <button className="ai-btn manage" onClick={onManageCmds}>
            ＋ 自定义指令<span className="hint">添加你自己的看图 prompt</span>
          </button>
        </div>
        {aiResult && (
          <div className="ai-result-wrap">
            <pre className="ai-result">{aiResult}</pre>
            <button
              className="btn copy"
              onClick={() => navigator.clipboard.writeText(aiResult)}
            >
              复制
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function TagTree({
  tags,
  activeValue,
  onPick,
}: {
  tags: [string, number][];
  activeValue: string | null;
  onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const m = new Map<
      string,
      { selfCount: number; children: { full: string; leaf: string; count: number }[] }
    >();
    for (const [name, count] of tags) {
      const top = name.includes("/") ? name.slice(0, name.indexOf("/")) : name;
      if (!m.has(top)) m.set(top, { selfCount: 0, children: [] });
      const g = m.get(top)!;
      if (name.includes("/")) g.children.push({ full: name, leaf: name.slice(top.length + 1), count });
      else g.selfCount += count;
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tags]);

  if (tags.length === 0)
    return <div className="nav-item child dim">（暂无，选中图片后可打标签）</div>;

  return (
    <>
      {groups.map(([top, g]) => {
        const hasChildren = g.children.length > 0;
        const isOpen = open.has(top);
        const total = g.selfCount + g.children.reduce((s, c) => s + c.count, 0);
        return (
          <div key={top}>
            <div className={"nav-item child" + (activeValue === top ? " active" : "")}>
              {hasChildren ? (
                <span
                  className="chev"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((p) => {
                      const n = new Set(p);
                      n.has(top) ? n.delete(top) : n.add(top);
                      return n;
                    });
                  }}
                >
                  {isOpen ? "▾" : "▸"}
                </span>
              ) : (
                <span className="chev placeholder">·</span>
              )}
              <span className="ellip" onClick={() => onPick(top)}>
                {top}
              </span>
              <span className="count">{total}</span>
            </div>
            {hasChildren &&
              isOpen &&
              g.children.map((c) => (
                <div
                  key={c.full}
                  className={"nav-item grandchild" + (activeValue === c.full ? " active" : "")}
                  onClick={() => onPick(c.full)}
                >
                  <span className="ellip">{c.leaf}</span>
                  <span className="count">{c.count}</span>
                </div>
              ))}
          </div>
        );
      })}
    </>
  );
}

interface AiCfg {
  aiBase: string;
  aiModel: string;
  aiKey: string;
  embedModel: string;
}

const AI_PRESETS: Record<string, AiCfg> = {
  "本地 Ollama (Gemma 4)": {
    aiBase: "http://localhost:11434/v1",
    aiModel: "gemma4:12b",
    aiKey: "ollama",
    embedModel: "bge-m3",
  },
  DeepSeek: {
    aiBase: "https://api.deepseek.com/v1",
    aiModel: "deepseek-vl2",
    aiKey: "",
    embedModel: "bge-m3",
  },
  OpenAI: {
    aiBase: "https://api.openai.com/v1",
    aiModel: "gpt-4o-mini",
    aiKey: "",
    embedModel: "text-embedding-3-small",
  },
};

function SettingsModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState<AiCfg>({ aiBase: "", aiModel: "", aiKey: "", embedModel: "" });
  const [saved, setSaved] = useState("");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [st, setSt] = useState<any>(null);
  const [pulling, setPulling] = useState(false);
  const [pullPct, setPullPct] = useState(0);
  const [pullMsg, setPullMsg] = useState("");
  const [pullName, setPullName] = useState("gemma4:12b");

  const refreshStatus = useCallback(async () => {
    try {
      setSt(await invoke("ai_status"));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    invoke<AiCfg>("get_settings").then(setF).catch(() => {});
    refreshStatus();
  }, [refreshStatus]);

  async function doPull() {
    setPulling(true);
    setPullPct(0);
    setPullMsg("开始下载…");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const un = await listen<any>("pull-progress", (e) => {
      const p = e.payload;
      if (typeof p.percent === "number" && p.percent >= 0) setPullPct(p.percent);
      if (p.status) setPullMsg(p.status);
    });
    try {
      await invoke("pull_model", { model: pullName });
      setPullMsg("下载完成 ✓");
      await refreshStatus();
    } catch (e) {
      setPullMsg(`失败：${e}`);
    } finally {
      un();
      setPulling(false);
    }
  }

  async function save() {
    try {
      await invoke("set_settings", { settings: f });
      setSaved("已保存 ✓");
      setTimeout(onClose, 600);
    } catch (e) {
      setSaved(`保存失败：${e}`);
    }
  }

  const [extMsg, setExtMsg] = useState("");
  async function exportExt() {
    try {
      const dir = await invoke<string>("export_extension");
      await openPath(dir);
      setExtMsg("插件文件夹已导出并打开 ✓ 按下面步骤在浏览器加载");
    } catch (e) {
      setExtMsg(`导出失败：${e}`);
    }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>AI 设置</h3>
        <p className="dim">
          选本地 Ollama（装了 Gemma 就用），或填你自己的 OpenAI 兼容 API（DeepSeek / GPT 等）。留空项回退默认。
        </p>

        <div className="ai-status">
          {!st ? (
            <span className="dim">检测本地 AI…</span>
          ) : !st.ollama ? (
            <div className="status-row">
              <span className="warn-text">⚠ 未检测到 Ollama（本地 Gemma 需要它）</span>
              <button className="btn" onClick={() => openUrl("https://ollama.com/download")}>
                获取 Ollama
              </button>
              <button className="btn link" onClick={refreshStatus}>
                重新检测
              </button>
            </div>
          ) : st.modelPresent ? (
            <span className="ok-text">✓ 本地 AI 就绪（{st.model}）</span>
          ) : (
            <div className="status-row col">
              <span className="dim">已检测到 Ollama，但未下载模型</span>
              <div className="status-row">
                <select
                  className="cfg-input"
                  style={{ flex: 1 }}
                  value={pullName}
                  onChange={(e) => setPullName(e.target.value)}
                  disabled={pulling}
                >
                  <option value="gemma4:12b">gemma4:12b（推荐，~7.6GB）</option>
                  <option value="gemma4:e4b">gemma4:e4b（轻量，~9.6GB）</option>
                </select>
                <button className="btn primary" onClick={doPull} disabled={pulling}>
                  {pulling ? `下载中 ${pullPct}%` : "一键下载 Gemma 4"}
                </button>
              </div>
              {pulling && (
                <div className="pull-bar">
                  <div className="pull-fill" style={{ width: `${pullPct}%` }} />
                </div>
              )}
              {pulling && <div className="dim">{pullMsg}</div>}
            </div>
          )}
        </div>

        <label>快速预设</label>
        <select
          className="cfg-input"
          defaultValue=""
          onChange={(e) => {
            const p = AI_PRESETS[e.target.value];
            if (p) setF((prev) => ({ ...prev, ...p }));
          }}
        >
          <option value="">— 选择预设 —</option>
          {Object.keys(AI_PRESETS).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label>API 地址 (Base URL)</label>
        <input
          className="cfg-input"
          value={f.aiBase}
          onChange={(e) => setF({ ...f, aiBase: e.target.value })}
          placeholder="http://localhost:11434/v1"
        />
        <label>视觉 / 对话模型</label>
        <input
          className="cfg-input"
          value={f.aiModel}
          onChange={(e) => setF({ ...f, aiModel: e.target.value })}
          placeholder="gemma4:12b"
        />
        <label>API Key</label>
        <input
          className="cfg-input"
          type="password"
          value={f.aiKey}
          onChange={(e) => setF({ ...f, aiKey: e.target.value })}
          placeholder="本地 Ollama 随便填；云端填你的 key"
        />
        <label>嵌入模型（语义搜索用）</label>
        <input
          className="cfg-input"
          value={f.embedModel}
          onChange={(e) => setF({ ...f, embedModel: e.target.value })}
          placeholder="bge-m3"
        />
        <div className="ext-section">
          <h4>浏览器采集插件</h4>
          <p className="dim">
            在网页<b>右键图片 → 「保存到 Gringotts」</b>，图片连同来源出处一起入库。安装一次即可：
          </p>
          <ol className="ext-steps dim">
            <li>点下方按钮，导出并打开插件文件夹</li>
            <li>
              浏览器打开 <code>chrome://extensions</code>（Edge 为 <code>edge://extensions</code>
              ），右上角开启「开发者模式」
            </li>
            <li>点「加载已解压的扩展程序」→ 选刚打开的文件夹</li>
            <li>保持 Gringotts 运行，去任意网页右键图片即可采集</li>
          </ol>
          <div className="status-row">
            <button className="btn primary" onClick={exportExt}>
              导出并打开插件文件夹
            </button>
            <span className="dim">{extMsg}</span>
          </div>
        </div>

        <div className="modal-actions">
          <span className="dim">{saved}</span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

interface MenuItem {
  label?: string;
  action?: () => void;
  sep?: boolean;
}
interface Menu {
  title: string;
  items: MenuItem[];
}

function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (open === null) return;
    const close = () => setOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  return (
    <div className="menubar">
      {menus.map((m, i) => (
        <div key={m.title} className="menu-wrap">
          <div
            className={"menubar-item" + (open === i ? " open" : "")}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(open === i ? null : i);
            }}
            onMouseEnter={() => {
              if (open !== null) setOpen(i);
            }}
          >
            {m.title}
          </div>
          {open === i && (
            <div className="menu-drop" onClick={(e) => e.stopPropagation()}>
              {m.items.map((it, j) =>
                it.sep ? (
                  <div key={j} className="ctx-sep" />
                ) : (
                  <div
                    key={j}
                    className="ctx-item"
                    onClick={() => {
                      setOpen(null);
                      it.action?.();
                    }}
                  >
                    {it.label}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CmdManagerModal({
  cmds,
  onChanged,
  onClose,
}: {
  cmds: AiCmd[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [msg, setMsg] = useState("");
  async function add() {
    try {
      await invoke("save_ai_command", { name, prompt });
      setName("");
      setPrompt("");
      setMsg("已添加 ✓");
      onChanged();
    } catch (e) {
      setMsg(`${e}`);
    }
  }
  async function del(id: number) {
    await invoke("delete_ai_command", { id });
    onChanged();
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>自定义 AI 指令</h3>
        <p className="dim">
          添加你自己的看图指令（如"分析透视结构""猜画师用了什么笔刷"），保存后出现在详情面板的 AI
          操作列表里。
        </p>
        {cmds.length > 0 && (
          <div className="cmd-list">
            {cmds.map((c) => (
              <div className="cmd-item" key={c.id}>
                <div className="cmd-info">
                  <b>{c.name}</b>
                  <span className="dim" title={c.prompt}>
                    {c.prompt}
                  </span>
                </div>
                <button className="btn" onClick={() => del(c.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
        <label>指令名称</label>
        <input
          className="cfg-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例：分析透视结构"
        />
        <label>指令内容（对这张图提的要求）</label>
        <textarea
          className="cfg-input"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="例：用中文分析这张图的透视类型、视平线位置和消失点，并给出临摹练习建议。"
        />
        <div className="modal-actions">
          <span className="dim">{msg}</span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={add}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

// ===== Dock 工作区（PS 式可拖拽面板）=====

interface DockState {
  assets: Asset[];
  filter: Filter;
  setFilter: (f: Filter) => void;
  isActive: (f: Filter) => boolean;
  missingCount: number;
  findDups: () => void;
  folders: [string, number][];
  colorCounts: Map<string, number>;
  tags: [string, number][];
  progress: { done: number; total: number } | null;
  semanticIds: number[] | null;
  setSemanticIds: (v: number[] | null) => void;
  resultLabel: string;
  filterLabel: string;
  displayList: Asset[];
  status: string;
  sortKey: SortKey;
  setSortKey: (k: SortKey) => void;
  sel: Set<number>;
  setSel: (s: Set<number>) => void;
  batchTag: string;
  setBatchTag: (s: string) => void;
  applyBatchTag: () => void;
  aiTagBulk: () => void;
  busy: boolean;
  openBoardWith: (l: Asset[]) => void;
  selectedId: number | null;
  onCardClick: (e: React.MouseEvent, id: number) => void;
  openCtxMenu: (e: React.MouseEvent, a: Asset) => void;
  toggleFavorite: (id: number, fav: boolean) => void;
  selected: Asset | null;
  addTag: (id: number, tag: string) => void;
  removeTag: (id: number, tag: string) => void;
  aiRun: (id: number, mode: string) => void;
  aiBusy: string | null;
  aiResult: string;
  onSimilar: (id: number) => void;
  cmds: AiCmd[];
  aiRunCustom: (id: number, cmd: AiCmd) => void;
  openCmdMgr: () => void;
  onBoardMount: (ed: BoardEditor) => void;
}

const DockCtx = createContext<DockState | null>(null);
const useDock = () => useContext(DockCtx)!;

function LibraryPanel(_p: IDockviewPanelProps) {
  const d = useDock();
  return (
    <aside className="sidebar">
      <div className="nav-group">
        <h4>资料库</h4>
        <div
          className={"nav-item" + (d.isActive({ kind: "all" }) ? " active" : "")}
          onClick={() => d.setFilter({ kind: "all" })}
        >
          <span>全部素材</span>
          <span className="count">{d.assets.length}</span>
        </div>
        {d.missingCount > 0 && (
          <div
            className={"nav-item warn" + (d.isActive({ kind: "missing" }) ? " active" : "")}
            onClick={() => d.setFilter({ kind: "missing" })}
          >
            <span>失效链接</span>
            <span className="count">{d.missingCount}</span>
          </div>
        )}
      </div>

      <div className="nav-group">
        <h4>智能合集</h4>
        <div
          className={"nav-item" + (d.isActive({ kind: "favorite" }) ? " active" : "")}
          onClick={() => d.setFilter({ kind: "favorite" })}
        >
          <span>收藏</span>
          <span className="count">{d.assets.filter((a) => a.favorite).length}</span>
        </div>
        <div className="nav-item" onClick={d.findDups} title="基于 CLIP 向量检测视觉近似的重复素材">
          <span>重复项</span>
        </div>
      </div>

      {d.folders.length > 0 && (
        <div className="nav-group">
          <h4>文件夹</h4>
          {d.folders.map(([name, count]) => (
            <div
              key={name}
              className={
                "nav-item" + (d.isActive({ kind: "folder", value: name }) ? " active" : "")
              }
              onClick={() => d.setFilter({ kind: "folder", value: name })}
            >
              <span className="ellip">{name}</span>
              <span className="count">{count}</span>
            </div>
          ))}
        </div>
      )}

      <div className="nav-group">
        <h4>配色</h4>
        <div className="color-grid">
          {COLOR_BUCKETS.map((c) => (
            <div
              key={c.key}
              className={
                "color-chip" + (d.isActive({ kind: "color", value: c.key }) ? " active" : "")
              }
              title={`${c.name} · ${d.colorCounts.get(c.key) ?? 0}`}
              onClick={() => d.setFilter({ kind: "color", value: c.key })}
            >
              <span className="dot" style={{ background: c.hex }} />
            </div>
          ))}
        </div>
      </div>

      <div className="nav-group">
        <h4>标签</h4>
        <TagTree
          tags={d.tags}
          activeValue={d.filter.kind === "tag" ? d.filter.value : null}
          onPick={(v) => d.setFilter({ kind: "tag", value: v })}
        />
      </div>
    </aside>
  );
}

function GridPanel(_p: IDockviewPanelProps) {
  const d = useDock();
  return (
    <main className="grid-wrap">
      {d.progress && d.progress.total > 0 && (
        <div className="prog-wrap" title={`处理中 ${d.progress.done}/${d.progress.total}`}>
          <div
            className="prog-fill"
            style={{ width: `${Math.round((d.progress.done / d.progress.total) * 100)}%` }}
          />
        </div>
      )}
      <div className="grid-head">
        <span>
          {d.semanticIds
            ? `${d.resultLabel || "结果"} · ${d.displayList.length} 项`
            : `${d.filterLabel} · ${d.displayList.length} 项`}
          {d.semanticIds && (
            <button className="btn link" onClick={() => d.setSemanticIds(null)}>
              退出
            </button>
          )}
        </span>
        <span className="grid-head-right">
          <span className="status-text">{d.status}</span>
          <select
            className="sort-select"
            value={d.sortKey}
            onChange={(e) => d.setSortKey(e.target.value as SortKey)}
          >
            <option value="time">最近导入</option>
            <option value="name">名称</option>
            <option value="size">大小</option>
          </select>
        </span>
      </div>

      {d.sel.size > 1 && (
        <div className="batch-bar">
          <span>已选 {d.sel.size} 项</span>
          <input
            placeholder="批量打标签后回车"
            value={d.batchTag}
            onChange={(e) => d.setBatchTag(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && d.applyBatchTag()}
          />
          <button className="btn" onClick={d.applyBatchTag}>
            打标签
          </button>
          <button className="btn primary" onClick={d.aiTagBulk} disabled={d.busy}>
            AI 自动打标
          </button>
          <button
            className="btn"
            onClick={() => d.openBoardWith(d.assets.filter((a) => d.sel.has(a.id)))}
          >
            加入画板
          </button>
          <button className="btn" onClick={() => d.setSel(new Set())}>
            清除选择
          </button>
        </div>
      )}

      {d.assets.length === 0 ? (
        <div className="empty big">
          金库还是空的
          <div className="placeholder-note">
            点右上角「导入文件夹」选一个图片目录，开始建立你的素材库
          </div>
        </div>
      ) : (
        <VirtuosoGrid
          className="grid-scroller"
          totalCount={d.displayList.length}
          listClassName="grid"
          overscan={600}
          itemContent={(i) => {
            const a = d.displayList[i];
            if (!a) return null;
            return (
              <div
                className={
                  "card" +
                  (a.id === d.selectedId ? " selected" : "") +
                  (d.sel.has(a.id) ? " multi" : "")
                }
                onClick={(e) => d.onCardClick(e, a.id)}
                onContextMenu={(e) => d.openCtxMenu(e, a)}
              >
                <div className="thumb">
                  {a.missing && <span className="badge-missing">⚠ 失效</span>}
                  <button
                    className={"fav-btn" + (a.favorite ? " on" : "")}
                    title={a.favorite ? "取消收藏" : "收藏"}
                    onClick={(e) => {
                      e.stopPropagation();
                      d.toggleFavorite(a.id, !a.favorite);
                    }}
                  >
                    ★
                  </button>
                  {isVideo(a) ? (
                    <>
                      <span className="badge-video">▶</span>
                      <video src={convertFileSrc(a.path)} preload="metadata" muted />
                    </>
                  ) : (
                    <img src={convertFileSrc(a.thumb || a.path)} loading="lazy" alt={a.name} />
                  )}
                </div>
                <div className="meta">
                  <div className="name" title={a.name}>
                    {a.name}
                  </div>
                  <div className="sub">
                    {a.format} · {a.width}×{a.height}
                  </div>
                </div>
              </div>
            );
          }}
        />
      )}
      {d.assets.length > 0 && d.displayList.length === 0 && (
        <div className="empty">
          {d.semanticIds ? "没有语义结果（先点「建索引」？）" : "没有匹配的素材"}
        </div>
      )}
    </main>
  );
}

function InspectorPanel(_p: IDockviewPanelProps) {
  const d = useDock();
  return (
    <Inspector
      asset={d.selected}
      onAddTag={d.addTag}
      onRemoveTag={d.removeTag}
      onAi={d.aiRun}
      aiBusy={d.aiBusy}
      aiResult={d.aiResult}
      onSimilar={d.onSimilar}
      onFav={d.toggleFavorite}
      onAddBoard={(id) => {
        const a = d.assets.find((x) => x.id === id);
        if (a) d.openBoardWith([a]);
      }}
      cmds={d.cmds}
      onAiCustom={d.aiRunCustom}
      onManageCmds={d.openCmdMgr}
    />
  );
}

function BoardPanel(_p: IDockviewPanelProps) {
  const d = useDock();
  return <BoardCanvas onMount={d.onBoardMount} />;
}

const DOCK_COMPONENTS = {
  library: LibraryPanel,
  grid: GridPanel,
  inspector: InspectorPanel,
  board: BoardPanel,
};

function App() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [batchTag, setBatchTag] = useState("");
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [ctx, setCtx] = useState<{ x: number; y: number; asset: Asset } | null>(null);
  const [searchMode, setSearchMode] = useState<"name" | "semantic">("name");
  const [semanticIds, setSemanticIds] = useState<number[] | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cmds, setCmds] = useState<AiCmd[]>([]);
  const [showCmdMgr, setShowCmdMgr] = useState(false);

  const loadCmds = useCallback(async () => {
    try {
      setCmds(await invoke<AiCmd[]>("list_ai_commands"));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadCmds();
  }, [loadCmds]);

  async function aiRunCustom(id: number, cmd: AiCmd) {
    try {
      setAiBusy(`c${cmd.id}`);
      setAiResult("");
      const out = await invoke<string>("ai_run_custom", { id, prompt: cmd.prompt });
      setAiResult(out);
    } catch (e) {
      setAiResult(`失败：${e}`);
    } finally {
      setAiBusy(null);
    }
  }
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [resultLabel, setResultLabel] = useState("");

  // ===== Dock 工作区 =====
  const dockApi = useRef<DockviewApi | null>(null);
  const boardEditor = useRef<BoardEditor | null>(null);
  const pendingBoard = useRef<BoardImage[]>([]);

  function toBoardImg(a: Asset): BoardImage {
    return { id: a.id, path: a.thumb || a.path, name: a.name, width: a.width, height: a.height };
  }
  function flushBoard() {
    if (boardEditor.current && pendingBoard.current.length) {
      addImages(boardEditor.current, pendingBoard.current.splice(0));
    }
  }
  function onBoardMount(ed: BoardEditor) {
    boardEditor.current = ed;
    flushBoard();
  }
  function ensurePanel(id: string, title: string) {
    const api = dockApi.current;
    if (!api) return;
    const p = api.getPanel(id);
    if (p) {
      p.api.setActive();
      return;
    }
    const hasGrid = !!api.getPanel("grid");
    api.addPanel({
      id,
      component: id,
      title,
      position: hasGrid
        ? {
            referencePanel: "grid",
            direction: id === "library" ? "left" : id === "inspector" ? "right" : "within",
          }
        : undefined,
    });
  }
  function openBoardWith(list: Asset[]) {
    pendingBoard.current.push(...list.map(toBoardImg));
    ensurePanel("board", "画板");
    setTimeout(flushBoard, 80);
  }
  function defaultLayout(api: DockviewApi) {
    api.addPanel({ id: "library", component: "library", title: "素材库" });
    api.addPanel({
      id: "grid",
      component: "grid",
      title: "素材",
      position: { referencePanel: "library", direction: "right" },
    });
    api.addPanel({
      id: "board",
      component: "board",
      title: "画板",
      position: { referencePanel: "grid", direction: "within" },
    });
    api.addPanel({
      id: "inspector",
      component: "inspector",
      title: "详情",
      position: { referencePanel: "grid", direction: "right" },
    });
    api.getPanel("library")?.api.setSize({ width: 216 });
    api.getPanel("inspector")?.api.setSize({ width: 288 });
    api.getPanel("grid")?.api.setActive();
  }
  function onDockReady(e: DockviewReadyEvent) {
    dockApi.current = e.api;
    let restored = false;
    const saved = localStorage.getItem(DOCK_KEY);
    if (saved) {
      try {
        e.api.fromJSON(JSON.parse(saved));
        restored = true;
      } catch {
        /* 布局损坏则回退默认 */
      }
    }
    if (!restored) defaultLayout(e.api);
    e.api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(DOCK_KEY, JSON.stringify(e.api.toJSON()));
      } catch {
        /* ignore */
      }
    });
  }
  function resetLayout() {
    const api = dockApi.current;
    if (!api) return;
    localStorage.removeItem(DOCK_KEY);
    api.clear();
    defaultLayout(api);
  }

  function openCtxMenu(e: React.MouseEvent, a: Asset) {
    e.preventDefault();
    setSelectedId(a.id);
    setAiResult("");
    setCtx({ x: e.clientX, y: e.clientY, asset: a });
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSel(new Set());
        setCtx(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function removeAsset(id: number) {
    await invoke("remove_asset", { id });
    if (selectedId === id) setSelectedId(null);
    await reload();
  }

  const reload = useCallback(async () => {
    try {
      const list = await invoke<Asset[]>("list_assets");
      setAssets(list);
    } catch (e) {
      setStatus(`加载失败：${e}`);
    }
  }, []);

  const buildThumbs = useCallback(async () => {
    try {
      setStatus("正在生成缩略图 / 提取配色…");
      const n = await invoke<number>("build_thumbnails");
      if (n > 0) await reload();
      setStatus(n > 0 ? `已处理 ${n} 张（缩略图 / 配色）` : "");
    } catch (e) {
      setStatus(`处理失败：${e}`);
    }
  }, [reload]);

  useEffect(() => {
    (async () => {
      await reload();
      buildThumbs();
    })();
  }, [reload, buildThumbs]);

  // 浏览器扩展采集到新图 → 自动刷新
  useEffect(() => {
    const un = listen<{ name: string }>("collected", async (e) => {
      setStatus(`已采集：${e.payload.name}`);
      await reload();
      buildThumbs();
    });
    return () => {
      un.then((f) => f());
    };
  }, [reload, buildThumbs]);

  // 缩略图生成进度（后端事件）
  useEffect(() => {
    const un = listen<{ done: number; total: number }>("thumb-progress", (e) => {
      const p = e.payload;
      setProgress(p.done >= p.total ? null : p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // 拖拽导入（HTML5：Tauri 拖放已关闭以便 dockview 面板可拖动）
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types?.includes("Files");
    const onBoard = (e: DragEvent) =>
      !!(e.target as HTMLElement | null)?.closest?.(".board-canvas");

    const fileToB64 = (f: File): Promise<string> =>
      new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] ?? "");
        r.onerror = rej;
        r.readAsDataURL(f);
      });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entryToFiles = async (entry: any): Promise<File[]> => {
      if (!entry) return [];
      if (entry.isFile)
        return new Promise((res) => entry.file((f: File) => res([f]), () => res([])));
      if (entry.isDirectory) {
        const reader = entry.createReader();
        const out: File[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const readBatch = (): Promise<any[]> =>
          new Promise((res) => reader.readEntries(res, () => res([])));
        let batch = await readBatch();
        while (batch.length) {
          for (const e of batch) out.push(...(await entryToFiles(e)));
          batch = await readBatch();
        }
        return out;
      }
      return [];
    };

    const EXT_OK = /\.(jpe?g|png|gif|webp|bmp|tiff?|avif|mp4|webm|mov|mkv|avi)$/i;

    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e) || onBoard(e)) return;
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = async (e: DragEvent) => {
      setDragOver(false);
      if (!isFileDrag(e) || onBoard(e)) return;
      e.preventDefault();
      const items = e.dataTransfer?.items;
      const files: File[] = [];
      if (items?.length) {
        const entries = Array.from(items)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((it) => (it as any).webkitGetAsEntry?.())
          .filter(Boolean);
        for (const en of entries) files.push(...(await entryToFiles(en)));
      } else if (e.dataTransfer?.files) {
        files.push(...Array.from(e.dataTransfer.files));
      }
      const ok = files.filter((f) => EXT_OK.test(f.name));
      if (!ok.length) {
        setStatus("拖入内容中没有支持的素材文件");
        return;
      }
      setBusy(true);
      let done = 0;
      for (const f of ok) {
        try {
          const dataB64 = await fileToB64(f);
          await invoke("import_blob", { name: f.name, dataB64 });
          done++;
          setStatus(`导入中… ${done}/${ok.length}`);
        } catch {
          /* 跳过失败项 */
        }
      }
      await reload();
      setStatus(`已导入 ${done} 个素材（存于 图片\\Gringotts）`);
      setBusy(false);
      buildThumbs();
    };

    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [reload, buildThumbs]);

  async function toggleFavorite(id: number, fav: boolean) {
    await invoke("set_favorite", { id, fav });
    await reload();
  }

  async function findDups() {
    try {
      setBusy(true);
      setStatus("视觉去重检测中…");
      const groups = await invoke<number[][]>("find_duplicates", { threshold: 0.93 });
      if (groups.length === 0) {
        setStatus("未发现视觉近似的重复素材 ✓");
        setSemanticIds(null);
        return;
      }
      setSemanticIds(groups.flat());
      setResultLabel(`🔁 重复项 · ${groups.length} 组`);
      setStatus(`发现 ${groups.length} 组视觉近似素材`);
    } catch (e) {
      setStatus(`去重检测失败：${e}（先点「建索引」？）`);
    } finally {
      setBusy(false);
    }
  }

  async function handleImport() {
    try {
      const dir = await open({ directory: true, multiple: false });
      if (!dir || typeof dir !== "string") return;
      setBusy(true);
      setStatus("正在扫描…");
      const added = await invoke<number>("import_folder", { path: dir });
      await reload();
      setStatus(`已导入 ${added} 张新素材`);
      await buildThumbs();
    } catch (e) {
      setStatus(`导入失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    try {
      const path = await save({
        defaultPath: "gringotts-metadata.json",
        filters: [
          { name: "JSON", extensions: ["json"] },
          { name: "CSV", extensions: ["csv"] },
        ],
      });
      if (!path) return;
      const format = path.toLowerCase().endsWith(".csv") ? "csv" : "json";
      const n = await invoke<number>("export_metadata", { path, format });
      setStatus(`已导出 ${n} 条元数据 → ${path}`);
    } catch (e) {
      setStatus(`导出失败：${e}`);
    }
  }

  async function addTag(id: number, tag: string) {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    const next = a.tags.includes(tag) ? a.tags : [...a.tags, tag];
    await invoke("set_tags", { id, tags: next });
    await reload();
  }
  async function removeTag(id: number, tag: string) {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    await invoke("set_tags", { id, tags: a.tags.filter((t) => t !== tag) });
    await reload();
  }
  async function doSemantic(q: string) {
    if (!q.trim()) {
      setSemanticIds(null);
      return;
    }
    try {
      setBusy(true);
      setStatus("CLIP 语义搜索中…（首次加载模型稍候）");
      const vector = await textVector(q);
      const ids = await invoke<number[]>("clip_search", { vector, top: 80 });
      setSemanticIds(ids);
      setResultLabel("✨ 语义结果");
      setStatus(`语义搜索：${ids.length} 个结果`);
    } catch (e) {
      setStatus(`语义搜索失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function onSimilar(id: number) {
    try {
      setBusy(true);
      setStatus("查找相似…");
      const ids = await invoke<number[]>("clip_similar", { id, top: 80 });
      setSemanticIds(ids);
      setResultLabel("🔎 相似结果");
      setStatus(`找相似：${ids.length} 个结果`);
    } catch (e) {
      setStatus(`找相似失败：${e}（先点「建索引」？）`);
    } finally {
      setBusy(false);
    }
  }

  async function buildIndex() {
    try {
      setBusy(true);
      setStatus("加载 CLIP 模型…（首次需下载，约一两分钟）");
      const targets = await invoke<{ id: number; img: string }[]>("clip_targets");
      if (targets.length === 0) {
        setStatus("CLIP 索引已是最新");
        return;
      }
      let done = 0;
      let seen = 0;
      for (const t of targets) {
        try {
          const vector = await imageVector(convertFileSrc(t.img));
          await invoke("set_clip_embedding", { id: t.id, vector });
          done++;
        } catch {
          /* 跳过单张失败 */
        }
        seen++;
        setProgress({ done: seen, total: targets.length });
        if (seen % 5 === 0 || seen === targets.length)
          setStatus(`建立 CLIP 索引… ${seen}/${targets.length}`);
      }
      setProgress(null);
      setStatus(`CLIP 索引完成：${done}/${targets.length}`);
    } catch (e) {
      setStatus(`建索引失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function aiRun(id: number, mode: string) {
    try {
      setAiBusy(mode);
      setAiResult("");
      const out = await invoke<string>("ai_run", { id, mode });
      setAiResult(out);
      if (mode === "tags") await reload();
    } catch (e) {
      setAiResult(`失败：${e}`);
    } finally {
      setAiBusy(null);
    }
  }

  async function aiTagBulk() {
    if (sel.size === 0) return;
    try {
      setBusy(true);
      setStatus(`AI 自动打标中…（${sel.size} 项，可能较慢）`);
      const n = await invoke<number>("ai_tag_bulk", { ids: Array.from(sel) });
      await reload();
      setStatus(`已为 ${n} 项自动打标`);
    } catch (e) {
      setStatus(`批量打标失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyBatchTag() {
    const t = batchTag.trim();
    if (!t || sel.size === 0) return;
    await invoke("add_tag_bulk", { ids: Array.from(sel), tag: t });
    setBatchTag("");
    await reload();
    setStatus(`已给 ${sel.size} 项添加标签「${t}」`);
  }

  function onCardClick(e: React.MouseEvent, id: number) {
    if (e.ctrlKey || e.metaKey) {
      setSel((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      setSel(new Set([id]));
    }
    setSelectedId(id);
    setAiResult("");
  }

  // ===== 侧边栏派生数据 =====
  const folders = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) if (a.folder) m.set(a.folder, (m.get(a.folder) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  }, [assets]);

  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) for (const t of a.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [assets]);

  const colorCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of assets) {
      const k = primaryBucket(a.colors);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [assets]);

  // ===== 过滤 =====
  const matchesFilter = (a: Asset) => {
    switch (filter.kind) {
      case "all":
        return true;
      case "tag":
        return a.tags.some((t) => t === filter.value || t.startsWith(filter.value + "/"));
      case "folder":
        return a.folder === filter.value;
      case "color":
        return primaryBucket(a.colors) === filter.value;
      case "missing":
        return a.missing;
      case "favorite":
        return a.favorite;
    }
  };
  const matchesQuery = (a: Asset) =>
    query.trim() === "" ||
    a.name.toLowerCase().includes(query.toLowerCase()) ||
    a.tags.some((t) => t.includes(query));

  const filtered = assets.filter((a) => matchesFilter(a) && matchesQuery(a));
  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "name") return a.name.localeCompare(b.name);
    if (sortKey === "size") return b.sizeBytes - a.sizeBytes;
    return b.addedAt - a.addedAt || b.id - a.id;
  });
  const missingCount = assets.filter((a) => a.missing).length;
  const displayList: Asset[] = semanticIds
    ? (semanticIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean) as Asset[])
    : sorted;
  const selected = assets.find((a) => a.id === selectedId) ?? null;

  async function exportExtMenu() {
    try {
      const dir = await invoke<string>("export_extension");
      await openPath(dir);
      setStatus("插件已导出并打开文件夹（浏览器扩展页「加载已解压」选它即可）");
    } catch (e) {
      setStatus(`导出插件失败：${e}`);
    }
  }

  const menus: Menu[] = [
    {
      title: "文件(F)",
      items: [
        { label: "导入文件夹…", action: handleImport },
        { sep: true },
        { label: "导出元数据…", action: handleExport },
      ],
    },
    {
      title: "编辑(E)",
      items: [
        { label: "清除选择（Esc）", action: () => setSel(new Set()) },
        { sep: true },
        { label: "检测重复项", action: findDups },
        { label: "建立语义索引", action: buildIndex },
        { label: "重新生成缩略图", action: buildThumbs },
      ],
    },
    {
      title: "工具(T)",
      items: [
        { label: "画板", action: () => ensurePanel("board", "画板") },
        { label: "Dobby 工具站", action: () => openUrl(DOBBY_URL) },
        { sep: true },
        { label: "导出浏览器采集插件…", action: exportExtMenu },
      ],
    },
    {
      title: "窗口(W)",
      items: [
        { label: "素材库", action: () => ensurePanel("library", "素材库") },
        { label: "素材", action: () => ensurePanel("grid", "素材") },
        { label: "画板", action: () => ensurePanel("board", "画板") },
        { label: "详情", action: () => ensurePanel("inspector", "详情") },
        { sep: true },
        { label: "重置布局", action: resetLayout },
      ],
    },
    {
      title: "AI",
      items: [
        { label: "AI 设置…", action: () => setShowSettings(true) },
        { label: "自定义 AI 指令…", action: () => setShowCmdMgr(true) },
      ],
    },
    {
      title: "帮助(H)",
      items: [
        {
          label: "GitHub 仓库",
          action: () => openUrl("https://github.com/Sagara911/Gringotts"),
        },
        { label: "关于 Gringotts", action: () => setStatus("Gringotts v0.1.0 · 素材金库") },
      ],
    },
  ];

  const isActive = (f: Filter) =>
    f.kind === filter.kind &&
    (f.kind === "all" || (f as any).value === (filter as any).value);

  const filterLabel =
    filter.kind === "all"
      ? "全部素材"
      : filter.kind === "missing"
      ? "失效链接"
      : filter.kind === "favorite"
      ? "⭐ 收藏"
      : filter.kind === "tag"
      ? `标签：${filter.value}`
      : filter.kind === "folder"
      ? `文件夹：${filter.value}`
      : `配色：${COLOR_BUCKETS.find((c) => c.key === filter.value)?.name ?? filter.value}`;

  const dockState: DockState = {
    assets,
    filter,
    setFilter,
    isActive,
    missingCount,
    findDups,
    folders,
    colorCounts,
    tags,
    progress,
    semanticIds,
    setSemanticIds,
    resultLabel,
    filterLabel,
    displayList,
    status,
    sortKey,
    setSortKey,
    sel,
    setSel,
    batchTag,
    setBatchTag,
    applyBatchTag,
    aiTagBulk,
    busy,
    openBoardWith,
    selectedId,
    onCardClick,
    openCtxMenu,
    toggleFavorite,
    selected,
    addTag,
    removeTag,
    aiRun,
    aiBusy,
    aiResult,
    onSimilar,
    cmds,
    aiRunCustom,
    openCmdMgr: () => setShowCmdMgr(true),
    onBoardMount,
  };

  return (
    <DockCtx.Provider value={dockState}>
    <div className="app">
      <header className="topbar">
        <div className="brand">Gringotts</div>
        <MenuBar menus={menus} />
        <div className="search">
          <span className="icon">🔍</span>
          <input
            placeholder={
              searchMode === "semantic"
                ? '用大白话搜：例 "夜景里的红发女孩"（回车）'
                : '搜索文件名 / 标签（例 "夜景" "厚涂"）'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchMode === "semantic") doSemantic(query);
            }}
          />
          <button
            className={"mode-toggle" + (searchMode === "semantic" ? " on" : "")}
            title="切换语义搜索（AI 理解大白话）"
            onClick={() => {
              const next = searchMode === "semantic" ? "name" : "semantic";
              setSearchMode(next);
              if (next === "name") setSemanticIds(null);
              else if (query.trim()) doSemantic(query);
            }}
          >
            ✨ 语义
          </button>
        </div>
        <button className="btn primary" onClick={handleImport} disabled={busy}>
          {busy ? "处理中…" : "导入文件夹"}
        </button>
      </header>

      <div className="dock-host">
        <DockviewReact
          className="dockview-theme-dark"
          components={DOCK_COMPONENTS}
          onReady={onDockReady}
        />
      </div>

      {showCmdMgr && (
        <CmdManagerModal cmds={cmds} onChanged={loadCmds} onClose={() => setShowCmdMgr(false)} />
      )}

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-hint">📥 松开导入素材（支持文件 / 文件夹）</div>
        </div>
      )}

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {ctx && (
        <>
          <div
            className="ctx-overlay"
            onClick={() => setCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx(null);
            }}
          />
          <div className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
            <div
              className="ctx-item"
              onClick={() => {
                revealItemInDir(ctx.asset.path);
                setCtx(null);
              }}
            >
              在资源管理器中显示
            </div>
            <div
              className="ctx-item"
              onClick={() => {
                openPath(ctx.asset.path);
                setCtx(null);
              }}
            >
              用默认程序打开
            </div>
            <div
              className="ctx-item"
              onClick={() => {
                navigator.clipboard.writeText(ctx.asset.path);
                setStatus("已复制路径");
                setCtx(null);
              }}
            >
              复制路径
            </div>
            <div
              className="ctx-item"
              onClick={() => {
                navigator.clipboard.writeText(ctx.asset.path);
                openUrl(DOBBY_URL);
                setStatus("已打开 Dobby（路径已复制，可直接拖图进去处理）");
                setCtx(null);
              }}
            >
              用 Dobby 处理
            </div>
            <div className="ctx-sep" />
            <div
              className="ctx-item danger"
              onClick={() => {
                removeAsset(ctx.asset.id);
                setCtx(null);
              }}
            >
              从库移除（不删原图）
            </div>
          </div>
        </>
      )}
    </div>
    </DockCtx.Provider>
  );
}

export default App;
