// App = 编排层：持有状态、组合动作、装配工作区。
// 规则（见 docs/ARCHITECTURE.md）：
// - 不直接 invoke —— 后端调用一律走 src/api.ts
// - 不写展示 JSX 细节 —— 面板在 src/panels.tsx，组件在 src/components/
// - 不写纯算法 —— 放 src/utils.ts

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertFileSrc } from "@tauri-apps/api/core";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { open, save } from "@tauri-apps/plugin-dialog";
import { check as checkUpdate, type Update } from "@tauri-apps/plugin-updater";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { listen } from "@tauri-apps/api/event";
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
} from "dockview";
import "dockview/dist/styles/dockview.css";

import type {
  AiCmd,
  Asset,
  Collection,
  Filter,
  FolderNode,
  Menu,
  SelectionTranslatePayload,
  SortKey,
} from "./types";
import { DOBBY_URL, REPO_URL, isAudio, isImage, isModel, isVideo, primaryBucket } from "./utils";
import * as api from "./api";
import { imageVector, textVector } from "./clip";
import { addImages, type BoardEditor, type BoardImage } from "./Board";
import { DockCtx, DOCK_COMPONENTS, type DockState } from "./panels";
import MenuBar from "./components/MenuBar";
import SettingsModal from "./components/SettingsModal";
import CmdManagerModal from "./components/CmdManagerModal";
import WebTVModal from "./components/WebTVModal";
import TranslationModal from "./components/TranslationModal";
import PreferencesModal from "./components/PreferencesModal";
import SavePathModal from "./components/SavePathModal";
import UpdateModal from "./components/UpdateModal";
import ImageViewer from "./components/ImageViewer";
import { buildContactSheetPdf, bytesToB64 } from "./contactSheet";
import {
  CHAT_WINDOW_LABEL,
  pushOutbox,
  getActiveConn,
  getJoinedConns,
  getProfile as getChatProfile,
  isProfileReady as isChatProfileReady,
  resolveConfig as resolveChatConfig,
  getClientId as getChatClientId,
  createBackend as createChatBackend,
} from "./chat";
import {
  SELECTION_TRANSLATE_CHIP_SIZE,
  selectionTranslatePosition,
} from "./selectionTranslatePosition";
import "./App.css";

const DOCK_KEY = "nobi-dock-v1";
const SELECTION_TRANSLATE_LABEL = "selection-translate";
const SELECTION_TRANSLATE_STORAGE_KEY = "nobi.selectionTranslate.payload";
const IMPORT_CONFIRM_THRESHOLD = 2000; // 导入超过这么多文件就弹确认
const EAGER_THUMB_MAX = 800; // 导入数 ≤ 此值才即时全量生成缩略图；更多交给"按需生成"
const LAZY_THUMB_CONCURRENCY = 3; // 按需生成的并发上限

function App() {
  // ===== 状态 =====
  const [assets, setAssets] = useState<Asset[]>([]);
  const [trashed, setTrashed] = useState<Asset[]>([]); // 回收站（软删除）
  const [autoSync, setAutoSyncState] = useState(true); // 文件夹实时监听开关
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState<Update | null>(null);
  const updateRef = useRef<Update | null>(null);
  const checkingUpdateRef = useRef(false);
  const lastUpdateCheckRef = useRef(0);
  const promptedUpdateRef = useRef("");
  const dismissedUpdateRef = useRef("");
  const [appVersion, setAppVersion] = useState("");
  const [status, setStatus] = useState("");
  // 金库模式（隐秘防护）：默认锁定 → 工具菜单不渲染浏览窗/便签项；连点版本号 5 下解锁/再锁定
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const vaultTapsRef = useRef<number[]>([]);
  const onBrandTap = useCallback(() => {
    // 暗号：2.5 秒内连点品牌区版本号 5 下，切换金库锁定态（无可见入口，老板看不到）
    const now = performance.now();
    const taps = vaultTapsRef.current.filter((t) => now - t < 2500);
    taps.push(now);
    vaultTapsRef.current = taps;
    if (taps.length >= 5) {
      vaultTapsRef.current = [];
      const next = !vaultUnlocked;
      setVaultUnlocked(next);
      void api.vaultSet(next);
      // 锁定时必须静默：状态栏一旦写「已锁定并隐藏」就等于挂牌告诉老板此处有暗格，破坏整个威胁模型
      setStatus(next ? "🔓 已解锁隐藏功能（浏览窗 / 便签）" : "");
    }
  }, [vaultUnlocked]);
  const [recentColors, setRecentColors] = useState<api.ColorPick[]>([]); // 桌面取色器最近取的颜色
  const [picking, setPicking] = useState(false); // 取色模式中（Ctrl+Alt+C 进入，光标变十字）
  const [batchTag, setBatchTag] = useState("");
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("time");
  const [ctx, setCtx] = useState<{ x: number; y: number; asset: Asset } | null>(null);
  const [viewer, setViewer] = useState<{ list: Asset[]; index: number } | null>(null);
  const refSeq = useRef(0); // 悬浮参考浮窗的唯一 label 序号
  const ctxRef = useRef<HTMLDivElement | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  // 当前合集筛选下的成员 id（filter.kind==="collection" 时由 matchesFilter 用）
  const [collectionMembers, setCollectionMembers] = useState<Set<number>>(new Set());
  const [searchMode, setSearchMode] = useState<"name" | "semantic">("name");
  const [semanticIds, setSemanticIds] = useState<number[] | null>(null);
  const [resultLabel, setResultLabel] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showCmdMgr, setShowCmdMgr] = useState(false);
  const [showWebTV, setShowWebTV] = useState(false); // 看球入口弹窗（输网址→直开置顶小窗）
  const [showTranslation, setShowTranslation] = useState(false);
  const [showPrefs, setShowPrefs] = useState(false); // 首选项·快捷键
  const [showSavePath, setShowSavePath] = useState(false); // 素材保存路径
  // 看球搜索引擎（Alt+E 换台与入口弹窗共用）；前端存 localStorage，Rust 侧由命令同步持久化
  const [webEngine, setWebEngine] = useState(() => {
    try {
      return localStorage.getItem("nobi.webmirror.engine") || "google";
    } catch {
      return "google";
    }
  });
  function pickWebEngine(k: string) {
    setWebEngine(k);
    try {
      localStorage.setItem("nobi.webmirror.engine", k);
    } catch {
      /* ignore */
    }
    api.setWebSearchEngine(k).catch(() => {});
    const label = { google: "Google", bing: "Bing", baidu: "百度" }[k] ?? k;
    setStatus(`浏览窗搜索引擎已切到 ${label}`);
  }
  const [dragOver, setDragOver] = useState(false);
  const [cmds, setCmds] = useState<AiCmd[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [autostartOn, setAutostartOn] = useState(false);
  const [selTranslateOn, setSelTranslateOn] = useState(true);
  const [thumbSize, setThumbSizeState] = useState<number>(() =>
    Number(localStorage.getItem("thumb-size")) || 156
  );
  const setThumbSize = (n: number) => {
    setThumbSizeState(n);
    localStorage.setItem("thumb-size", String(n));
  };

  useEffect(() => {
    updateRef.current = update;
  }, [update]);

  // 开机自启 + 划词翻译开关：读当前状态
  useEffect(() => {
    api.getAutostart().then(setAutostartOn).catch(() => {});
    api.getSelectionTranslateEnabled().then(setSelTranslateOn).catch(() => {});
  }, []);

  async function toggleAutostart() {
    const next = !autostartOn;
    try {
      await api.setAutostart(next);
      setAutostartOn(next);
      setStatus(next ? "已开启开机自启" : "已关闭开机自启");
    } catch (e) {
      setStatus(`开机自启设置失败：${String(e)}`);
    }
  }

  async function toggleSelectionTranslate() {
    const next = !selTranslateOn;
    try {
      await api.setSelectionTranslateEnabled(next);
      setSelTranslateOn(next);
      setStatus(next ? "已开启划词右键翻译" : "已关闭划词右键翻译");
    } catch (e) {
      setStatus(`划词翻译设置失败：${String(e)}`);
    }
  }

  // 主窗后台订阅所有"已加入连接"(档案+房间)：没在看的群来消息→托盘红点（聊天窗全关也能提醒）。
  // 主窗只要 Nobi 开着就活着，是天然的常驻订阅点。不同连接用各自档案的服务器。
  useEffect(() => {
    const clientId = getChatClientId();
    const backends = new Map<string, ReturnType<typeof createChatBackend>>();
    let stopped = false;
    const keyOf = (pid: string, room: string) => `${pid}\0${room}`;

    const reconcile = () => {
      if (stopped) return;
      for (const { profileId, room } of getJoinedConns()) {
        const k = keyOf(profileId, room);
        if (backends.has(k)) continue;
        const profile = getChatProfile(profileId);
        if (!profile || !isChatProfileReady(profile)) continue;
        const b = createChatBackend(resolveChatConfig(profile, room));
        backends.set(k, b);
        const label = `chat-${`${profileId}-${room}`.replace(/[^\w-]/g, "_")}`;
        b.onMessage((m) => {
          if (m.clientId === clientId) return; // 自己发的不提醒
          if (m.body && m.body.charCodeAt(0) < 0x08) return; // 游戏/系统帧(控制字符前缀)不是聊天消息，不提醒/不闪
          // 直接查该群窗口是否"打开+聚焦+可见"——只有正在看时才不提醒，
          // 比依赖易残留的本地标记可靠（关窗/藏起/在后台都会正常提醒）
          void (async () => {
            const w = await WebviewWindow.getByLabel(label).catch(() => null);
            if (w) {
              const [focused, visible] = await Promise.all([
                w.isFocused().catch(() => false),
                w.isVisible().catch(() => false),
              ]);
              if (focused && visible) return; // 正在看这个群
            }
            void api.chatBumpUnread(label); // 托盘红点 + 任务栏红角标 + 闪烁
          })();
        });
        void b.connect();
      }
    };

    reconcile();
    const timer = window.setInterval(reconcile, 4000); // 新进的连接也补订上
    return () => {
      stopped = true;
      window.clearInterval(timer);
      backends.forEach((b) => void b.disconnect());
    };
  }, []);

  const createSelectionTranslateWindow = useCallback(() => {
    const win = new WebviewWindow(SELECTION_TRANSLATE_LABEL, {
      url: "index.html#selection-translate",
      title: "Nobi 翻译",
      width: SELECTION_TRANSLATE_CHIP_SIZE.width,
      height: SELECTION_TRANSLATE_CHIP_SIZE.height,
      minWidth: 96,
      minHeight: 40,
      decorations: false,
      transparent: true,
      backgroundColor: "#00000000",
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      shadow: false,
      focus: false,
      focusable: true,
      visible: false,
    });

    win.once("tauri://error", (e) => {
      setStatus(`划词翻译浮窗打开失败：${String(e.payload)}`);
    });

    return win;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        const existing = await WebviewWindow.getByLabel(SELECTION_TRANSLATE_LABEL).catch(
          () => null,
        );
        if (cancelled || existing) return;
        try {
          localStorage.removeItem(SELECTION_TRANSLATE_STORAGE_KEY);
        } catch {
          /* ignore */
        }
        createSelectionTranslateWindow();
      })();
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [createSelectionTranslateWindow]);

  // ===== 数据加载 =====
  const reload = useCallback(async () => {
    try {
      setAssets(await api.listAssets());
      api.listTrashed().then(setTrashed).catch(() => {}); // 回收站单独拉，不挡主列表
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

  // 缩略图「按需生成」：网格卡片可见时请求；并发受限的队列，结果批量回填到 assets（thumb+配色）。
  const thumbDone = useRef<Set<number>>(new Set());
  const thumbInflight = useRef<Set<number>>(new Set());
  const thumbQueue = useRef<number[]>([]);
  const thumbPatches = useRef<Map<number, { thumb: string; colors: string[] }>>(new Map());
  const pumpThumbs = useCallback(() => {
    while (thumbInflight.current.size < LAZY_THUMB_CONCURRENCY && thumbQueue.current.length) {
      const id = thumbQueue.current.shift()!;
      if (thumbDone.current.has(id) || thumbInflight.current.has(id)) continue;
      thumbInflight.current.add(id);
      api
        .ensureThumb(id)
        .then((res) => {
          if (res && res.thumb) thumbPatches.current.set(id, { thumb: res.thumb, colors: res.colors });
          thumbDone.current.add(id);
        })
        .catch(() => {})
        .finally(() => {
          thumbInflight.current.delete(id);
          pumpThumbs();
        });
    }
  }, []);
  const requestThumb = useCallback(
    (id: number) => {
      if (thumbDone.current.has(id) || thumbInflight.current.has(id)) return;
      thumbQueue.current.push(id);
      pumpThumbs();
    },
    [pumpThumbs],
  );
  // 批量回填：每 400ms 把生成好的缩略图/配色一次性 patch 进 assets（避免每张都触发大数组重渲染）
  useEffect(() => {
    const t = window.setInterval(() => {
      if (thumbPatches.current.size === 0) return;
      const patches = thumbPatches.current;
      thumbPatches.current = new Map();
      setAssets((prev) => prev.map((a) => {
        const p = patches.get(a.id);
        return p ? { ...a, thumb: p.thumb, colors: p.colors } : a;
      }));
    }, 400);
    return () => window.clearInterval(t);
  }, []);

  const loadCmds = useCallback(async () => {
    try {
      setCmds(await api.listAiCommands());
    } catch {
      /* ignore */
    }
  }, []);

  const loadCollections = useCallback(async () => {
    try {
      setCollections(await api.listCollections());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    (async () => {
      await reload();
      loadCmds();
      loadCollections();
      api.getAutoSync().then(setAutoSyncState).catch(() => {});
      // 不再开局全量生成缩略图（大库会卡死）——改成网格滚到哪生成哪（见 requestThumb）
      // 失效链接检测移到后台跑：不阻塞首屏（大库时逐条 stat 磁盘会卡死），算完再回填 missing 标记
      try {
        const ids = await api.checkMissing();
        if (ids.length) {
          const s = new Set(ids);
          setAssets((prev) => prev.map((a) => (s.has(a.id) ? { ...a, missing: true } : a)));
        }
      } catch {
        /* ignore */
      }
    })();
  }, [reload, buildThumbs, loadCmds, loadCollections]);

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

  const openSelectionTranslatePopover = useCallback(
    async (payload: SelectionTranslatePayload) => {
      const text = payload.text.trim();
      if (!text) return;

      const saved = { ...payload, text };
      try {
        localStorage.setItem(SELECTION_TRANSLATE_STORAGE_KEY, JSON.stringify(saved));
      } catch {
        /* ignore */
      }

      const send = async (win: WebviewWindow) => {
        await win.setSize(SELECTION_TRANSLATE_CHIP_SIZE).catch(() => {});
        await win
          .setPosition(
            await selectionTranslatePosition(payload.x, payload.y, SELECTION_TRANSLATE_CHIP_SIZE),
          )
          .catch(() => {});
        await win.show().catch(() => {});
        await emitTo(SELECTION_TRANSLATE_LABEL, "selection-translate-payload", saved).catch(
          () => {},
        );
      };

      const existing = await WebviewWindow.getByLabel(SELECTION_TRANSLATE_LABEL);
      if (existing) {
        await send(existing);
        return;
      }

      const win = createSelectionTranslateWindow();
      win.once("tauri://created", () => {
        window.setTimeout(() => void send(win), 20);
      });
    },
    [createSelectionTranslateWindow]
  );

  useEffect(() => {
    const un = listen<SelectionTranslatePayload>("selection-translate-requested", (e) => {
      void openSelectionTranslatePopover(e.payload);
    });
    return () => {
      un.then((f) => f());
    };
  }, [openSelectionTranslatePopover]);

  // MCP 本地接口（mcp_api.rs）触发的事件：智能体加图上画板 / 库被外部修改
  const assetsRef = useRef<Asset[]>([]);
  assetsRef.current = assets;
  const openBoardWithRef = useRef<(l: Asset[]) => void>(() => {});
  openBoardWithRef.current = openBoardWith;
  useEffect(() => {
    const un1 = listen<{ ids: number[] }>("mcp-add-to-board", (e) => {
      const list = assetsRef.current.filter((a) => e.payload.ids.includes(a.id));
      if (list.length) {
        openBoardWithRef.current(list);
        setStatus(`MCP：已把 ${list.length} 张素材加入画板`);
      }
    });
    const un2 = listen("library-changed", async () => {
      await reload();
      // 监听到文件夹变化(含磁盘删除)→重算失效，让被删/移走的素材实时标灰
      try {
        const ids = await api.checkMissing();
        const s = new Set(ids);
        setAssets((prev) => prev.map((a) => ({ ...a, missing: s.has(a.id) })));
      } catch {
        /* ignore */
      }
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
    };
  }, [reload]);

  useEffect(() => {
    const un = listen<{ done: number; total: number }>("thumb-progress", (e) => {
      const p = e.payload;
      setProgress(p.done >= p.total ? null : p);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  // 桌面取色器（Ctrl+Alt+C）：进入取色模式 → 点击取色 → 复制 hex + 进最近色板
  useEffect(() => {
    const unArmed = listen("color-pick-armed", () => setPicking(true));
    const unDisarmed = listen("color-pick-disarmed", () => setPicking(false));
    const unPicked = listen<api.ColorPick>("color-picked", (e) => {
      const c = e.payload;
      setPicking(false);
      navigator.clipboard.writeText(c.hex).catch(() => {});
      setRecentColors((prev) => [c, ...prev.filter((x) => x.hex !== c.hex)].slice(0, 12));
      setStatus(`已取色 ${c.hex} · rgb(${c.r}, ${c.g}, ${c.b})（hex 已复制）`);
    });
    return () => {
      unArmed.then((f) => f());
      unDisarmed.then((f) => f());
      unPicked.then((f) => f());
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

  // Ctrl+滚轮：网格上缩放图标（Windows 资源管理器式）；同时阻止 webview 页面缩放。
  // 必须用原生非被动监听（React 的 onWheel 是 passive，无法 preventDefault）。
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if ((e.target as HTMLElement | null)?.closest?.(".grid-wrap")) {
        setThumbSizeState((s) => {
          const next = Math.min(320, Math.max(90, s + (e.deltaY < 0 ? 12 : -12)));
          localStorage.setItem("thumb-size", String(next));
          return next;
        });
      }
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, []);

  // ===== 拖拽导入（HTML5：Tauri 拖放已关闭以便 dockview 面板可拖动）=====
  useEffect(() => {
    const isFileDrag = (e: DragEvent) => !!e.dataTransfer?.types?.includes("Files");
    // 画板根容器是 .bd-root（旧选择器 .board-canvas 已无对应元素）：拖到画板上的图
    // 归画板自己处理（直接上板、不入库），不走全局导入。
    const onBoard = (e: DragEvent) =>
      !!(e.target as HTMLElement | null)?.closest?.(".bd-root, .board-canvas");
    // 「以图搜图」拖放区：归它自己处理，不走全局导入
    const onRev = (e: DragEvent) =>
      !!(e.target as HTMLElement | null)?.closest?.(".rev-search-zone");

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

    const EXT_OK =
      /\.(jpe?g|png|gif|webp|bmp|tiff?|avif|mp4|webm|mov|mkv|avi|glb|gltf|obj|fbx|stl)$/i;

    const onDragOver = (e: DragEvent) => {
      if (!isFileDrag(e) || onBoard(e) || onRev(e)) return;
      e.preventDefault();
      setDragOver(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDragOver(false);
    };
    const onDrop = async (e: DragEvent) => {
      setDragOver(false);
      if (!isFileDrag(e) || onBoard(e) || onRev(e)) return;
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
      setStatus(`已导入 ${done} 个素材（存于 图片\\Nobi；外链 GLTF 建议用“导入文件夹”）`);
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
    // LOD：原图与缩略图两个地址都传给画板，由 ImageNode 按显示尺寸自动切换
    return { id: a.id, path: a.path, thumb: a.thumb, name: a.name, width: a.width, height: a.height };
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
    // 音频无画面、3D 原文件画板加载不了（缩略图顶不住放大换原图）——直接过滤
    const visual = list.filter((a) => !isAudio(a) && !isModel(a));
    if (!visual.length) {
      setStatus("音频 / 3D 素材无法加入画板");
      return;
    }
    pendingBoard.current.push(...visual.map(toBoardImg));
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

    // 所有分组设最小尺寸，防止被拖成"一条缝"导致文字竖排
    const applyConstraints = () => {
      for (const g of e.api.groups) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (g.api as any).setConstraints?.({ minimumWidth: 170, minimumHeight: 120 });
        } catch {
          /* ignore */
        }
      }
    };
    applyConstraints();

    e.api.onDidLayoutChange(() => {
      applyConstraints();
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

  // 右键菜单贴边夹住：靠近屏幕底/右时向上/左翻，避免被裁切看不见
  useLayoutEffect(() => {
    const el = ctxRef.current;
    if (!el || !ctx) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    if (ctx.y + r.height > window.innerHeight)
      el.style.top = `${Math.max(pad, window.innerHeight - r.height - pad)}px`;
    if (ctx.x + r.width > window.innerWidth)
      el.style.left = `${Math.max(pad, window.innerWidth - r.width - pad)}px`;
  }, [ctx]);

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
      // 导入前先报体量：超大文件夹弹确认，防手滑把几万张整个怼进来
      const count = await api.countFolderMedia(dir).catch(() => 0);
      if (
        count > IMPORT_CONFIRM_THRESHOLD &&
        !window.confirm(
          `这个文件夹里有 ${count.toLocaleString()} 个图片/视频/音频文件，确定全部导入吗？\n\n` +
            `数量较大：缩略图会在你浏览时「按需生成」(不会一次性卡住)，但库会比较大。\n` +
            `也可以只导其中的子文件夹。`,
        )
      )
        return;
      setBusy(true);
      setStatus("正在扫描…");
      const added = await api.importFolder(dir);
      await reload();
      setStatus(`已导入 ${added} 张新素材`);
      // 小批量直接生成缩略图(快)；大批量交给"按需生成"(滚到哪生成哪)，避免一次性全量卡死
      if (added > 0 && added <= EAGER_THUMB_MAX) await buildThumbs();
    } catch (e) {
      setStatus(`导入失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    try {
      const path = await save({
        defaultPath: "nobi-metadata.json",
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

  /** 批量从库移除当前多选 → 进回收站（可恢复，不删原图） */
  async function removeSelectedAction() {
    const ids = Array.from(sel);
    if (!ids.length) return;
    const n = await api.removeAssets(ids);
    setSel(new Set());
    if (selectedId !== null && ids.includes(selectedId)) setSelectedId(null);
    await reload();
    setStatus(`已移入回收站 ${n} 张（可恢复，原图未动）`);
  }

  /** 回收站：恢复选中 */
  async function restoreSelectedAction() {
    const ids = Array.from(sel);
    if (!ids.length) return;
    const n = await api.restoreAssets(ids);
    setSel(new Set());
    await reload();
    setStatus(`已恢复 ${n} 项`);
  }

  /** 回收站：彻底删除选中（不可恢复，仍不动原图） */
  async function purgeSelectedAction() {
    const ids = Array.from(sel);
    if (!ids.length) return;
    if (!window.confirm(`彻底删除选中的 ${ids.length} 项？不可恢复（原图不动，但 Nobi 里的标签/收藏/合集会一起没）。`))
      return;
    const n = await api.purgeAssets(ids);
    setSel(new Set());
    await reload();
    setStatus(`已彻底删除 ${n} 项`);
  }

  /** 回收站：清空 */
  async function emptyTrashAction() {
    if (!trashed.length) return;
    if (!window.confirm(`清空回收站？将彻底删除 ${trashed.length} 项，不可恢复（原图不动）。`)) return;
    const n = await api.emptyTrash();
    setSel(new Set());
    await reload();
    setStatus(`已清空回收站（彻底删除 ${n} 项）`);
  }

  /** 文件夹实时监听总开关 */
  async function toggleAutoSyncAction() {
    const next = !autoSync;
    setAutoSyncState(next);
    try {
      await api.setAutoSync(next);
      setStatus(next ? "已开启文件夹实时监听" : "已关闭文件夹实时监听");
    } catch {
      setAutoSyncState(!next);
    }
  }

  /** 整个文件夹（含所有子文件夹）从库移除（按路径前缀级联，不删原文件） */
  async function removeFolderAction(dirPath: string) {
    const ids = assets.filter((a) => isUnder(a.path, dirPath)).map((a) => a.id);
    if (!ids.length) return;
    const n = await api.removeAssets(ids);
    // 当前正看的文件夹若被这次级联删掉，回到「全部」
    if (filter.kind === "folder" && (filter.value === dirPath || isUnder(filter.value, dirPath)))
      setFilter({ kind: "all" });
    setSel(new Set());
    setSelectedId(null);
    await reload();
    setStatus(`已移除文件夹「${lastSeg(dirPath)}」及其子文件夹的 ${n} 张素材（原文件未动）`);
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

  // 拖外部图反查「库里有没有像的」：算外部图 CLIP 向量 → clipSearch 比对库
  async function reverseSearchByFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setStatus("以图搜图：请拖入图片文件");
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      setBusy(true);
      setStatus("以图搜图：计算向量…（首次需加载 CLIP 模型）");
      const vec = await imageVector(url);
      const ids = await api.clipSearch(vec, 80);
      setSemanticIds(ids);
      setResultLabel(`🖼 以图搜图：${file.name}`);
      ensurePanel("grid", "素材");
      setStatus(`以图搜图：${ids.length} 个结果`);
    } catch (e) {
      setStatus(`以图搜图失败：${e}（先点「建索引」让库里图有向量？）`);
    } finally {
      URL.revokeObjectURL(url);
      setBusy(false);
    }
  }

  // 画板图片右键「找库里相似图」：有 assetId 直接 clip_similar；否则用图自身像素算向量反查
  async function findSimilarFromBoard(arg: { assetId?: number; src: string }) {
    ensurePanel("grid", "素材");
    if (arg.assetId != null) {
      onSimilar(arg.assetId);
      return;
    }
    try {
      setBusy(true);
      setStatus("以图找相似…（计算向量）");
      const ids = await api.clipSearch(await imageVector(arg.src), 80);
      setSemanticIds(ids);
      setResultLabel("🔎 相似结果");
      setStatus(`找相似：${ids.length} 个结果`);
    } catch (e) {
      setStatus(`找相似失败：${e}（先点「建索引」让库里图有向量？）`);
    } finally {
      setBusy(false);
    }
  }

  function openBoardReference(arg: {
    assetId?: number;
    sourcePath?: string;
    src: string;
    name: string;
    width: number;
    height: number;
  }) {
    const asset = arg.assetId != null ? assets.find((a) => a.id === arg.assetId) : null;
    const path = arg.sourcePath || asset?.path;
    if (!path) {
      setStatus("这张画板图片没有本地文件路径，暂时不能悬浮到桌面");
      return;
    }
    openRefWindowFromPath({
      path,
      name: arg.name || asset?.name || "画板参考图",
      width: arg.width || asset?.width,
      height: arg.height || asset?.height,
      labelHint: arg.assetId != null ? `board-${arg.assetId}` : "board",
    });
    setStatus("已打开桌面悬浮参考图");
  }

  // 导出联系表 PDF：一组素材排成带文件名的缩略图网格图集，发给客户/同事
  async function exportContactSheet(list: Asset[], title: string) {
    if (!list.length) {
      setStatus("没有可导出的素材");
      return;
    }
    try {
      setBusy(true);
      setStatus(`生成联系表 PDF…（${list.length} 张）`);
      const items = list.map((a) => ({ src: convertFileSrc(a.thumb || a.path), name: a.name }));
      const b64 = bytesToB64(await buildContactSheetPdf(items, title || "Nobi 联系表"));
      const safe = (title || "contact-sheet").replace(/[\\/:*?"<>|]/g, "_");
      try {
        const path = await save({
          defaultPath: `${safe}.pdf`,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (path) {
          await api.saveFile(path, b64);
          setStatus(`已导出联系表：${path}`);
        } else setStatus("");
      } catch {
        // 浏览器环境：退回 <a download>
        const a = document.createElement("a");
        a.href = "data:application/pdf;base64," + b64;
        a.download = `${safe}.pdf`;
        a.click();
      }
    } catch (e) {
      setStatus(`导出联系表失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  // ===== 合集 =====
  async function openCollection(id: number) {
    try {
      const ids = await api.collectionAssetIds(id);
      setCollectionMembers(new Set(ids));
      setSemanticIds(null);
      setFilter({ kind: "collection", value: String(id) });
    } catch (e) {
      setStatus(`打开合集失败：${e}`);
    }
  }

  async function createCollectionFromSel() {
    const ids = Array.from(sel);
    if (!ids.length) return;
    const name = window.prompt(`新建合集（${ids.length} 张），起个名字：`, "");
    if (name == null || !name.trim()) return;
    try {
      const id = await api.createCollection(name.trim(), ids);
      await loadCollections();
      setStatus(`已建合集「${name.trim()}」（${ids.length} 张）`);
      openCollection(id);
    } catch (e) {
      setStatus(`建合集失败：${e}`);
    }
  }

  async function addSelToCollection(id: number) {
    const ids = Array.from(sel);
    if (!ids.length) return;
    try {
      const n = await api.addToCollection(id, ids);
      await loadCollections();
      if (filter.kind === "collection" && filter.value === String(id)) openCollection(id);
      setStatus(`已加入合集：新增 ${n} 张`);
    } catch (e) {
      setStatus(`加入合集失败：${e}`);
    }
  }

  // 画板「存成合集回库」：把画板上来自库的图按 assetId 攒成一个合集
  async function saveBoardAsCollection(assetIds: number[]) {
    if (!assetIds.length) {
      setStatus("画板上没有来自素材库的图（外部拖入的图未入库）");
      return;
    }
    const name = window.prompt(`把画板存成合集（${assetIds.length} 张），起个名字：`, "情绪板");
    if (name == null || !name.trim()) return;
    try {
      const id = await api.createCollection(name.trim(), assetIds);
      await loadCollections();
      setStatus(`已把画板存成合集「${name.trim()}」（${assetIds.length} 张）`);
      openCollection(id);
    } catch (e) {
      setStatus(`存成合集失败：${e}`);
    }
  }

  // 画板图片右键「保存到素材库」：把临时拖入（仅在画板上、未入库）的图落盘 + 入库，
  // 刷新素材网格，并回传 asset 信息让画板把该图标记为「已入库」。
  async function saveBoardImageToLibrary(arg: { name: string; dataB64: string }) {
    try {
      const info = await api.importBlob(arg.name, arg.dataB64);
      const list = await api.listAssets();
      setAssets(list);
      buildThumbs();
      const a = list.find((x) => x.path === info.path);
      setStatus(`已保存到素材库：${info.name}`);
      return a
        ? { assetId: a.id, sourcePath: a.path, thumb: a.thumb }
        : { sourcePath: info.path };
    } catch (e) {
      setStatus(`保存到素材库失败：${e}`);
      return null;
    }
  }

  async function deleteCollectionAction(id: number) {
    try {
      await api.deleteCollection(id);
      await loadCollections();
      if (filter.kind === "collection" && filter.value === String(id)) {
        setFilter({ kind: "all" });
        setCollectionMembers(new Set());
      }
      setStatus("已删除合集（不删素材）");
    } catch (e) {
      setStatus(`删除合集失败：${e}`);
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
      const step = Math.max(1, Math.floor(targets.length / 100)); // 进度限频：大库时别每张都 setState 刷爆 UI
      for (const t of targets) {
        try {
          await api.setClipEmbedding(t.id, await imageVector(convertFileSrc(t.img)));
          done++;
        } catch {
          /* 跳过单张失败 */
        }
        seen++;
        if (seen % step === 0 || seen === targets.length) {
          setProgress({ done: seen, total: targets.length });
          setStatus(`建立 CLIP 索引… ${seen}/${targets.length}`);
        }
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

  /** 检查更新：有新版弹自研弹窗；silent=启动静默（无更新/出错不打扰） */
  async function checkUpdateAction(silent: boolean) {
    const now = Date.now();
    if (silent && now - lastUpdateCheckRef.current < 30_000) return;
    if (checkingUpdateRef.current || updateRef.current) return;
    checkingUpdateRef.current = true;
    lastUpdateCheckRef.current = now;
    try {
      const up = await checkUpdate();
      if (!up) {
        if (!silent) setStatus("已是最新版本");
        return;
      }
      if (silent && dismissedUpdateRef.current === up.version) {
        return;
      }
      if (!silent) dismissedUpdateRef.current = "";
      if (silent && promptedUpdateRef.current === up.version) return;
      promptedUpdateRef.current = up.version;
      setUpdate(up);
    } catch (e) {
      if (!silent) setStatus(`检查更新失败：${e}`);
    } finally {
      checkingUpdateRef.current = false;
    }
  }

  // 取应用版本号（顶部徽标 + 关于）
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // 启动后多次静默补查 + 后台轮询：发布包常晚于应用启动几分钟生成。
  useEffect(() => {
    const timers = [3_000, 60_000, 5 * 60_000].map((ms) =>
      window.setTimeout(() => checkUpdateAction(true), ms)
    );
    const interval = window.setInterval(() => checkUpdateAction(true), 30 * 60_000);
    const onFocus = () => checkUpdateAction(true);
    const onVisible = () => {
      if (document.visibilityState === "visible") checkUpdateAction(true);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      timers.forEach((t) => clearTimeout(t));
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function exportMcpMenu() {
    try {
      const dir = await api.exportMcpScript();
      await openPath(dir);
      setStatus("MCP 脚本已导出并打开文件夹（注册命令见同目录 README）");
    } catch (e) {
      setStatus(`导出 MCP 脚本失败：${e}`);
    }
  }

  // ===== 派生数据 =====
  // 文件夹按父目录完整路径区分（同名目录不串）
  const dirOf = (p: string) => p.replace(/[\\/][^\\/]+$/, "");
  const lastSeg = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p;
  // 某素材路径是否在 dir 目录（或其任意子目录）下——删除/筛选按前缀级联用
  const isUnder = (p: string, dir: string) => p.startsWith(dir + "/") || p.startsWith(dir + "\\");
  // 文件夹树：按目录层级建树，压缩「无直接素材且独子」的链（把 C:\…\ 长前缀折叠到第一个有意义的文件夹），
  // 大文件夹即便本身没直接图片也会作为父节点出现，可级联删除/筛选其下所有子目录。
  const folders = useMemo<FolderNode[]>(() => {
    const self = new Map<string, number>();
    for (const a of assets) {
      const d = dirOf(a.path);
      if (d) self.set(d, (self.get(d) ?? 0) + 1);
    }
    if (self.size === 0) return [];
    type Raw = { path: string; self: number; children: Set<string> };
    const raw = new Map<string, Raw>();
    const ensure = (p: string): Raw => {
      let n = raw.get(p);
      if (!n) {
        n = { path: p, self: 0, children: new Set() };
        raw.set(p, n);
      }
      return n;
    };
    // 为每个「直接含素材的目录」补齐其祖先链（dirOf 逐级上溯，保留原始分隔符）
    for (const [d, c] of self) {
      ensure(d).self += c;
      let cur = d;
      for (;;) {
        const par = dirOf(cur);
        if (!par || par === cur) break;
        ensure(par).children.add(cur);
        cur = par;
      }
    }
    const childOfSomeone = new Set<string>();
    for (const n of raw.values()) for (const c of n.children) childOfSomeone.add(c);
    const build = (p: string): FolderNode => {
      let node = raw.get(p)!;
      let path = p;
      while (node.self === 0 && node.children.size === 1) {
        path = [...node.children][0];
        node = raw.get(path)!;
      }
      const children = [...node.children].map(build).sort((a, b) => b.total - a.total);
      const total = node.self + children.reduce((s, c) => s + c.total, 0);
      return { path, label: lastSeg(path), selfCount: node.self, total, children };
    };
    return [...raw.keys()]
      .filter((p) => !childOfSomeone.has(p)) // 根 = 没被任何人当作子目录的节点
      .map(build)
      .sort((a, b) => b.total - a.total);
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
        return isUnder(a.path, filter.value); // 含该目录及其所有子目录
      case "color":
        return primaryBucket(a.colors) === filter.value;
      case "collection":
        return collectionMembers.has(a.id);
      case "missing":
        return a.missing;
      case "favorite":
        return a.favorite;
      case "trash":
        return false; // 回收站走单独列表(trashed)，不在在库 assets 里匹配
      case "type":
        return filter.value === "image"
          ? isImage(a)
          : filter.value === "video"
            ? isVideo(a)
            : isAudio(a);
    }
  };
  const matchesQuery = (a: Asset) =>
    query.trim() === "" ||
    a.name.toLowerCase().includes(query.toLowerCase()) ||
    a.tags.some((t) => t.includes(query));

  const inTrash = filter.kind === "trash";
  const filtered = (inTrash ? trashed : assets).filter(
    (a) => (inTrash || matchesFilter(a)) && matchesQuery(a),
  );
  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === "name") return a.name.localeCompare(b.name);
    if (sortKey === "size") return b.sizeBytes - a.sizeBytes;
    return b.addedAt - a.addedAt || b.id - a.id;
  });
  const missingCount = assets.filter((a) => a.missing).length;
  const displayList: Asset[] = !inTrash && semanticIds
    ? (semanticIds.map((id) => assets.find((a) => a.id === id)).filter(Boolean) as Asset[])
    : sorted;
  const selected = assets.find((a) => a.id === selectedId) ?? null;

  // 悬浮参考浮窗：把一张图"拉到桌面"——独立的无边框/透明/置顶小窗，浮在绘图软件上方
  function openRefWindowFromPath(ref: {
    path: string;
    name: string;
    width?: number;
    height?: number;
    labelHint?: string | number;
  }) {
    const ratio = ref.width && ref.height ? ref.height / ref.width : 0.72;
    const w = 360;
    const h = Math.round(Math.min(1200, Math.max(140, w * ratio))); // 按图比例，顶栏是叠加层不占高
    const params = new URLSearchParams({ p: ref.path, n: ref.name });
    const label = `ref-${ref.labelHint ?? "board"}-${refSeq.current++}`;
    const win = new WebviewWindow(label, {
      url: `index.html#ref?${params.toString()}`,
      width: w,
      height: h,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false, // 边框拖动缩放关掉——只用右下角小三角(按比例 setSize)，不闪不错位
      shadow: false,
      title: ref.name,
    });
    win.once("tauri://error", (e) => setStatus(`悬浮窗打开失败：${JSON.stringify(e.payload)}`));
  }

  function openRefWindow(a: Asset) {
    openRefWindowFromPath({
      path: a.path,
      name: a.name,
      width: a.width,
      height: a.height,
      labelHint: a.id,
    });
  }

  // 多图轮播参考窗：list 存 localStorage（URL 放不下多条路径），窗口按 key 读，◀▶/滚轮切换
  function openRefWindowFromList(list: { path: string; name: string }[], labelHint?: string | number) {
    if (!list.length) return;
    if (list.length === 1) return openRefWindowFromPath({ ...list[0], labelHint });
    const key = `nobi.ref.${Date.now()}.${refSeq.current}`;
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch {
      /* ignore */
    }
    const first = list[0];
    const w = 360;
    const h = Math.round(w * 0.72);
    const params = new URLSearchParams({ key, i: "0", n: first.name });
    const label = `ref-${labelHint ?? "multi"}-${refSeq.current++}`;
    const win = new WebviewWindow(label, {
      url: `index.html#ref?${params.toString()}`,
      width: w,
      height: h,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false, // 边框拖动缩放关掉——只用右下角小三角(按比例 setSize)，不闪不错位
      shadow: false,
      title: first.name,
    });
    win.once("tauri://error", (e) => setStatus(`悬浮窗打开失败：${JSON.stringify(e.payload)}`));
  }

  /** 打开聊天启动器（发起/加入群面板；已开则聚焦） */
  async function openChatWindow() {
    const existing = await WebviewWindow.getByLabel(CHAT_WINDOW_LABEL).catch(() => null);
    if (existing) {
      await existing.setFocus().catch(() => {});
      return;
    }
    const win = new WebviewWindow(CHAT_WINDOW_LABEL, {
      url: "index.html#chat",
      title: "Nobi 聊天",
      width: 340,
      height: 420,
      resizable: true,
      visible: false, // 隐藏建窗，窗口 mount 调 stealth_show 打 toolwindow 再显示（不进 Alt+Tab/任务栏）
    });
    win.once("tauri://error", (e) => setStatus(`聊天窗口打开失败：${JSON.stringify(e.payload)}`));
  }

  /** 打开（或聚焦）某连接（档案+房间）的独立聊天窗 */
  async function openChatRoom(profileId: string, room: string) {
    const label = `chat-${`${profileId}-${room}`.replace(/[^\w-]/g, "_")}`;
    const existing = await WebviewWindow.getByLabel(label).catch(() => null);
    if (existing) {
      await existing.setFocus().catch(() => {});
      return;
    }
    const win = new WebviewWindow(label, {
      url: `index.html#chat?profile=${encodeURIComponent(profileId)}&room=${encodeURIComponent(room)}`,
      title: `Nobi 聊天 · ${room}`,
      width: 380,
      height: 560,
      minWidth: 300,
      minHeight: 360,
      resizable: true,
      // 关掉 Tauri 原生拖放拦截，让窗口能用 HTML5 拖放收桌面拖进来的图片
      dragDropEnabled: false,
      visible: false, // 隐藏建窗，stealth_show 后再显示（不进 Alt+Tab/任务栏）
    });
    win.once("tauri://error", (e) => setStatus(`聊天窗口打开失败：${JSON.stringify(e.payload)}`));
  }

  /** 把素材发到"当前活跃的连接"（最后点过的那个群窗口）；没进群则先开启动器 */
  function sendAssetToFriend(a: Asset) {
    const active = getActiveConn();
    if (!active) {
      void openChatWindow();
      setStatus("先进入一个群，再右键发素材（或直接把图拖进群窗口）");
      return;
    }
    const kind = isVideo(a) ? "video" : "image";
    pushOutbox({ path: a.path, name: a.name, profileId: active.profileId, room: active.room, kind });
    void openChatRoom(active.profileId, active.room);
    setStatus(`已发往群 ${active.room}：${a.name}`);
  }

  // 看图/练习浮层：多选时拿选中的当播放列表（练 gesture），否则用当前过滤列表。
  // 音频/视频没有静态画面，不进看图浮层。
  function openViewer(id: number) {
    const a = assets.find((x) => x.id === id);
    if (!a) return;
    if (!isImage(a)) return;
    const base =
      sel.size > 1 && sel.has(id) ? displayList.filter((x) => sel.has(x.id)) : displayList;
    const playlist = base.filter(isImage);
    const start = Math.max(0, playlist.findIndex((x) => x.id === id));
    if (playlist.length) setViewer({ list: playlist, index: start });
  }

  const isActive = (f: Filter) =>
    f.kind === filter.kind &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (f.kind === "all" || (f as any).value === (filter as any).value);

  // 再点一下已激活的筛选 = 取消、回到「全部素材」
  const toggleFilter = (f: Filter) => setFilter(isActive(f) ? { kind: "all" } : f);

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
      ? `文件夹：${lastSeg(filter.value)}`
      : filter.kind === "collection"
      ? `合集：${collections.find((c) => String(c.id) === filter.value)?.name ?? filter.value}`
      : filter.kind === "type"
      ? { image: "图片", video: "视频", audio: "音频" }[filter.value]
      : filter.kind === "trash"
      ? "🗑 回收站"
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
        { sep: true },
        { label: "⌨ 首选项 · 快捷键…", action: () => setShowPrefs(true) },
        {
          label: "⚙ 设置",
          sub: [
            { label: "开机自启", checked: autostartOn, action: () => void toggleAutostart() },
            { label: "划词右键翻译", checked: selTranslateOn, action: () => void toggleSelectionTranslate() },
            { label: "📁 素材保存路径…", action: () => setShowSavePath(true) },
          ],
        },
      ],
    },
    {
      title: "工具(T)",
      items: [
        { label: "画板", action: () => ensurePanel("board", "画板") },
        // 金库锁定时这两项不渲染：菜单干净得像个纯素材管理器，老板看不出有上网/聊天功能
        ...(vaultUnlocked
          ? [
              { label: "🌐 浏览窗…", action: () => setShowWebTV(true) },
              { label: "📝 便签…", action: () => void openChatWindow() },
            ]
          : []),
        { label: "翻译实验室…", action: () => setShowTranslation(true) },
        { label: "Dobby 工具站", action: () => openUrl(DOBBY_URL) },
        { sep: true },
        { label: "导出浏览器采集插件…", action: exportExtMenu },
        { label: "导出 MCP 接入脚本…", action: exportMcpMenu },
      ],
    },
    {
      title: "窗口(W)",
      items: [
        { label: "素材库", action: () => ensurePanel("library", "素材库") },
        { label: "素材", action: () => ensurePanel("grid", "素材") },
        { label: "画板", action: () => ensurePanel("board", "画板") },
        { label: "文档", action: () => ensurePanel("doc", "文档") },
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
        { label: "检查更新…", action: () => checkUpdateAction(false) },
        { label: "关于 Nobi", action: () => setStatus(`Nobi v${appVersion} · 素材精灵`) },
      ],
    },
  ];

  // ===== 面板上下文 =====
  const dockState: DockState = {
    assets,
    filter,
    setFilter,
    toggleFilter,
    isActive,
    missingCount,
    trashedCount: trashed.length,
    autoSync,
    toggleAutoSync: toggleAutoSyncAction,
    restoreSelected: restoreSelectedAction,
    purgeSelected: purgeSelectedAction,
    emptyTrash: emptyTrashAction,
    findDups,
    requestThumb,
    folders,
    removeFolder: removeFolderAction,
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
    openViewer,
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
    findSimilarFromBoard,
    openBoardReference,
    reverseSearchByFile,
    collections,
    openCollection,
    createCollectionFromSel,
    addSelToCollection,
    deleteCollection: deleteCollectionAction,
    saveBoardAsCollection,
    saveBoardImageToLibrary,
    exportContactSheet,
    thumbSize,
    setThumbSize,
    query,
    setQuery,
    searchMode,
    toggleSearchMode: () => {
      const next = searchMode === "semantic" ? "name" : "semantic";
      setSearchMode(next);
      if (next === "name") setSemanticIds(null);
      else if (query.trim()) doSemantic(query);
    },
    doSemantic,
  };

  return (
    <DockCtx.Provider value={dockState}>
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Nobi
          {appVersion && (
            // 隐秘暗号触发点：看着只是普通版本号，连点 5 下解锁/锁定金库。
            // 故意不改 cursor/hover，不给任何「可点」暗示。
            <span
              className="brand-ver"
              onClick={onBrandTap}
              style={{ cursor: "default", userSelect: "none" }}
            >
              v{appVersion}
            </span>
          )}
        </div>
        <MenuBar menus={menus} />
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

      {showWebTV && (
        <WebTVModal onClose={() => setShowWebTV(false)} engine={webEngine} onEngine={pickWebEngine} />
      )}

      {showTranslation && <TranslationModal onClose={() => setShowTranslation(false)} />}

      {showPrefs && <PreferencesModal onClose={() => setShowPrefs(false)} />}

      {showSavePath && <SavePathModal onClose={() => setShowSavePath(false)} />}

      {update && (
        <UpdateModal
          update={update}
          onClose={() => {
            dismissedUpdateRef.current = update.version;
            setUpdate(null);
          }}
        />
      )}

      {viewer && (
        <ImageViewer
          assets={viewer.list}
          index={viewer.index}
          onClose={() => setViewer(null)}
        />
      )}

      {dragOver && (
        <div className="drop-overlay">
          <div className="drop-hint">📥 松开导入素材（支持文件 / 文件夹）</div>
        </div>
      )}

      {/* 取色模式提示横幅（Ctrl+Alt+C 进入，光标已变十字） */}
      {picking && (
        <div className="color-pick-banner">🎨 取色模式：点击任意位置取色 · 右键取消</div>
      )}

      {/* 桌面取色器最近色板（Ctrl+Alt+C 取色）：左键复制 hex，右键复制 rgb */}
      {recentColors.length > 0 && (
        <div className="color-palette">
          <span className="color-palette-hd" title="桌面取色器：把光标悬到任意位置按 Alt+G">取色</span>
          {recentColors.map((c) => (
            <button
              key={c.hex}
              className="color-swatch"
              style={{ background: c.hex }}
              title={`${c.hex} · rgb(${c.r}, ${c.g}, ${c.b})　左键复制 hex / 右键复制 rgb`}
              onClick={() => {
                navigator.clipboard.writeText(c.hex).catch(() => {});
                setStatus(`已复制 ${c.hex}`);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                const rgb = `rgb(${c.r}, ${c.g}, ${c.b})`;
                navigator.clipboard.writeText(rgb).catch(() => {});
                setStatus(`已复制 ${rgb}`);
              }}
            />
          ))}
          <button className="color-palette-x" title="清空色板" onClick={() => setRecentColors([])}>
            ✕
          </button>
        </div>
      )}

      {/* 素材右键菜单：Portal 到 body（方案1），脱离一切容器/层叠上下文裁切 */}
      {ctx &&
        createPortal(
        <>
          <div
            className="ctx-overlay"
            onClick={() => setCtx(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx(null);
            }}
          />
          <div ref={ctxRef} className="ctx-menu" style={{ left: ctx.x, top: ctx.y }}>
            {isImage(ctx.asset) && (
              <div
                className="ctx-item"
                onClick={() => {
                  openViewer(ctx.asset.id);
                  setCtx(null);
                }}
              >
                看图 / 练习（取色·灰度·镜像·计时）
              </div>
            )}
            {isModel(ctx.asset) && (
              <div
                className="ctx-item"
                onClick={() => {
                  openViewer(ctx.asset.id);
                  setCtx(null);
                }}
              >
                3D 查看（转圈 · 存封面）
              </div>
            )}
            {isImage(ctx.asset) && (
              <div
                className="ctx-item"
                onClick={() => {
                  openRefWindow(ctx.asset);
                  setCtx(null);
                }}
              >
                悬浮到桌面（置顶参考）
              </div>
            )}
            {isImage(ctx.asset) &&
              (() => {
                const imgs = assets.filter((a) => sel.has(a.id) && isImage(a));
                return imgs.length > 1 && sel.has(ctx.asset.id) ? (
                  <div
                    className="ctx-item"
                    onClick={() => {
                      openRefWindowFromList(
                        imgs.map((a) => ({ path: a.path, name: a.name })),
                        ctx.asset.id,
                      );
                      setCtx(null);
                    }}
                  >
                    悬浮到桌面（轮播 {imgs.length} 张）
                  </div>
                ) : null;
              })()}
            {(isImage(ctx.asset) || isVideo(ctx.asset)) && (
              <div
                className="ctx-item"
                onClick={() => {
                  sendAssetToFriend(ctx.asset);
                  setCtx(null);
                }}
              >
                发到便签
              </div>
            )}
            {(isImage(ctx.asset) || isModel(ctx.asset)) && <div className="ctx-sep" />}
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
            {sel.size > 1 && sel.has(ctx.asset.id) && (
              <div
                className="ctx-item danger"
                onClick={() => {
                  removeSelectedAction();
                  setCtx(null);
                }}
              >
                从库移除选中的 {sel.size} 张（不删原图）
              </div>
            )}
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
        </>,
        document.body
      )}
    </div>
    </DockCtx.Provider>
  );
}

export default App;
