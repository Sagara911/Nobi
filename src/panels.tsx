// Dock 工作区面板（PS 式可拖拽）。
// 面板通过 DockCtx 取 App 的状态与动作 —— 面板只负责展示与转发交互，不写业务逻辑。

import { createContext, useContext } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { VirtuosoGrid } from "react-virtuoso";
import type { IDockviewPanelProps } from "dockview";

import type { AiCmd, Asset, Filter, SortKey } from "./types";
import { COLOR_BUCKETS, isVideo } from "./utils";
import Inspector from "./components/Inspector";
import TagTree from "./components/TagTree";
import BoardCanvas, { type BoardEditor } from "./Board";

export interface DockState {
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

export const DockCtx = createContext<DockState | null>(null);
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

export const DOCK_COMPONENTS = {
  library: LibraryPanel,
  grid: GridPanel,
  inspector: InspectorPanel,
  board: BoardPanel,
};
