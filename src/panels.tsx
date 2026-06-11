// Dock 工作区面板（PS 式可拖拽）。
// 面板通过 DockCtx 取 App 的状态与动作 —— 面板只负责展示与转发交互，不写业务逻辑。

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { VirtuosoGrid } from "react-virtuoso";
import type { IDockviewPanelProps } from "dockview";

import type { AiCmd, Asset, Filter, SortKey } from "./types";
import { COLOR_BUCKETS, isVideo } from "./utils";
import Inspector from "./components/Inspector";
import TagTree from "./components/TagTree";
import Section from "./components/Section";
import BoardCanvas, { type BoardEditor } from "./Board";

/** 文件夹列表超过该数量时折叠显示 */
const FOLDER_CAP = 8;

export interface DockState {
  assets: Asset[];
  filter: Filter;
  setFilter: (f: Filter) => void;
  isActive: (f: Filter) => boolean;
  missingCount: number;
  findDups: () => void;
  folders: { key: string; label: string; count: number }[]; // key=父目录完整路径
  removeFolder: (dirPath: string) => void;
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
  openViewer: (id: number) => void;
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
  findSimilarFromBoard: (assetId: number) => void;
  thumbSize: number;
  setThumbSize: (n: number) => void;
  query: string;
  setQuery: (q: string) => void;
  searchMode: "name" | "semantic";
  toggleSearchMode: () => void;
  doSemantic: (q: string) => void;
}

export const DockCtx = createContext<DockState | null>(null);
const useDock = () => useContext(DockCtx)!;

function LibraryPanel(_p: IDockviewPanelProps) {
  const d = useDock();
  const [allFolders, setAllFolders] = useState(false);
  // 文件夹移除的两次确认：第一次点 ✕ 变成 ❗，2.5s 内再点才执行
  const [pendingDel, setPendingDel] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingDel) return;
    const t = setTimeout(() => setPendingDel(null), 2500);
    return () => clearTimeout(t);
  }, [pendingDel]);
  const folderList = allFolders ? d.folders : d.folders.slice(0, FOLDER_CAP);
  const hiddenFolders = d.folders.length - folderList.length;

  return (
    <aside className="sidebar">
      <div className="nav-group">
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

      <Section k="side-smart" title="智能合集">
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
      </Section>

      {d.folders.length > 0 && (
        <Section k="side-folders" title={`文件夹 · ${d.folders.length}`}>
          {folderList.map((f) => (
            <div
              key={f.key}
              className={
                "nav-item" + (d.isActive({ kind: "folder", value: f.key }) ? " active" : "")
              }
              title={f.key}
              onClick={() => d.setFilter({ kind: "folder", value: f.key })}
            >
              <span className="ellip">{f.label}</span>
              <span className="count">{f.count}</span>
              <button
                className={"folder-del" + (pendingDel === f.key ? " confirm" : "")}
                title={
                  pendingDel === f.key
                    ? "再点一次确认移除（不删原文件）"
                    : "从库移除该文件夹（不删原文件）"
                }
                onClick={(e) => {
                  e.stopPropagation();
                  if (pendingDel === f.key) {
                    setPendingDel(null);
                    d.removeFolder(f.key);
                  } else {
                    setPendingDel(f.key);
                  }
                }}
              >
                {pendingDel === f.key ? "❗" : "✕"}
              </button>
            </div>
          ))}
          {(hiddenFolders > 0 || allFolders) && d.folders.length > FOLDER_CAP && (
            <div className="nav-item more-row" onClick={() => setAllFolders(!allFolders)}>
              <span>{allFolders ? "收起" : `展开全部（还有 ${hiddenFolders} 个）`}</span>
            </div>
          )}
        </Section>
      )}

      <Section k="side-colors" title="配色">
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
      </Section>

      <Section k="side-tags" title={`标签 · ${d.tags.length}`}>
        <TagTree
          tags={d.tags}
          activeValue={d.filter.kind === "tag" ? d.filter.value : null}
          onPick={(v) => d.setFilter({ kind: "tag", value: v })}
        />
      </Section>
    </aside>
  );
}

function GridPanel(p: IDockviewPanelProps) {
  const d = useDock();
  const rootRef = useRef<HTMLElement | null>(null);

  // dockview 挪动/重停靠面板时会拆装 DOM，虚拟滚动的测量会过期 →
  // 面板可见性/尺寸变化后派发合成 scroll 事件，强制 virtuoso 重算（否则空白到下次滚动）
  useEffect(() => {
    const nudge = () =>
      requestAnimationFrame(() => {
        rootRef.current
          ?.querySelector(".grid-scroller")
          ?.dispatchEvent(new Event("scroll"));
        window.dispatchEvent(new Event("resize"));
      });
    nudge();
    const d1 = p.api.onDidVisibilityChange(nudge);
    const d2 = p.api.onDidDimensionsChange(nudge);
    return () => {
      d1.dispose();
      d2.dispose();
    };
  }, [p.api]);

  return (
    <main
      ref={rootRef}
      className="grid-wrap"
      style={{ ["--thumb-min" as string]: `${d.thumbSize}px` } as React.CSSProperties}
    >
      <div className="panel-search">
        <div className="search">
          <span className="icon">🔍</span>
          <input
            placeholder={
              d.searchMode === "semantic" ? '用大白话搜（回车）' : "搜索文件名 / 标签"
            }
            value={d.query}
            onChange={(e) => d.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && d.searchMode === "semantic") d.doSemantic(d.query);
            }}
          />
          <button
            className={"mode-toggle" + (d.searchMode === "semantic" ? " on" : "")}
            title="切换语义搜索（AI 理解大白话）"
            onClick={d.toggleSearchMode}
          >
            ✨<span className="mt-text"> 语义</span>
          </button>
        </div>
      </div>
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
            title="图标大小（也可 Ctrl+滚轮缩放）"
            value={String(d.thumbSize)}
            onChange={(e) => d.setThumbSize(Number(e.target.value))}
          >
            {![110, 156, 200, 260].includes(d.thumbSize) && (
              <option value={String(d.thumbSize)} disabled hidden>
                {d.thumbSize}px
              </option>
            )}
            <option value="110">小图标</option>
            <option value="156">中图标</option>
            <option value="200">大图标</option>
            <option value="260">超大图标</option>
          </select>
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
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  d.openViewer(a.id);
                }}
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
  return <BoardCanvas onMount={d.onBoardMount} onFindSimilar={d.findSimilarFromBoard} />;
}

export const DOCK_COMPONENTS = {
  library: LibraryPanel,
  grid: GridPanel,
  inspector: InspectorPanel,
  board: BoardPanel,
};
