// App = 编排层：持有状态、组合动作、装配工作区。
// 规则（见 docs/ARCHITECTURE.md）：
// - 不直接 invoke —— 后端调用一律走 src/api.ts
// - 不写展示 JSX 细节 —— 面板在 src/panels.tsx，组件在 src/components/
// - 不写纯算法 —— 放 src/utils.ts

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview";
import "dockview/dist/styles/dockview.css";

import type { AiCmd, Asset, Filter, Menu, SortKey } from "./types";
import { DOBBY_URL, REPO_URL, primaryBucket } from "./utils";
import * as api from "./api";
import { imageVector, textVector } from "./clip";
import { addImages, type BoardEditor, type BoardImage } from "./Board";
import { DockCtx, DOCK_COMPONENTS, type DockState } from "./panels";
import MenuBar from "./components/MenuBar";
import SettingsModal from "./components/SettingsModal";
import CmdManagerModal from "./components/CmdManagerModal";
import "./App.css";

const DOCK_KEY = "gringotts-dock-v1";

function App() {
  // ===== 状态 =====
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
  const [resultLabel, setResultLabel] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showCmdMgr, setShowCmdMgr] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [cmds, setCmds] = useState<AiCmd[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // ===== 数据加载 =====
  const reload = useCallback(async () => {
    try {
      setAssets(await api.listAssets());
    } catch (e) {
      setStatus(`加载失败：${e}`);
    }
  }, []);

  const buildThumbs = useCallback(async () => {
    try {
      setStatus("正在生成缩略图 / 提取配色…");
      const n = await api.buildThumbnails();
      if (n > 0) await reload();
      setStatus(n > 0 ? `已处理 ${n} 张（缩略图 / 配色）` : "");
    } catch (e) {
      setStatus(`处理失败：${e}`);
    }
  }, [reload]);

  const loadCmds = useCallback(async () => {
    try {
      setCmds(await api.listAiCommands());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    (async () => {
      await reload();
      loadCmds();
      buildThumbs();
    })();
  }, [reload, buildThumbs, loadCmds]);

  // ===== 后端事件 =====
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

  useEffect(() => {
    const un = listen<{ done: number; total: number }>("thumb-progress", (e) => {
      const p = e.payload;
      setProgress(p.done >= p.total ? null : p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // ===== 快捷键 =====
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

  // ===== 拖拽导入（HTML5：Tauri 拖放已关闭以便 dockview 面板可拖动）=====
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
          await api.importBlob(f.name, await fileToB64(f));
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
    const dock = dockApi.current;
    if (!dock) return;
    const p = dock.getPanel(id);
    if (p) {
      p.api.setActive();
      return;
    }
    const hasGrid = !!dock.getPanel("grid");
    dock.addPanel({
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
  function defaultLayout(dock: DockviewApi) {
    dock.addPanel({ id: "library", component: "library", title: "素材库" });
    dock.addPanel({
      id: "grid",
      component: "grid",
      title: "素材",
      position: { referencePanel: "library", direction: "right" },
    });
    dock.addPanel({
      id: "board",
      component: "board",
      title: "画板",
      position: { referencePanel: "grid", direction: "within" },
    });
    dock.addPanel({
      id: "inspector",
      component: "inspector",
      title: "详情",
      position: { referencePanel: "grid", direction: "right" },
    });
    dock.getPanel("library")?.api.setSize({ width: 216 });
    dock.getPanel("inspector")?.api.setSize({ width: 288 });
    dock.getPanel("grid")?.api.setActive();
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
    const dock = dockApi.current;
    if (!dock) return;
    localStorage.removeItem(DOCK_KEY);
    dock.clear();
    defaultLayout(dock);
  }

  // ===== 动作 =====
  function openCtxMenu(e: React.MouseEvent, a: Asset) {
    e.preventDefault();
    setSelectedId(a.id);
    setAiResult("");
    setCtx({ x: e.clientX, y: e.clientY, asset: a });
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

  async function handleImport() {
    try {
      const dir = await open({ directory: true, multiple: false });
      if (!dir || typeof dir !== "string") return;
      setBusy(true);
      setStatus("正在扫描…");
      const added = await api.importFolder(dir);
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
      const n = await api.exportMetadata(path, format);
      setStatus(`已导出 ${n} 条元数据 → ${path}`);
    } catch (e) {
      setStatus(`导出失败：${e}`);
    }
  }

  async function removeAssetAction(id: number) {
    await api.removeAsset(id);
    if (selectedId === id) setSelectedId(null);
    await reload();
  }

  async function toggleFavorite(id: number, fav: boolean) {
    await api.setFavorite(id, fav);
    await reload();
  }

  async function addTag(id: number, tag: string) {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    const next = a.tags.includes(tag) ? a.tags : [...a.tags, tag];
    await api.setTags(id, next);
    await reload();
  }
  async function removeTag(id: number, tag: string) {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    await api.setTags(id, a.tags.filter((t) => t !== tag));
    await reload();
  }
  async function applyBatchTag() {
    const t = batchTag.trim();
    if (!t || sel.size === 0) return;
    await api.addTagBulk(Array.from(sel), t);
    setBatchTag("");
    await reload();
    setStatus(`已给 ${sel.size} 项添加标签「${t}」`);
  }

  async function aiRunAction(id: number, mode: string) {
    try {
      setAiBusy(mode);
      setAiResult("");
      const out = await api.aiRun(id, mode);
      setAiResult(out);
      if (mode === "tags") await reload();
    } catch (e) {
      setAiResult(`失败：${e}`);
    } finally {
      setAiBusy(null);
    }
  }

  async function aiRunCustomAction(id: number, cmd: AiCmd) {
    try {
      setAiBusy(`c${cmd.id}`);
      setAiResult("");
      setAiResult(await api.aiRunCustom(id, cmd.prompt));
    } catch (e) {
      setAiResult(`失败：${e}`);
    } finally {
      setAiBusy(null);
    }
  }

  async function aiTagBulkAction() {
    if (sel.size === 0) return;
    try {
      setBusy(true);
      setStatus(`AI 自动打标中…（${sel.size} 项，可能较慢）`);
      const n = await api.aiTagBulk(Array.from(sel));
      await reload();
      setStatus(`已为 ${n} 项自动打标`);
    } catch (e) {
      setStatus(`批量打标失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  // ===== 搜索 / 索引（CLIP 向量在 src/clip.ts 计算）=====
  async function doSemantic(q: string) {
    if (!q.trim()) {
      setSemanticIds(null);
      return;
    }
    try {
      setBusy(true);
      setStatus("CLIP 语义搜索中…（首次加载模型稍候）");
      const ids = await api.clipSearch(await textVector(q), 80);
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
      const ids = await api.clipSimilar(id, 80);
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
      const targets = await api.clipTargets();
      if (targets.length === 0) {
        setStatus("CLIP 索引已是最新");
        return;
      }
      let done = 0;
      let seen = 0;
      for (const t of targets) {
        try {
          await api.setClipEmbedding(t.id, await imageVector(convertFileSrc(t.img)));
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

  async function findDups() {
    try {
      setBusy(true);
      setStatus("视觉去重检测中…");
      const groups = await api.findDuplicates(0.93);
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

  async function exportExtMenu() {
    try {
      const dir = await api.exportExtension();
      await openPath(dir);
      setStatus("插件已导出并打开文件夹（浏览器扩展页「加载已解压」选它即可）");
    } catch (e) {
      setStatus(`导出插件失败：${e}`);
    }
  }

  // ===== 派生数据 =====
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

  const isActive = (f: Filter) =>
    f.kind === filter.kind &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      : `配色：${filter.value}`;

  // ===== 菜单 =====
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
        { label: "GitHub 仓库", action: () => openUrl(REPO_URL) },
        { label: "关于 Gringotts", action: () => setStatus("Gringotts v0.1.0 · 素材金库") },
      ],
    },
  ];

  // ===== 面板上下文 =====
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
    aiTagBulk: aiTagBulkAction,
    busy,
    openBoardWith,
    selectedId,
    onCardClick,
    openCtxMenu,
    toggleFavorite,
    selected,
    addTag,
    removeTag,
    aiRun: aiRunAction,
    aiBusy,
    aiResult,
    onSimilar,
    cmds,
    aiRunCustom: aiRunCustomAction,
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

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-hint">📥 松开导入素材（支持文件 / 文件夹）</div>
        </div>
      )}

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
                removeAssetAction(ctx.asset.id);
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
