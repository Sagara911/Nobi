// Dock 工作区面板（PS 式可拖拽）。
// 面板通过 DockCtx 取 App 的状态与动作 —— 面板只负责展示与转发交互，不写业务逻辑。

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { VirtuosoGrid } from "react-virtuoso";
import type { IDockviewPanelProps } from "dockview";

import type {
  AiCmd,
  Asset,
  Collection,
  Cond,
  Filter,
  FolderNode,
  Scope,
  SmartFolder,
  SortKey,
} from "./types";
import { isAudio, isModel, isVideo } from "./utils";
import Inspector from "./components/Inspector";
import TagTree from "./components/TagTree";
import FolderTree from "./components/FolderTree";
import Section from "./components/Section";
import BoardCanvas, { type BoardEditor } from "./Board";
import DocEditor from "./components/DocEditor";
import AudioEditor from "./components/AudioEditor";

/** 文件夹列表超过该数量时折叠显示 */
const FOLDER_CAP = 8;

/** 网格卡片：可见(挂载)即请求按需生成缩略图(图片且还没缩略图时)；其余沿用原渲染。 */
function GridCard({
  a,
  d,
  requestThumb,
}: {
  a: Asset;
  d: DockState;
  requestThumb: (id: number) => void;
}) {
  useEffect(() => {
    if (!a.thumb && !isVideo(a) && !isAudio(a) && !isModel(a)) requestThumb(a.id);
  }, [a.id, a.thumb, requestThumb]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div
      className={
        "card" + (a.id === d.selectedId ? " selected" : "") + (d.sel.has(a.id) ? " multi" : "")
      }
      draggable={!a.missing}
      onDragStart={(e) => {
        // 接管为原生 OLE 拖放（拖到 PS/资源管理器等）：先取消 webview 自带的 HTML5 拖拽
        e.preventDefault();
        d.dragOut(a);
      }}
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
        ) : isAudio(a) ? (
          <div className="thumb-audio">
            <span className="badge-video">♪</span>
            <span className="thumb-audio-icon">♪</span>
            <span className="thumb-audio-fmt">{a.format}</span>
          </div>
        ) : isModel(a) ? (
          a.thumb ? (
            <>
              <span className="badge-video badge-3d">3D</span>
              <img src={convertFileSrc(a.thumb)} loading="lazy" alt={a.name} />
            </>
          ) : (
            <div className="thumb-audio">
              <span className="badge-video badge-3d">3D</span>
              <span className="thumb-audio-icon">◆</span>
              <span className="thumb-audio-fmt">{a.format} · 双击查看生成封面</span>
            </div>
          )
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
}

export interface DockState {
  assets: Asset[];
  scope: Scope; // 当前作用域（互斥基础集合）
  conds: Cond[]; // 叠加的细化条件（组合筛选）
  setFilter: (f: Filter) => void;
  toggleFilter: (f: Filter) => void; // 作用域类=切换；条件类=加/减叠加
  isActive: (f: Filter) => boolean;
  condLabel: (c: Cond) => string;
  removeCond: (c: Cond) => void;
  clearConds: () => void;
  smartFolders: SmartFolder[];
  saveSmartFolder: () => void;
  applySmartFolder: (sf: SmartFolder) => void;
  deleteSmartFolder: (id: string) => void;
  missingCount: number;
  trashedCount: number; // 回收站项数
  autoSync: boolean; // 文件夹实时监听开关
  toggleAutoSync: () => void;
  restoreSelected: () => void; // 回收站：恢复选中
  purgeSelected: () => void; // 回收站：彻底删除选中
  emptyTrash: () => void; // 回收站：清空
  findDups: () => void;
  requestThumb: (id: number) => void; // 卡片可见时请求按需生成缩略图
  folders: FolderNode[]; // 文件夹目录树（根节点数组）
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
  dragOut: (a: Asset) => void; // 拖出到外部应用（PS/资源管理器等）
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
  findSimilarFromBoard: (arg: { assetId?: number; src: string }) => void;
  openBoardReference: (arg: {
    assetId?: number;
    sourcePath?: string;
    src: string;
    name: string;
    width: number;
    height: number;
  }) => void;
  reverseSearchByFile: (file: File) => void;
  collections: Collection[];
  openCollection: (id: number) => void;
  createCollectionFromSel: () => void;
  addSelToCollection: (id: number) => void;
  deleteCollection: (id: number) => void;
  saveBoardAsCollection: (assetIds: number[]) => void;
  saveBoardImageToLibrary: (arg: { name: string; dataB64: string }) => Promise<
    { assetId?: number; sourcePath: string; thumb?: string } | null
  >;
  exportContactSheet: (list: Asset[], title: string) => void;
  audioAsset: Asset | null; // 音频编辑面板当前编辑的素材（null=空白可录音）
  onAudioSaved: () => void; // 另存/设封面后刷新库
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
  // 标签默认只列有归类价值的(count≥2)；count=1 的 AI 长尾收进「全部标签」
  const [allTags, setAllTags] = useState(false);
  // 文件夹移除的两次确认：第一次点 ✕ 变成 ❗，2.5s 内再点才执行
  const [pendingDel, setPendingDel] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingDel) return;
    const t = setTimeout(() => setPendingDel(null), 2500);
    return () => clearTimeout(t);
  }, [pendingDel]);
  const folderList = allFolders ? d.folders : d.folders.slice(0, FOLDER_CAP);
  const hiddenFolders = d.folders.length - folderList.length;
  const tagList = allTags ? d.tags : d.tags.filter(([, c]) => c >= 2);
  const hiddenTags = d.tags.length - tagList.length;
  // 属性筛选：库里出现过的图片格式（视频/音频不算）
  const imgFormats = useMemo(() => {
    const s = new Set<string>();
    for (const a of d.assets) if (a.format && !isVideo(a) && !isAudio(a) && !isModel(a)) s.add(a.format);
    return Array.from(s).sort();
  }, [d.assets]);

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
        <div className="side-chips">
          <button
            className={"side-chip" + (d.isActive({ kind: "favorite" }) ? " active" : "")}
            onClick={() => d.toggleFilter({ kind: "favorite" })}
          >
            ⭐ 收藏
            <span className="count">{d.assets.filter((a) => a.favorite).length}</span>
          </button>
          <button
            className="side-chip"
            onClick={d.findDups}
            title="基于 CLIP 向量检测视觉近似的重复素材"
          >
            ⧉ 重复项
          </button>
          <button
            className={"side-chip" + (d.isActive({ kind: "trash" }) ? " active" : "")}
            onClick={() => d.toggleFilter({ kind: "trash" })}
            title="回收站：被移除的素材软删除到这里，可恢复；彻底删除才真正从库清掉（始终不动原图）"
          >
            🗑 回收站
            <span className="count">{d.trashedCount}</span>
          </button>
          <button
            className={"side-chip" + (d.autoSync ? " active" : "")}
            onClick={d.toggleAutoSync}
            title="文件夹实时监听：开启后，往已导入的文件夹里加新文件会自动入库；磁盘上删掉的会标灰失效"
          >
            {d.autoSync ? "🔄 自动同步:开" : "⏸ 自动同步:关"}
          </button>
        </div>
        {d.isActive({ kind: "trash" }) && (
          <div className="trash-bar">
            <button className="trash-btn" disabled={d.sel.size === 0} onClick={d.restoreSelected}>
              恢复选中（{d.sel.size}）
            </button>
            <button className="trash-btn danger" disabled={d.sel.size === 0} onClick={d.purgeSelected}>
              彻底删除选中
            </button>
            <button className="trash-btn danger" disabled={d.trashedCount === 0} onClick={d.emptyTrash}>
              清空回收站
            </button>
          </div>
        )}
      </Section>

      {d.smartFolders.length > 0 && (
        <Section k="side-smart-folders" title={`智能文件夹 · ${d.smartFolders.length}`}>
          {d.smartFolders.map((sf) => (
            <div
              key={sf.id}
              className="nav-item"
              title={`${sf.name}（存下来的筛选条件，内容随库自动更新）`}
              onClick={() => d.applySmartFolder(sf)}
            >
              <span className="ellip">🔎 {sf.name}</span>
              <button
                className="folder-del"
                title="删除这个智能文件夹（不删素材）"
                onClick={(e) => {
                  e.stopPropagation();
                  d.deleteSmartFolder(sf.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </Section>
      )}

      {d.collections.length > 0 && (
        <Section k="side-collections" title={`合集 · ${d.collections.length}`}>
          {d.collections.map((c) => (
            <div
              key={c.id}
              className={
                "nav-item" +
                (d.isActive({ kind: "collection", value: String(c.id) }) ? " active" : "")
              }
              title={c.name}
              onClick={() =>
                d.isActive({ kind: "collection", value: String(c.id) })
                  ? d.setFilter({ kind: "all" })
                  : d.openCollection(c.id)
              }
            >
              <span className="ellip">{c.name}</span>
              <span className="count">{c.count}</span>
              <button
                className="folder-del"
                title="删除合集（不删素材）"
                onClick={(e) => {
                  e.stopPropagation();
                  if (window.confirm(`删除合集「${c.name}」？只解散分组，不删素材。`))
                    d.deleteCollection(c.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </Section>
      )}

      {d.folders.length > 0 && (
        <Section k="side-folders" title={`文件夹 · ${d.folders.length}`}>
          <FolderTree
            nodes={folderList}
            isActive={(p) => d.isActive({ kind: "folder", value: p })}
            onPick={(p) => d.toggleFilter({ kind: "folder", value: p })}
            onDelete={(p) => d.removeFolder(p)}
            pendingDel={pendingDel}
            setPendingDel={setPendingDel}
          />
          {(hiddenFolders > 0 || allFolders) && d.folders.length > FOLDER_CAP && (
            <div className="nav-item more-row" onClick={() => setAllFolders(!allFolders)}>
              <span>{allFolders ? "收起" : `展开全部（还有 ${hiddenFolders} 个）`}</span>
            </div>
          )}
        </Section>
      )}

      {d.tags.length > 0 && (
        <Section k="side-tags" title={`标签 · ${d.tags.length}`} defaultOpen={false}>
          <TagTree
            tags={tagList}
            isActive={(v) => d.isActive({ kind: "tag", value: v })}
            onPick={(v) => d.toggleFilter({ kind: "tag", value: v })}
          />
          {hiddenTags > 0 && (
            <div className="nav-item more-row" onClick={() => setAllTags(true)}>
              <span>全部标签（还有 {hiddenTags} 个）</span>
            </div>
          )}
          {allTags && d.tags.some(([, c]) => c < 2) && (
            <div className="nav-item more-row" onClick={() => setAllTags(false)}>
              <span>收起冷门标签</span>
            </div>
          )}
        </Section>
      )}

      <Section k="side-attrs" title="属性筛选" defaultOpen={false}>
        <div className="side-chips">
          {([
            ["land", "横图"],
            ["port", "竖图"],
            ["square", "方图"],
          ] as const).map(([v, label]) => (
            <button
              key={v}
              className={"side-chip" + (d.isActive({ kind: "orient", value: v }) ? " active" : "")}
              onClick={() => d.toggleFilter({ kind: "orient", value: v })}
            >
              {label}
            </button>
          ))}
          <button
            className={"side-chip" + (d.isActive({ kind: "big" }) ? " active" : "")}
            onClick={() => d.toggleFilter({ kind: "big" })}
            title="长边 ≥ 2000px"
          >
            大图
          </button>
          {imgFormats.map((fmt) => (
            <button
              key={fmt}
              className={"side-chip" + (d.isActive({ kind: "format", value: fmt }) ? " active" : "")}
              onClick={() => d.toggleFilter({ kind: "format", value: fmt })}
            >
              {fmt}
            </button>
          ))}
        </div>
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
          <label
            className="mode-toggle rev-search-zone"
            title="以图搜图：拖一张外部图到这里 / 点击选图，反查库里有没有像的（需先建 CLIP 索引）"
            onDragOver={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const f = e.dataTransfer.files?.[0];
              if (f) d.reverseSearchByFile(f);
            }}
          >
            🖼<span className="mt-text"> 以图搜图</span>
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) d.reverseSearchByFile(f);
                e.target.value = "";
              }}
            />
          </label>
        </div>
      </div>
      {d.conds.length > 0 && (
        <div className="cond-bar">
          <span className="cond-bar-label">叠加筛选(且):</span>
          {d.conds.map((c, i) => (
            <button
              key={i}
              className="cond-chip"
              title="点掉这个条件"
              onClick={() => d.removeCond(c)}
            >
              {d.condLabel(c)} <span className="cond-x">✕</span>
            </button>
          ))}
          <button className="cond-link" onClick={d.clearConds} title="清空所有条件">
            清空
          </button>
          <button
            className="cond-link save"
            onClick={d.saveSmartFolder}
            title="把当前这组条件存成侧栏的智能文件夹（内容随库自动更新）"
          >
            ＋存为智能文件夹
          </button>
        </div>
      )}
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
          {d.scope.kind === "collection" && d.displayList.length > 0 && (
            <button
              className="btn link"
              onClick={() => d.exportContactSheet(d.displayList, d.filterLabel)}
              title="把该合集排成带文件名的缩略图网格，导出 PDF"
            >
              导出 PDF
            </button>
          )}
        </span>
        <span className="grid-head-right">
          <span className="status-text">{d.status}</span>
          <span className="type-chips">
            {([
              ["image", "图片"],
              ["video", "视频"],
              ["audio", "音频"],
            ] as const).map(([val, label]) => {
              const on = d.isActive({ kind: "type", value: val });
              return (
                <button
                  key={val}
                  className={"type-chip" + (on ? " on" : "")}
                  onClick={() => d.toggleFilter({ kind: "type", value: val })}
                >
                  {label}
                </button>
              );
            })}
          </span>
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
          <button className="btn" onClick={d.createCollectionFromSel}>
            存为合集
          </button>
          <button
            className="btn"
            onClick={() =>
              d.exportContactSheet(
                d.assets.filter((a) => d.sel.has(a.id)),
                "Nobi 联系表"
              )
            }
            disabled={d.busy}
            title="把选中的图排成带文件名的缩略图网格，导出 PDF"
          >
            导出联系表 PDF
          </button>
          {d.collections.length > 0 && (
            <select
              className="cfg-input"
              value=""
              onChange={(e) => {
                if (e.target.value) d.addSelToCollection(Number(e.target.value));
              }}
              title="加入已有合集"
            >
              <option value="">加入合集…</option>
              {d.collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
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
            return <GridCard a={a} d={d} requestThumb={d.requestThumb} />;
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
      onOpen3D={d.openViewer}
    />
  );
}

function BoardPanel(_p: IDockviewPanelProps) {
  const d = useDock();
  return (
    <BoardCanvas
      onMount={d.onBoardMount}
      onFindSimilar={d.findSimilarFromBoard}
      onOpenReference={d.openBoardReference}
      onSaveAsCollection={d.saveBoardAsCollection}
      onSaveToLibrary={d.saveBoardImageToLibrary}
    />
  );
}

function DocPanel(_p: IDockviewPanelProps) {
  return <DocEditor />;
}

function AudioPanel(_p: IDockviewPanelProps) {
  const d = useDock();
  return <AudioEditor asset={d.audioAsset} onSavedNew={d.onAudioSaved} />;
}

export const DOCK_COMPONENTS = {
  library: LibraryPanel,
  grid: GridPanel,
  inspector: InspectorPanel,
  board: BoardPanel,
  doc: DocPanel,
  audio: AudioPanel,
};
