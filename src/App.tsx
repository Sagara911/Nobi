import { useEffect, useState, useCallback, useMemo } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl, openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

const DOBBY_URL = "https://dobby-aih.pages.dev/";

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
}

type Filter =
  | { kind: "all" }
  | { kind: "tag"; value: string }
  | { kind: "folder"; value: string }
  | { kind: "color"; value: string }
  | { kind: "missing" };

type SortKey = "time" | "name" | "size";

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
}: {
  asset: Asset | null;
  onAddTag: (id: number, tag: string) => void;
  onRemoveTag: (id: number, tag: string) => void;
  onAi: (id: number, mode: string) => void;
  aiBusy: string | null;
  aiResult: string;
  onSimilar: (id: number) => void;
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
      <img className="preview" src={convertFileSrc(asset.path)} alt={asset.name} />
      <h3 title={asset.name}>{asset.name}</h3>
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
        <h5>
          ✨ AI 操作 <span className="dim" style={{ fontWeight: 400 }}>· Gemma 4（本地）</span>
        </h5>
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
          <button className="ai-btn" disabled>
            📌 加入参考板<span className="hint">无限画布（后续）</span>
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
                <span className="chev placeholder">🏷</span>
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
  useEffect(() => {
    invoke<AiCfg>("get_settings").then(setF).catch(() => {});
  }, []);
  async function save() {
    try {
      await invoke("set_settings", { settings: f });
      setSaved("已保存 ✓");
      setTimeout(onClose, 600);
    } catch (e) {
      setSaved(`保存失败：${e}`);
    }
  }
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>⚙️ AI 设置</h3>
        <p className="dim">
          选本地 Ollama（装了 Gemma 就用），或填你自己的 OpenAI 兼容 API（DeepSeek / GPT 等）。留空项回退默认。
        </p>
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
      setStatus("语义搜索中…");
      const ids = await invoke<number[]>("semantic_search", { query: q, top: 80 });
      setSemanticIds(ids);
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
      const ids = await invoke<number[]>("similar_to", { id, top: 80 });
      setSemanticIds(ids);
      setStatus(`找相似：${ids.length} 个结果`);
    } catch (e) {
      setStatus(`找相似失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function buildIndex() {
    try {
      setBusy(true);
      setStatus("建立语义索引中…（首次较慢，每张需 Gemma 生成描述）");
      const n = await invoke<number>("build_embeddings");
      await reload();
      setStatus(`语义索引完成：本次处理 ${n} 张`);
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

  const isActive = (f: Filter) =>
    f.kind === filter.kind &&
    (f.kind === "all" || (f as any).value === (filter as any).value);

  const filterLabel =
    filter.kind === "all"
      ? "全部素材"
      : filter.kind === "missing"
      ? "失效链接"
      : filter.kind === "tag"
      ? `标签：${filter.value}`
      : filter.kind === "folder"
      ? `文件夹：${filter.value}`
      : `配色：${COLOR_BUCKETS.find((c) => c.key === filter.value)?.name ?? filter.value}`;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          🏦 Gringotts <small>古灵阁 · 素材金库</small>
        </div>
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
        <button className="btn" onClick={() => setShowSettings(true)} title="AI 设置（本地 / 云端 API）">
          ⚙️
        </button>
        <button className="btn" onClick={buildIndex} disabled={busy} title="为素材建立语义索引（首次较慢）">
          建索引
        </button>
        <button className="btn" onClick={handleExport} title="导出元数据（不锁定）">
          导出
        </button>
        <button className="btn primary" onClick={handleImport} disabled={busy}>
          {busy ? "导入中…" : "导入文件夹"}
        </button>
      </header>

      <aside className="sidebar">
        <div className="nav-group">
          <h4>资料库</h4>
          <div
            className={"nav-item" + (isActive({ kind: "all" }) ? " active" : "")}
            onClick={() => setFilter({ kind: "all" })}
          >
            📁 <span>全部素材</span>
            <span className="count">{assets.length}</span>
          </div>
          {missingCount > 0 && (
            <div
              className={"nav-item warn" + (isActive({ kind: "missing" }) ? " active" : "")}
              onClick={() => setFilter({ kind: "missing" })}
            >
              ⚠ <span>失效链接</span>
              <span className="count">{missingCount}</span>
            </div>
          )}
        </div>

        {folders.length > 0 && (
          <div className="nav-group">
            <h4>文件夹</h4>
            {folders.map(([name, count]) => (
              <div
                key={name}
                className={
                  "nav-item" + (isActive({ kind: "folder", value: name }) ? " active" : "")
                }
                onClick={() => setFilter({ kind: "folder", value: name })}
              >
                🗂 <span className="ellip">{name}</span>
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
                  "color-chip" + (isActive({ kind: "color", value: c.key }) ? " active" : "")
                }
                title={`${c.name} · ${colorCounts.get(c.key) ?? 0}`}
                onClick={() => setFilter({ kind: "color", value: c.key })}
              >
                <span className="dot" style={{ background: c.hex }} />
                {c.name}
              </div>
            ))}
          </div>
        </div>

        <div className="nav-group">
          <h4>标签</h4>
          <TagTree
            tags={tags}
            activeValue={filter.kind === "tag" ? filter.value : null}
            onPick={(v) => setFilter({ kind: "tag", value: v })}
          />
        </div>
      </aside>

      <main className="grid-wrap">
        <div className="grid-head">
          <span>
            {semanticIds
              ? `${searchMode === "semantic" ? "✨ 语义结果" : "🔎 相似结果"} · ${displayList.length} 项`
              : `${filterLabel} · ${displayList.length} 项`}
            {semanticIds && (
              <button className="btn link" onClick={() => setSemanticIds(null)}>
                退出
              </button>
            )}
          </span>
          <span className="grid-head-right">
            <span className="status-text">{status}</span>
            <select
              className="sort-select"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              <option value="time">最近导入</option>
              <option value="name">名称</option>
              <option value="size">大小</option>
            </select>
          </span>
        </div>

        {sel.size > 1 && (
          <div className="batch-bar">
            <span>已选 {sel.size} 项</span>
            <input
              placeholder="批量打标签后回车"
              value={batchTag}
              onChange={(e) => setBatchTag(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyBatchTag()}
            />
            <button className="btn" onClick={applyBatchTag}>
              打标签
            </button>
            <button className="btn primary" onClick={aiTagBulk} disabled={busy}>
              ✨ AI 自动打标
            </button>
            <button className="btn" onClick={() => setSel(new Set())}>
              清除选择
            </button>
          </div>
        )}

        {assets.length === 0 ? (
          <div className="empty big">
            金库还是空的 🏦
            <div className="placeholder-note">
              点右上角「导入文件夹」选一个图片目录，开始建立你的素材库
            </div>
          </div>
        ) : (
          <div className="grid">
            {displayList.map((a) => (
              <div
                key={a.id}
                className={
                  "card" +
                  (a.id === selectedId ? " selected" : "") +
                  (sel.has(a.id) ? " multi" : "")
                }
                onClick={(e) => onCardClick(e, a.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelectedId(a.id);
                  setAiResult("");
                  setCtx({ x: e.clientX, y: e.clientY, asset: a });
                }}
              >
                <div className="thumb">
                  {a.missing && <span className="badge-missing">⚠ 失效</span>}
                  <img src={convertFileSrc(a.thumb || a.path)} loading="lazy" alt={a.name} />
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
            ))}
          </div>
        )}
        {assets.length > 0 && displayList.length === 0 && (
          <div className="empty">
            {semanticIds ? "没有语义结果（先点「建索引」？）" : "没有匹配的素材"}
          </div>
        )}
      </main>

      <Inspector
        asset={selected}
        onAddTag={addTag}
        onRemoveTag={removeTag}
        onAi={aiRun}
        aiBusy={aiBusy}
        aiResult={aiResult}
        onSimilar={onSimilar}
      />

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
              📂 在资源管理器中显示
            </div>
            <div
              className="ctx-item"
              onClick={() => {
                openPath(ctx.asset.path);
                setCtx(null);
              }}
            >
              🖼 用默认程序打开
            </div>
            <div
              className="ctx-item"
              onClick={() => {
                navigator.clipboard.writeText(ctx.asset.path);
                setStatus("已复制路径");
                setCtx(null);
              }}
            >
              📋 复制路径
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
              🧦 用 Dobby 处理
            </div>
            <div className="ctx-sep" />
            <div
              className="ctx-item danger"
              onClick={() => {
                removeAsset(ctx.asset.id);
                setCtx(null);
              }}
            >
              🗑 从库移除（不删原图）
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default App;
