// 自研无限画布（替代 tldraw）：选择/手/画笔/橡皮/矩形/椭圆/箭头/文本，
// 框选、八向缩放+旋转、撤销重做、右键菜单、拖拽落图、双层持久化（localStorage 快取 + SQLite 权威）。
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import {
  Arrow as KArrow,
  Ellipse as KEllipse,
  Group,
  Image as KImage,
  Layer,
  Line as KLine,
  Rect as KRect,
  Shape as KShape,
  Stage,
  Text as KText,
  Transformer,
} from "react-konva";
import Konva from "konva";
import getStroke from "perfect-freehand";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog, message as msgDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  type BoardMeta,
  createBoard,
  deleteBoard,
  importBlob,
  listBoards,
  loadBoard,
  renameBoard,
  saveBoard,
  saveFile,
} from "../api";
import type { Editor as TiptapEditor } from "@tiptap/react";
import CropEditor, { type CropRect, fullExtent } from "./CropEditor";
import TextEditorOverlay from "./TextEditorOverlay";
import { docToRuns, layoutRuns, runsToText, shapeToDoc } from "./richtext";
import { hitTestShape, reflowArrows, resolveArrow } from "./binding";
import { HOTKEYS, comboOf, loadBindings, resetBindings, saveBinding } from "./shortcuts";
import { collectSnapTargets, snapMove, type SnapTargets } from "./snap";
import { useImageEl } from "./useImage";
import {
  type ArrowShape,
  type BoardShape,
  type BrushKey,
  type DrawShape,
  Editor,
  type FillKey,
  type GeoShape,
  type ImageShape,
  type Box,
  type SizeKey,
  type TextShape,
  FONT_FAMILY,
  FONT_PX,
  STROKE_W,
  boxesIntersect,
  colorHex,
  newId,
  parseDoc,
  serializeDoc,
  setImageSrcResolver,
  shapeBounds,
  unionBounds,
} from "./store";
import "./board.css";

setImageSrcResolver(convertFileSrc);

// 画板 1 沿用旧版无后缀键，老用户的本地快取无缝继承
const docKey = (id: number) => (id === 1 ? "nobi-board-doc-v1" : `nobi-board-doc-v1:${id}`);
const camKey = (id: number) => (id === 1 ? "nobi-board-cam-v1" : `nobi-board-cam-v1:${id}`);
const CUR_BOARD_KEY = "nobi-board-current";
const BACKUP_KEY = "nobi-board-tldraw-backup";
const SNAP_KEY = "nobi-board-snap-v1";
const STYLE_KEY = "nobi-board-style-v1";
const BLUE = "#2f80ed";
const MIN_Z = 0.05;
const MAX_Z = 8;
const IMG_URL_RE = /asset\.localhost|\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i;

type Tool = "select" | "hand" | "draw" | "eraser" | "rect" | "ellipse" | "arrow" | "text";
interface Camera {
  x: number;
  y: number;
  z: number;
}
interface P {
  x: number;
  y: number;
}
interface Style {
  color: string;
  size: SizeKey;
  fill: FillKey;
  brush: BrushKey;
  bold: boolean;
  italic: boolean;
  underline: boolean;
}

type Session =
  | { mode: "pan"; start: P; last: P; moved: boolean; byRight: boolean }
  | { mode: "marquee"; start: P; cur: P; base: string[] }
  | {
      mode: "move";
      start: P;
      moved: boolean;
      cp: { shapes: BoardShape[]; selection: string[] };
      orig: Map<string, { x: number; y: number }>;
      alt: boolean;
      cloned: boolean;
      targets?: SnapTargets; // 吸附候选（首次移动时缓存）
      baseBox?: Box | null; // 选区在起点处的包围盒
      guides?: { v: number[]; h: number[] }; // 命中的吸附参考线（页面坐标）
    }
  | { mode: "draw"; points: number[]; press: number[]; isPen: boolean }
  | {
      mode: "erase";
      cp: { shapes: BoardShape[]; selection: string[] };
      pending: Set<string>; // 擦中待删的形状（先半透明预览，松手才真删）
      last: P;
    }
  | { mode: "text" }
  | { mode: "create"; kind: "rect" | "ellipse" | "arrow"; start: P; cur: P; shift: boolean };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 橡皮擦经过时的预览透明度（标记待删，松手才真删） */
const ERASE_PREVIEW_OPACITY = 0.25;

function hexAlpha(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// 字节 → base64（分块避免栈溢出）
function bufToB64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// ---------- 单个形状渲染 ----------
function drawOutline(shape: DrawShape): number[] {
  // 有真实笔压（数位板）时喂给算法，否则按速度模拟
  const hasPressure = !!shape.pressures && shape.pressures.length * 2 === shape.points.length;
  const pts: number[][] = [];
  for (let i = 0; i < shape.points.length; i += 2) {
    pts.push(
      hasPressure
        ? [shape.points[i], shape.points[i + 1], shape.pressures![i / 2]]
        : [shape.points[i], shape.points[i + 1]]
    );
  }
  if (shape.brush === "marker") {
    // 马克笔：宽扁、恒定笔宽、平头
    return getStroke(pts, {
      size: STROKE_W[shape.size] * 4.4,
      thinning: 0,
      smoothing: 0.6,
      streamline: 0.4,
      simulatePressure: false,
      start: { cap: false, taper: 0 },
      end: { cap: false, taper: 0 },
    }).flat();
  }
  // 钢笔：带笔锋的实心笔迹
  return getStroke(pts, {
    size: STROKE_W[shape.size] * 2,
    thinning: 0.5,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: !hasPressure,
  }).flat();
}

// 铅笔颗粒的确定性随机：同一形状每次重绘纹理一致
function hashSeed(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return h >>> 0;
}
function mulberry32(seed: number) {
  let a = seed || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function PencilNode({ s }: { s: DrawShape }) {
  const hex = colorHex(s.color);
  const w = STROKE_W[s.size];
  const seed = useMemo(() => hashSeed(s.id), [s.id]);
  const sceneFunc = useCallback(
    (context: Konva.Context) => {
      const c = (context as unknown as { _context: CanvasRenderingContext2D })._context;
      const pts = s.points;
      if (pts.length < 2) return;
      c.save();
      // 主笔芯：细线半透明
      c.beginPath();
      c.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) c.lineTo(pts[i], pts[i + 1]);
      c.strokeStyle = hex;
      c.lineWidth = Math.max(1, w * 0.55);
      c.lineCap = "round";
      c.lineJoin = "round";
      c.globalAlpha = 0.5;
      c.stroke();
      // 石墨颗粒：沿路径撒随机小点
      const rnd = mulberry32(seed);
      c.fillStyle = hex;
      let px = pts[0], py = pts[1];
      for (let i = 2; i < pts.length; i += 2) {
        const x = pts[i], y = pts[i + 1];
        const steps = Math.max(1, Math.round(Math.hypot(x - px, y - py) / 1.6));
        for (let st = 0; st < steps; st++) {
          const t = (st + 1) / steps;
          const cx = px + (x - px) * t;
          const cy = py + (y - py) * t;
          for (let k = 0; k < 2; k++) {
            const ang = rnd() * Math.PI * 2;
            const rr = Math.sqrt(rnd()) * w * 0.65;
            const g = 0.5 + rnd() * 0.9;
            c.globalAlpha = 0.06 + rnd() * 0.28;
            c.fillRect(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, g, g);
          }
        }
        px = x;
        py = y;
      }
      c.restore();
    },
    [s.points, hex, w, seed]
  );
  const hitFunc = useCallback(
    (context: Konva.Context, shape: Konva.Shape) => {
      const pts = s.points;
      if (pts.length < 2) return;
      context.beginPath();
      context.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) context.lineTo(pts[i], pts[i + 1]);
      context.strokeShape(shape);
    },
    [s.points]
  );
  return <KShape sceneFunc={sceneFunc} hitFunc={hitFunc} stroke={hex} strokeWidth={w + 10} />;
}

function ImageNode({ s, full }: { s: ImageShape; full: boolean }) {
  // 双层：缩略图常驻，放大需要细节时再加载原图，原图没好时缩略图顶着（不闪灰块）
  const thumbEl = useImageEl(s.thumbSrc || s.src);
  const fullEl = useImageEl(full && s.thumbSrc ? s.src : "");
  const el = fullEl ?? thumbEl;
  if (!el) return <KRect width={s.w} height={s.h} fill="#26262b" cornerRadius={2} />;
  const crop = s.crop
    ? {
        x: s.crop.x * el.naturalWidth,
        y: s.crop.y * el.naturalHeight,
        width: s.crop.w * el.naturalWidth,
        height: s.crop.h * el.naturalHeight,
      }
    : undefined;
  return <KImage image={el} width={s.w} height={s.h} crop={crop} />;
}

function GeoNode({ s }: { s: GeoShape }) {
  const stroke = colorHex(s.color);
  const fill =
    s.fill === "none" ? undefined : hexAlpha(stroke, s.fill === "semi" ? 0.18 : 0.5);
  const common = {
    stroke,
    strokeWidth: STROKE_W[s.size],
    fill,
    fillEnabled: s.fill !== "none",
    hitStrokeWidth: STROKE_W[s.size] + 10,
  };
  return s.geo === "ellipse" ? (
    <KEllipse x={s.w / 2} y={s.h / 2} radiusX={s.w / 2} radiusY={s.h / 2} {...common} />
  ) : (
    <KRect width={s.w} height={s.h} cornerRadius={2} {...common} />
  );
}

function ArrowNode({ s }: { s: ArrowShape }) {
  const hex = colorHex(s.color);
  const sw = STROKE_W[s.size];
  return (
    <KArrow
      points={[0, 0, s.x2, s.y2]}
      stroke={hex}
      fill={hex}
      strokeWidth={sw}
      pointerLength={8 + sw * 2}
      pointerWidth={7 + sw * 1.6}
      lineCap="round"
      hitStrokeWidth={sw + 12}
    />
  );
}

/** 行内富文本渲染：自研排版（混排测量+换行），每个同款分段一个 Konva.Text */
function RichTextNode({ s }: { s: TextShape }) {
  const layout = useMemo(
    () => layoutRuns(s.runs ?? [], s.fontSize, s.w),
    [s.runs, s.fontSize, s.w]
  );
  const lh = s.fontSize * 1.35;
  return (
    <>
      {/* 透明命中区：行间空隙也可点选 */}
      <KRect width={s.w ?? layout.width} height={layout.height} fill="rgba(0,0,0,0)" />
      {layout.lines.map((ln, i) =>
        ln.segs.map((seg, j) => (
          <KText
            key={`${i}-${j}`}
            x={seg.x + (s.align === "center" ? ((s.w ?? layout.width) - ln.width) / 2 : 0)}
            y={i * lh}
            text={seg.text}
            fontSize={s.fontSize}
            lineHeight={1.35}
            fontFamily={FONT_FAMILY}
            fontStyle={
              [seg.run.italic && "italic", seg.run.bold && "bold"].filter(Boolean).join(" ") ||
              "normal"
            }
            textDecoration={seg.run.underline ? "underline" : undefined}
            fill={colorHex(seg.run.color ?? s.color)}
            listening={false}
          />
        ))
      )}
    </>
  );
}

const ShapeView = memo(
  function ShapeView({
    s,
    hidden,
    offscreen = false,
    imgFull = false,
  }: {
    s: BoardShape;
    hidden: boolean;
    offscreen?: boolean;
    imgFull?: boolean;
  }) {
    let inner: React.ReactNode = null;
    switch (s.type) {
      case "image":
        inner = <ImageNode s={s} full={imgFull} />;
        break;
      case "draw": {
        if (s.brush === "pencil") {
          inner = <PencilNode s={s} />;
          break;
        }
        const outline = drawOutline(s);
        inner = (
          <KLine
            points={outline}
            closed
            fill={colorHex(s.color)}
            opacity={s.brush === "marker" ? 0.5 : 1}
          />
        );
        break;
      }
      case "geo":
        inner = <GeoNode s={s} />;
        break;
      case "arrow":
        inner = <ArrowNode s={s} />;
        break;
      case "text":
        inner = s.runs?.length ? (
          <RichTextNode s={s} />
        ) : (
          <KText
            text={s.text}
            fontSize={s.fontSize}
            fontFamily={FONT_FAMILY}
            fontStyle={
              [s.italic && "italic", s.bold && "bold"].filter(Boolean).join(" ") || "normal"
            }
            textDecoration={s.underline ? "underline" : undefined}
            fill={colorHex(s.color)}
            width={s.w}
            align={s.align ?? "left"}
            lineHeight={1.35}
          />
        );
        break;
    }
    return (
      <Group
        id={s.id}
        name="shape"
        x={s.x}
        y={s.y}
        rotation={s.rotation}
        visible={!offscreen}
        opacity={hidden ? 0 : s.opacity}
        listening={!hidden && !s.locked}
      >
        {inner}
      </Group>
    );
  },
  (a, b) =>
    a.s === b.s &&
    a.hidden === b.hidden &&
    a.offscreen === b.offscreen &&
    a.imgFull === b.imgFull
);

// ---------- 工具图标 ----------
function Icon({ d, filled }: { d: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden>
      <path
        d={d}
        fill={filled ? "currentColor" : "none"}
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
const ICONS: Record<string, { d: string; filled?: boolean }> = {
  select: { d: "M6 3.5 18 12l-6.6 1.3L8.5 20Z" },
  hand: {
    d: "M7.5 11.5V5.8a1.4 1.4 0 0 1 2.8 0V10m0-4.8V4.4a1.4 1.4 0 0 1 2.8 0V10m0-4.4a1.4 1.4 0 0 1 2.8 0V12m2.8-2v4.6a6 6 0 0 1-6 6h-.7a5.6 5.6 0 0 1-5.5-4.6l-.8-4.2a1.4 1.4 0 0 1 2.7-.7l.7 2.4M16.1 10a1.4 1.4 0 0 1 2.8 0",
  },
  draw: { d: "M4.5 16.5 14.8 6.2a2.05 2.05 0 0 1 2.9 2.9L7.4 19.4l-4 1Z" },
  eraser: { d: "M5.5 14.5 12 8a2 2 0 0 1 2.8 0l2.7 2.7a2 2 0 0 1 0 2.8L13 18H8.7ZM5 18.5h14M8.7 18 5.5 14.5" },
  arrow: { d: "M6 18 17 7m0 0h-6.5M17 7v6.5" },
  rect: { d: "M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2Z" },
  ellipse: { d: "M12 4.5a7.5 7.5 0 1 1 0 15 7.5 7.5 0 0 1 0-15Z" },
  text: { d: "M5 5.5h14M12 5.5V19" },
  undo: { d: "M8 5 4 9l4 4M4 9h10a5 5 0 0 1 0 10h-3" },
  redo: { d: "M16 5l4 4-4 4M20 9H10a5 5 0 0 0 0 10h3" },
  fit: { d: "M4 9V5a1 1 0 0 1 1-1h4M20 9V5a1 1 0 0 0-1-1h-4M4 15v4a1 1 0 0 0 1 1h4M20 15v4a1 1 0 0 1-1 1h-4" },
  keys: { d: "M3.5 7h17a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM6.5 10h.5M10 10h.5M13.5 10h.5M17 10h.5M6.5 13h.5M17 13h.5M9.5 13h5" },
};

const TOOLS: { id: Tool; title: string; key: string }[] = [
  { id: "select", title: "选择", key: "V" },
  { id: "hand", title: "抓手", key: "H" },
  { id: "draw", title: "画笔", key: "D" },
  { id: "eraser", title: "橡皮", key: "E" },
  { id: "arrow", title: "箭头", key: "A" },
  { id: "rect", title: "矩形", key: "R" },
  { id: "ellipse", title: "椭圆", key: "O" },
  { id: "text", title: "文本", key: "T" },
];

// 预设块状色盘（中性 / 红橙 / 绿青 / 蓝紫 / 粉棕，含 tldraw 暗色盘主要色值）
const PRESET_COLORS = [
  "#ffffff", "#d0d0d8", "#9398b0", "#5d6070", "#33343d", "#17181c",
  "#e03131", "#ff6b6b", "#ff922b", "#e8590c", "#f1ac4b", "#ffd43b",
  "#94d82d", "#40c057", "#099268", "#0ca678", "#15aabf", "#66d9e8",
  "#4dabf7", "#339af0", "#4f72fc", "#7048e8", "#ae3ec9", "#e599f7",
  "#f783ac", "#e64980", "#d6336c", "#a87155", "#846358", "#5c4742",
];

// 画板内部剪贴板（跨次粘贴）
let boardClipboard: BoardShape[] = [];

// ---------- 主组件 ----------
export default function BoardCanvas({
  onMount,
  onFindSimilar,
  onOpenReference,
  onSaveAsCollection,
  onSaveToLibrary,
}: {
  onMount: (editor: Editor) => void;
  /** 画板图片右键"找库里相似图"：有 assetId 走 clip_similar，无则用图自身像素算向量反查 */
  onFindSimilar?: (arg: { assetId?: number; src: string }) => void;
  /** 画板图片右键"悬浮到桌面"：优先用 sourcePath，旧素材库图可用 assetId 回查。 */
  onOpenReference?: (arg: {
    assetId?: number;
    sourcePath?: string;
    src: string;
    name: string;
    width: number;
    height: number;
  }) => void;
  /** 把画板上来自库的图（assetId）存成一个合集回库 */
  onSaveAsCollection?: (assetIds: number[]) => void;
  /** 把临时拖入（仅在画板上、未入库）的图保存到素材库；回传入库后的 asset 信息。 */
  onSaveToLibrary?: (arg: { name: string; dataB64: string }) => Promise<
    { assetId?: number; sourcePath: string; thumb?: string } | null
  >;
}) {
  const editorRef = useRef<Editor | null>(null);
  if (!editorRef.current) editorRef.current = new Editor();
  const editor = editorRef.current;
  const store = editor.store;

  const docTick = useSyncExternalStore(store.subscribe, () => store.version);

  const containerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const contentRef = useRef<Konva.Layer>(null);
  const trRef = useRef<Konva.Transformer>(null);

  // 多画板：当前画板 id（持久化），列表与弹窗状态
  const [boardId, setBoardId] = useState<number>(
    () => Number(localStorage.getItem(CUR_BOARD_KEY)) || 1
  );
  const boardIdRef = useRef(boardId);
  boardIdRef.current = boardId;
  const [boards, setBoards] = useState<BoardMeta[]>([]);
  const [boardMenu, setBoardMenu] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; value: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState<number | null>(null);

  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cam, setCam] = useState<Camera>(() => {
    try {
      const id = Number(localStorage.getItem(CUR_BOARD_KEY)) || 1;
      const c = JSON.parse(localStorage.getItem(camKey(id)) || "");
      if (typeof c?.z === "number") return { x: c.x, y: c.y, z: clamp(c.z, MIN_Z, MAX_Z) };
    } catch {
      /* ignore */
    }
    return { x: 0, y: 0, z: 1 };
  });
  const camRef = useRef(cam);
  camRef.current = cam;

  const [tool, setTool] = useState<Tool>("select");
  const toolRef = useRef(tool);
  toolRef.current = tool;
  const [spaceDown, setSpaceDown] = useState(false);
  const spaceRef = useRef(false);

  const [style, setStyle] = useState<Style>(() => {
    try {
      const s = JSON.parse(localStorage.getItem(STYLE_KEY) || "");
      // 旧版样式可能缺新字段，用默认值垫底
      if (s?.color) return { brush: "pen", bold: false, italic: false, underline: false, ...s };
    } catch {
      /* ignore */
    }
    return {
      color: "blue", size: "m", fill: "none", brush: "pen",
      bold: false, italic: false, underline: false,
    };
  });
  const styleRef = useRef(style);
  styleRef.current = style;
  useEffect(() => localStorage.setItem(STYLE_KEY, JSON.stringify(style)), [style]);

  const sessionRef = useRef<Session | null>(null);
  const [, bumpSession] = useReducer((x: number) => x + 1, 0);
  // 高频指针事件（画笔/框选/拖框）每帧只触发一次 React 渲染，消除输入延迟
  const rafId = useRef(0);
  const scheduleRender = useCallback(() => {
    if (rafId.current) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = 0;
      bumpSession();
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(rafId.current), []);

  // 文本编辑态：id 为 null 表示新建（未落库，确认有内容才创建形状）
  const [editing, setEditing] = useState<{ id: string | null; x: number; y: number } | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [menu, setMenu] = useState<P | null>(null);
  const bdMenuRef = useRef<HTMLDivElement | null>(null);
  // 右键菜单贴边夹住：菜单 Portal 到 body、fixed 定位，按视口夹（方案1，不再受画板容器裁切）；
  // 同时判断右侧剩余空间，决定二级菜单向右还是向左飞出。
  useLayoutEffect(() => {
    const el = bdMenuRef.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    const pad = 6;
    let dx = 0;
    let dy = 0;
    if (r.bottom > window.innerHeight - pad) dy = window.innerHeight - pad - r.bottom;
    if (r.right > window.innerWidth - pad) dx = window.innerWidth - pad - r.right;
    if (r.top + dy < pad) dy = pad - r.top;
    if (r.left + dx < pad) dx = pad - r.left;
    if (dx) el.style.left = `${menu.x + dx}px`;
    if (dy) el.style.top = `${menu.y + dy}px`;
    el.classList.toggle("flip", r.left + dx + r.width + 170 > window.innerWidth);
  }, [menu]);
  const pendingFit = useRef(false);
  const rightPannedRef = useRef(false); // 右键拖动平移后抑制本次菜单

  // 图片裁剪模式（非破坏）：进入时记录工作裁剪框，提交时烘焙回形状
  const [crop, setCrop] = useState<{ id: string; rect: CropRect } | null>(null);
  const cropRef = useRef(crop);
  cropRef.current = crop;

  // 对齐吸附：默认关，Ctrl+R（可改键）开关，持久化
  const [snapOn, setSnapOn] = useState(() => localStorage.getItem(SNAP_KEY) === "1");
  const snapRef = useRef(snapOn);
  snapRef.current = snapOn;
  useEffect(() => localStorage.setItem(SNAP_KEY, snapOn ? "1" : "0"), [snapOn]);

  // 快捷键绑定（默认 + 用户覆盖）与改键面板
  const [bindings, setBindings] = useState<Record<string, string>>(loadBindings);
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  const [hotkeysOpen, setHotkeysOpen] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [hkMsg, setHkMsg] = useState<string | null>(null);

  // 轻提示
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1600);
  }, []);

  // ---------- 坐标换算 ----------
  const toPage = useCallback((p: P): P => {
    const c = camRef.current;
    return { x: (p.x - c.x) / c.z, y: (p.y - c.y) / c.z };
  }, []);
  const toScreen = useCallback((p: P): P => {
    const c = camRef.current;
    return { x: p.x * c.z + c.x, y: p.y * c.z + c.y };
  }, []);
  const clientToStage = useCallback((e: { clientX: number; clientY: number }): P => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  // ---------- 视口 ----------
  const zoomAt = useCallback((pivot: P, z: number) => {
    z = clamp(z, MIN_Z, MAX_Z);
    setCam((c) => ({
      z,
      x: pivot.x - ((pivot.x - c.x) / c.z) * z,
      y: pivot.y - ((pivot.y - c.y) / c.z) * z,
    }));
  }, []);

  const zoomToFit = useCallback(() => {
    const el = containerRef.current;
    if (!el || el.clientWidth < 2) {
      pendingFit.current = true;
      return;
    }
    const b = unionBounds(store.shapes);
    if (!b) {
      setCam({ x: 0, y: 0, z: 1 });
      return;
    }
    const pad = 64;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const z = clamp(Math.min((vw - pad * 2) / b.w, (vh - pad * 2) / b.h), MIN_Z, 1);
    setCam({
      z,
      x: vw / 2 - (b.x + b.w / 2) * z,
      y: vh / 2 - (b.y + b.h / 2) * z,
    });
  }, [store]);

  // ---------- 初始化：尺寸监听、加载、对外挂载 ----------
  useEffect(() => {
    const el = containerRef.current!;
    setSize({ w: el.clientWidth, h: el.clientHeight }); // 挂载即同步量一次，不等 RO 异步回调
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
      if (pendingFit.current && el.clientWidth > 2) {
        pendingFit.current = false;
        zoomToFit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [zoomToFit]);

  /** 立即把当前画板落盘（localStorage + SQLite） */
  const flushDoc = useCallback(() => {
    localStorage.setItem(docKey(boardIdRef.current), serializeDoc(store));
    saveBoard(boardIdRef.current, serializeDoc(store)).catch(() => {});
  }, [store]);

  /** 加载指定画板：本地快取秒开，SQLite 权威副本兜底（含旧 tldraw 快照迁移） */
  const loadBoardDoc = useCallback(
    async (id: number) => {
      let hasLocal = false;
      const local = localStorage.getItem(docKey(id));
      if (local) {
        const d = parseDoc(local);
        if (d && d.shapes.length) {
          store.replaceDoc(d.shapes);
          hasLocal = true;
        }
      }
      if (!hasLocal) store.replaceDoc([]);
      try {
        const c = JSON.parse(localStorage.getItem(camKey(id)) || "");
        if (typeof c?.z === "number") setCam({ x: c.x, y: c.y, z: clamp(c.z, MIN_Z, MAX_Z) });
      } catch {
        /* 无相机记录则保持现状 */
      }
      try {
        const saved = await loadBoard(id);
        if (saved && !hasLocal && boardIdRef.current === id) {
          const d = parseDoc(saved);
          if (d && d.shapes.length) {
            if (d.migratedFromTldraw) {
              try {
                localStorage.setItem(BACKUP_KEY, saved); // 原 tldraw 快照备份，迁移可回滚
              } catch {
                /* 配额满则放弃备份 */
              }
            }
            store.replaceDoc(d.shapes);
            localStorage.setItem(docKey(id), serializeDoc(store));
            zoomToFit();
          }
        }
      } catch {
        /* 浏览器环境或快照损坏：保持现状 */
      }
    },
    [store, zoomToFit]
  );

  const switchBoard = useCallback(
    (id: number) => {
      setBoardMenu(false);
      setConfirmDel(null);
      if (id === boardIdRef.current) return;
      flushDoc(); // 先把当前板落盘再切
      boardIdRef.current = id;
      setBoardId(id);
      localStorage.setItem(CUR_BOARD_KEY, String(id));
      setCrop(null);
      setEditing(null);
      store.setSelection([]);
      setCam({ x: 0, y: 0, z: 1 });
      loadBoardDoc(id);
    },
    [flushDoc, loadBoardDoc, store]
  );

  useEffect(() => {
    editor.registerViewport({ zoomToFit });
    loadBoardDoc(boardIdRef.current);
    listBoards()
      .then((list) => {
        setBoards(list);
        // 当前 id 不在列表（板被删过）→ 落到第一块
        if (list.length && !list.some((b) => b.id === boardIdRef.current)) {
          boardIdRef.current = list[0].id;
          setBoardId(list[0].id);
          localStorage.setItem(CUR_BOARD_KEY, String(list[0].id));
          loadBoardDoc(list[0].id);
        }
      })
      .catch(() => setBoards([{ id: 1, name: "默认画板", updated_at: 0 }]));
    onMount(editor);
    if (import.meta.env.DEV) {
      // 控制台调试句柄：window.__nobiBoard.store / .stage / .editor / .openTextEditor / .tiptap
      (window as any).__nobiBoard = {
        editor,
        store,
        stage: stageRef.current,
        openTextEditor: (id: string) => {
          const s = store.getShape(id);
          if (s?.type === "text") {
            store.setSelection([id]);
            setEditing({ id, x: s.x, y: s.y });
          }
        },
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 持久化：localStorage 300ms + SQLite 1.5s 防抖 ----------
  useEffect(() => {
    let tLocal: ReturnType<typeof setTimeout> | undefined;
    let tDb: ReturnType<typeof setTimeout> | undefined;
    const write = () => {
      clearTimeout(tLocal);
      clearTimeout(tDb);
      tLocal = setTimeout(
        () => localStorage.setItem(docKey(boardIdRef.current), serializeDoc(store)),
        300
      );
      tDb = setTimeout(
        () => saveBoard(boardIdRef.current, serializeDoc(store)).catch(() => {}),
        1500
      );
    };
    const unsub = store.onDocChange(write);
    return () => {
      unsub();
      clearTimeout(tLocal);
      clearTimeout(tDb);
      flushDoc(); // 卸载时立即落盘
    };
  }, [store, flushDoc]);

  useEffect(() => {
    const t = setTimeout(
      () => localStorage.setItem(camKey(boardIdRef.current), JSON.stringify(cam)),
      300
    );
    return () => clearTimeout(t);
  }, [cam]);

  // ---------- Transformer 绑定 ----------
  const selection = store.selection;
  const selShapes = store.selectedShapes();
  const singleArrow = selShapes.length === 1 && selShapes[0].type === "arrow";
  const singleText = selShapes.length === 1 && selShapes[0].type === "text";
  const singleImage = selShapes.length === 1 && selShapes[0].type === "image";

  useEffect(() => {
    const tr = trRef.current;
    const layer = contentRef.current;
    if (!tr || !layer) return;
    const ids = editing || singleArrow || crop ? [] : selection;
    const nodes = ids
      .map((id) => layer.findOne(`#${id}`))
      .filter((n): n is Konva.Node => !!n);
    tr.nodes(nodes);
    // 全图片选区或单选文本默认等比（文本角缩放 = 缩放字号），Shift 反转
    tr.keepRatio(
      (selShapes.length > 0 && selShapes.every((s) => s.type === "image")) || singleText
    );
    tr.enabledAnchors([
      "top-left", "top-center", "top-right", "middle-left", "middle-right",
      "bottom-left", "bottom-center", "bottom-right",
    ]);
    tr.forceUpdate();
    tr.getLayer()?.batchDraw();
    // 只在选区/编辑态/文档/相机变化时重挂——画笔等高频会话渲染不再白跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, editing, singleArrow, singleText, docTick, cam, crop]);

  // Shift：反转等比缩放 + 旋转吸附 15°
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Shift") return;
      const tr = trRef.current;
      if (!tr || !tr.nodes().length) return;
      const sel = store.selectedShapes();
      const base =
        (sel.length > 0 && sel.every((s) => s.type === "image")) ||
        (sel.length === 1 && sel[0].type === "text");
      tr.keepRatio(e.type === "keydown" ? !base : base);
      tr.rotationSnaps(
        e.type === "keydown" ? Array.from({ length: 24 }, (_, i) => i * 15) : []
      );
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [store]);

  // ---------- 变换提交（缩放/旋转烘焙回 store） ----------
  const transformCp = useRef<{ shapes: BoardShape[]; selection: string[] } | null>(null);
  const onTransformStart = useCallback(() => {
    transformCp.current = store.checkpoint();
  }, [store]);
  const onTransformEnd = useCallback(() => {
    const tr = trRef.current;
    if (!tr) return;
    const patches = new Map<string, Partial<BoardShape>>();
    for (const node of tr.nodes()) {
      const s = store.getShape(node.id());
      if (!s) continue;
      const sx = node.scaleX();
      const sy = node.scaleY();
      const patch: any = { x: node.x(), y: node.y(), rotation: node.rotation() };
      switch (s.type) {
        case "image":
        case "geo":
          patch.w = Math.max(2, s.w * sx);
          patch.h = Math.max(2, s.h * sy);
          break;
        case "draw":
          patch.points = s.points.map((v, i) => (i % 2 === 0 ? v * sx : v * sy));
          break;
        case "arrow":
          patch.x2 = s.x2 * sx;
          patch.y2 = s.y2 * sy;
          break;
        case "text": {
          patch.w = Math.max(20, (s.w ?? (node as Konva.Group).getClientRect({ skipTransform: true }).width) * sx);
          if (Math.abs(sy - 1) > 0.001) patch.fontSize = Math.max(8, s.fontSize * sy);
          break;
        }
      }
      node.scale({ x: 1, y: 1 });
      patches.set(s.id, patch);
    }
    store.applyLive(() => {
      store.shapes = reflowArrows(
        store.shapes.map((s) =>
          patches.has(s.id) ? ({ ...s, ...patches.get(s.id) } as BoardShape) : s
        )
      );
    });
    if (transformCp.current) store.commit(transformCp.current);
    transformCp.current = null;
  }, [store]);

  // ---------- 形状命中 ----------
  const shapeIdAt = useCallback((target: Konva.Node | null): string | null | "ui" => {
    let n: Konva.Node | null = target;
    while (n) {
      if (n instanceof Konva.Transformer) return "ui";
      const name = typeof n.name === "function" ? n.name() : "";
      if (name === "ui") return "ui";
      if (name === "shape") return n.id();
      n = n.getParent();
    }
    return null;
  }, []);

  /** 组合展开：命中组员则返回整组（锁定的成员除外） */
  const expandGroup = useCallback(
    (id: string): string[] => {
      const g = store.getShape(id)?.groupId;
      return g
        ? store.shapes.filter((s) => s.groupId === g && !s.locked).map((s) => s.id)
        : [id];
    },
    [store]
  );

  /** 提交裁剪：把工作裁剪框烘焙回形状（x/y/w/h/crop），一条撤销记录 */
  const commitCrop = useCallback(() => {
    const c = cropRef.current;
    setCrop(null);
    if (!c) return;
    const s = store.getShape(c.id);
    if (!s || s.type !== "image") return;
    const { W, H, ox, oy } = fullExtent(s);
    const rad = (s.rotation * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const lx = ox + c.rect.x * W; // 新窗口左上角（形状局部坐标）
    const ly = oy + c.rect.y * H;
    const isFull =
      c.rect.x < 0.001 && c.rect.y < 0.001 && c.rect.w > 0.999 && c.rect.h > 0.999;
    store.mutate(() => {
      store.shapes = store.shapes.map((sh) =>
        sh.id === c.id && sh.type === "image"
          ? {
              ...sh,
              x: s.x + lx * cos - ly * sin,
              y: s.y + lx * sin + ly * cos,
              w: c.rect.w * W,
              h: c.rect.h * H,
              crop: isFull ? undefined : { ...c.rect },
            }
          : sh
      );
    });
  }, [store]);

  // ---------- 指针交互 ----------
  const eraseAt = useCallback(
    (stagePos: P) => {
      const layer = contentRef.current;
      const sess = sessionRef.current;
      if (!layer || !sess || sess.mode !== "erase") return;
      // 沿上次采样点到当前点逐段采样，快速划动不漏标
      const from = sess.last;
      const dist = Math.hypot(stagePos.x - from.x, stagePos.y - from.y);
      const steps = Math.max(1, Math.ceil(dist / 4));
      let dirty = false;
      for (let i = 1; i <= steps; i++) {
        const p = {
          x: from.x + ((stagePos.x - from.x) * i) / steps,
          y: from.y + ((stagePos.y - from.y) * i) / steps,
        };
        const hit = layer.getIntersection(p);
        const id = hit ? shapeIdAt(hit) : null;
        // 擦到就标记并把节点置半透明（预览），不动模型、不入历史；松手才真删
        if (id && id !== "ui" && !sess.pending.has(id)) {
          sess.pending.add(id);
          layer.findOne("#" + id)?.opacity(ERASE_PREVIEW_OPACITY);
          dirty = true;
        }
      }
      sess.last = stagePos;
      if (dirty) layer.draw(); // 仅重绘，连续擦除不滞后；不触发 React 重渲故预览透明度保持
    },
    [shapeIdAt]
  );

  const onStagePointerDown = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>) => {
      containerRef.current?.focus({ preventScroll: true });
      setMenu(null);
      setBoardMenu(false);
      const evt = e.evt;
      const pos = clientToStage(evt);
      const page = toPage(pos);
      const t = toolRef.current;

      // 裁剪模式：编辑器内交互交给 Konva；点外部 = 提交并吞掉这次点击
      if (cropRef.current) {
        const hit = shapeIdAt(e.target === e.target.getStage() ? null : e.target);
        if (hit !== "ui") commitCrop();
        return;
      }

      if (evt.button === 1 || evt.button === 2 || t === "hand" || spaceRef.current) {
        evt.preventDefault(); // 中键/右键拖动平移，屏蔽浏览器自动滚动
        const at = { x: evt.clientX, y: evt.clientY };
        sessionRef.current = {
          mode: "pan",
          start: at,
          last: at,
          moved: false,
          byRight: evt.button === 2,
        };
        bumpSession();
        return;
      }
      if (evt.button !== 0) return;

      const hitId = shapeIdAt(e.target === e.target.getStage() ? null : e.target);
      if (hitId === "ui") return; // Transformer 锚点 / 箭头端点把手，交给 Konva

      if (t === "select") {
        if (!hitId) {
          sessionRef.current = {
            mode: "marquee",
            start: pos,
            cur: pos,
            base: evt.shiftKey ? [...store.selection] : [],
          };
          if (!evt.shiftKey) store.setSelection([]);
          bumpSession();
          return;
        }
        const groupIds = expandGroup(hitId); // 点中组员 = 选中整组
        if (evt.shiftKey) {
          store.setSelection(
            store.isSelected(hitId)
              ? store.selection.filter((i) => !groupIds.includes(i))
              : [...new Set([...store.selection, ...groupIds])]
          );
        } else if (!store.isSelected(hitId)) {
          store.setSelection(groupIds);
        }
        const orig = new Map<string, { x: number; y: number }>();
        for (const s of store.selectedShapes()) orig.set(s.id, { x: s.x, y: s.y });
        sessionRef.current = {
          mode: "move",
          start: page,
          moved: false,
          cp: store.checkpoint(),
          orig,
          alt: evt.altKey,
          cloned: false,
        };
        bumpSession();
        return;
      }
      if (t === "draw") {
        sessionRef.current = {
          mode: "draw",
          points: [page.x, page.y],
          press: [evt.pressure || 0.5],
          isPen: evt.pointerType === "pen",
        };
        bumpSession();
        return;
      }
      if (t === "eraser") {
        sessionRef.current = { mode: "erase", cp: store.checkpoint(), pending: new Set(), last: pos };
        eraseAt(pos);
        bumpSession();
        return;
      }
      if (t === "rect" || t === "ellipse" || t === "arrow") {
        sessionRef.current = {
          mode: "create",
          kind: t,
          start: page,
          cur: page,
          shift: evt.shiftKey,
        };
        bumpSession();
        return;
      }
      if (t === "text") {
        // 抬手时再开编辑框：避免 mouseup 抢走 textarea 焦点导致秒关
        evt.preventDefault();
        sessionRef.current = { mode: "text" };
      }
    },
    [clientToStage, toPage, shapeIdAt, store, eraseAt, expandGroup, commitCrop]
  );

  // 全局指针移动/抬起（拖出画布也能继续）
  useEffect(() => {
    const onMove = (evt: PointerEvent) => {
      const sess = sessionRef.current;
      if (!sess || !containerRef.current) return;
      const pos = clientToStage(evt);
      const page = toPage(pos);
      switch (sess.mode) {
        case "pan": {
          const dx = evt.clientX - sess.last.x;
          const dy = evt.clientY - sess.last.y;
          sess.last = { x: evt.clientX, y: evt.clientY };
          if (!sess.moved && Math.hypot(evt.clientX - sess.start.x, evt.clientY - sess.start.y) > 4) {
            sess.moved = true;
          }
          setCam((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
          break;
        }
        case "marquee": {
          sess.cur = pos;
          const a = toPage(sess.start);
          const box = {
            x: Math.min(a.x, page.x),
            y: Math.min(a.y, page.y),
            w: Math.abs(a.x - page.x),
            h: Math.abs(a.y - page.y),
          };
          const hits = store.shapes
            .filter((s) => !s.locked && boxesIntersect(box, shapeBounds(s)))
            .map((s) => s.id);
          const expanded = new Set<string>(sess.base);
          for (const id of hits) for (const gid of expandGroup(id)) expanded.add(gid);
          const next = [...expanded];
          const cur = store.selection;
          if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) {
            store.setSelection(next);
          }
          scheduleRender();
          break;
        }
        case "move": {
          const dx = page.x - sess.start.x;
          const dy = page.y - sess.start.y;
          if (!sess.moved && Math.hypot(dx, dy) * camRef.current.z < 3) return;
          if (!sess.moved && sess.alt && !sess.cloned) {
            // Alt 拖拽 = 拖出副本（tldraw 行为）
            sess.cloned = true;
            const src = store.selectedShapes();
            const copies = src.map((s) => ({ ...JSON.parse(JSON.stringify(s)), id: newId() }));
            store.applyLive(() => {
              store.shapes = [...store.shapes, ...copies];
              store.selection = copies.map((c) => c.id);
            });
            sess.orig = new Map(copies.map((c) => [c.id, { x: c.x, y: c.y }]));
          }
          if (!sess.moved && snapRef.current) {
            // 首次移动：缓存吸附候选与选区起始包围盒（此刻形状仍在原位）
            sess.targets = collectSnapTargets(store.shapes, new Set(sess.orig.keys()));
            sess.baseBox = unionBounds(store.shapes.filter((s) => sess.orig.has(s.id)));
          }
          sess.moved = true;
          let mdx = dx;
          let mdy = dy;
          sess.guides = { v: [], h: [] };
          if (snapRef.current && sess.baseBox && sess.targets) {
            const snapped = snapMove(
              {
                x: sess.baseBox.x + dx,
                y: sess.baseBox.y + dy,
                w: sess.baseBox.w,
                h: sess.baseBox.h,
              },
              sess.targets,
              6 / camRef.current.z
            );
            mdx += snapped.dx;
            mdy += snapped.dy;
            sess.guides = { v: snapped.vLines, h: snapped.hLines };
          }
          store.applyLive(() => {
            store.shapes = reflowArrows(
              store.shapes.map((s) => {
                const o = sess.orig.get(s.id);
                return o ? { ...s, x: o.x + mdx, y: o.y + mdy } : s;
              })
            );
          });
          break;
        }
        case "draw": {
          const n = sess.points.length;
          if (Math.hypot(page.x - sess.points[n - 2], page.y - sess.points[n - 1]) * camRef.current.z > 1.5) {
            sess.points.push(page.x, page.y);
            sess.press.push(evt.pressure || 0.5);
            scheduleRender();
          }
          break;
        }
        case "erase":
          eraseAt(pos);
          break;
        case "create":
          sess.cur = page;
          sess.shift = evt.shiftKey;
          scheduleRender();
          break;
      }
    };
    const onUp = (evt: PointerEvent) => {
      const sess = sessionRef.current;
      if (!sess) return;
      sessionRef.current = null;
      switch (sess.mode) {
        case "pan":
          if (sess.byRight) rightPannedRef.current = sess.moved;
          break;
        case "move":
          if (sess.moved) store.commit(sess.cp);
          break;
        case "text": {
          const page = toPage(clientToStage(evt));
          const st = styleRef.current;
          setEditing({ id: null, x: page.x, y: page.y - FONT_PX[st.size] * 0.7 });
          setTool("select");
          break;
        }
        case "draw": {
          if (sess.points.length >= 2) {
            let minX = Infinity, minY = Infinity;
            for (let i = 0; i < sess.points.length; i += 2) {
              minX = Math.min(minX, sess.points[i]);
              minY = Math.min(minY, sess.points[i + 1]);
            }
            const st = styleRef.current;
            store.createShapes(
              [
                {
                  id: newId(),
                  type: "draw",
                  x: minX,
                  y: minY,
                  rotation: 0,
                  opacity: 1,
                  points: sess.points.map((v, i) => (i % 2 === 0 ? v - minX : v - minY)),
                  color: st.color,
                  size: st.size,
                  brush: st.brush,
                  pressures: sess.isPen ? [...sess.press] : undefined,
                },
              ],
              false // 画笔连续作画，不选中
            );
          }
          break;
        }
        case "erase":
          // 松手才真删（拖动中只是半透明预览）；deleteShapes 自带一条撤销记录并清理箭头绑定
          if (sess.pending.size) store.deleteShapes([...sess.pending]);
          break;
        case "create": {
          const st = styleRef.current;
          const { start, cur, kind } = sess;
          if (kind === "arrow") {
            let x2 = cur.x - start.x;
            let y2 = cur.y - start.y;
            if (sess.shift) {
              // 吸附 15°
              const len = Math.hypot(x2, y2);
              const ang = Math.round(Math.atan2(y2, x2) / (Math.PI / 12)) * (Math.PI / 12);
              x2 = Math.cos(ang) * len;
              y2 = Math.sin(ang) * len;
            }
            if (Math.hypot(x2, y2) > 4) {
              // 两端若落在形状上则自动绑定（拖动该形状箭头跟随）
              const startHit = hitTestShape(store.shapes, start);
              const endHit = hitTestShape(store.shapes, { x: start.x + x2, y: start.y + y2 });
              const id = newId();
              const arrow: ArrowShape = {
                id, type: "arrow", x: start.x, y: start.y, rotation: 0, opacity: 1,
                x2, y2, color: st.color, size: st.size,
                bindStart: startHit ? { shapeId: startHit } : undefined,
                bindEnd: endHit ? { shapeId: endHit } : undefined,
              };
              store.createShapes([{ ...arrow, ...resolveArrow(arrow, (i) => store.getShape(i)) }]);
              setTool("select");
            }
          } else {
            let w = Math.abs(cur.x - start.x);
            let h = Math.abs(cur.y - start.y);
            if (sess.shift) w = h = Math.max(w, h);
            if (w > 4 && h > 4) {
              store.createShapes([
                {
                  id: newId(), type: "geo",
                  geo: kind === "ellipse" ? "ellipse" : "rectangle",
                  x: Math.min(start.x, sess.shift ? start.x + (cur.x < start.x ? -w : 0) : cur.x),
                  y: Math.min(start.y, sess.shift ? start.y + (cur.y < start.y ? -h : 0) : cur.y),
                  rotation: 0, opacity: 1, w, h,
                  color: st.color, fill: st.fill, size: st.size,
                },
              ]);
              setTool("select");
            }
          }
          break;
        }
        default:
          break;
      }
      bumpSession();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [clientToStage, toPage, store, eraseAt, scheduleRender, expandGroup]);

  // ---------- 滚轮：以光标为中心缩放（平移交给右键/中键/空格拖动） ----------
  const onWheel = useCallback(
    (e: Konva.KonvaEventObject<WheelEvent>) => {
      e.evt.preventDefault();
      const pos = clientToStage(e.evt);
      zoomAt(pos, camRef.current.z * Math.pow(1.0015, -e.evt.deltaY));
    },
    [clientToStage, zoomAt]
  );

  // ---------- 双击：文本进入编辑 / 图片进入裁剪（空白处不再建文本，避免误触） ----------
  const onDblClick = useCallback(
    (e: Konva.KonvaEventObject<MouseEvent>) => {
      if (toolRef.current !== "select" || cropRef.current) return;
      const hitId = shapeIdAt(e.target === e.target.getStage() ? null : e.target);
      if (!hitId || hitId === "ui") return;
      const s = store.getShape(hitId);
      if (s?.locked) return;
      if (s?.type === "text") {
        store.setSelection([hitId]);
        setEditing({ id: hitId, x: s.x, y: s.y });
      } else if (s?.type === "image") {
        store.setSelection([hitId]);
        setCrop({ id: hitId, rect: s.crop ? { ...s.crop } : { x: 0, y: 0, w: 1, h: 1 } });
      }
    },
    [shapeIdAt, store]
  );

  // ---------- 右键菜单 ----------
  const onContextMenu = useCallback(
    (e: Konva.KonvaEventObject<PointerEvent>) => {
      e.evt.preventDefault();
      if (rightPannedRef.current) {
        rightPannedRef.current = false; // 右键拖动平移过，本次不弹菜单
        return;
      }
      const hitId = shapeIdAt(e.target === e.target.getStage() ? null : e.target);
      if (hitId && hitId !== "ui" && !store.isSelected(hitId)) store.setSelection([hitId]);
      // 屏幕坐标：菜单 Portal 到 body 用 fixed 定位（脱离画板容器 overflow:hidden 裁切）
      setMenu({ x: e.evt.clientX, y: e.evt.clientY });
    },
    [shapeIdAt, store]
  );

  const pasteShapes = useCallback(
    (at?: P) => {
      if (!boardClipboard.length) return;
      const b = unionBounds(boardClipboard);
      const offset = at && b ? { x: at.x - b.x - b.w / 2, y: at.y - b.y - b.h / 2 } : { x: 16, y: 16 };
      const copies = boardClipboard.map((s) => ({
        ...JSON.parse(JSON.stringify(s)),
        id: newId(),
        x: s.x + offset.x,
        y: s.y + offset.y,
      }));
      store.createShapes(copies);
    },
    [store]
  );

  // ---------- 系统剪贴板：图片优先（落盘入库+上板），无图回退内部形状粘贴 ----------
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (cropRef.current || editingRef.current) return; // 文本编辑/裁剪中不接管
      const items = e.clipboardData?.items;
      const imgItem = items && [...items].find((i) => i.type.startsWith("image/"));
      if (!imgItem) {
        e.preventDefault();
        pasteShapes();
        return;
      }
      e.preventDefault();
      const file = imgItem.getAsFile();
      if (!file) return;
      (async () => {
        const el = containerRef.current!;
        const center = toPage({ x: el.clientWidth / 2, y: el.clientHeight / 2 });
        const place = (src: string, w0: number, h0: number, name: string, sourcePath?: string) => {
          const MAX = 480;
          const sc = Math.min(1, MAX / Math.max(w0, h0, 1));
          const w = Math.max(40, w0 * sc);
          const h = Math.max(40, h0 * sc);
          store.createShapes([
            {
              id: newId(), type: "image", x: center.x - w / 2, y: center.y - h / 2,
              rotation: 0, opacity: 1, w, h, src, name,
              sourcePath,
            },
          ]);
        };
        const ext = (file.type.split("/")[1] || "png").replace("jpeg", "jpg");
        try {
          const buf = await file.arrayBuffer();
          // 走素材导入管线：落盘 图片\Nobi + 入素材库，画板引用文件路径
          const info = await importBlob(`粘贴_${Date.now()}.${ext}`, bufToB64(buf));
          place(convertFileSrc(info.path), info.width, info.height, info.name, info.path);
        } catch {
          // 浏览器环境/落盘失败：dataURL 直接上板兜底
          const url = await new Promise<string>((res) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result));
            fr.readAsDataURL(file);
          });
          const dims = await new Promise<{ w: number; h: number }>((res) => {
            const im = new window.Image();
            im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
            im.onerror = () => res({ w: 400, h: 400 });
            im.src = url;
          });
          place(url, dims.w, dims.h, "粘贴图片");
        }
      })();
    },
    [store, toPage, pasteShapes]
  );

  // ---------- 对齐 / 分布 ----------
  const alignSel = useCallback(
    (mode: "left" | "centerX" | "right" | "top" | "centerY" | "bottom") => {
      const shapes = store.selectedShapes();
      if (shapes.length < 2) return;
      const u = unionBounds(shapes)!;
      store.mutate(() => {
        store.shapes = store.shapes.map((s) => {
          if (!store.selection.includes(s.id)) return s;
          const b = shapeBounds(s);
          let dx = 0;
          let dy = 0;
          if (mode === "left") dx = u.x - b.x;
          else if (mode === "centerX") dx = u.x + u.w / 2 - (b.x + b.w / 2);
          else if (mode === "right") dx = u.x + u.w - (b.x + b.w);
          else if (mode === "top") dy = u.y - b.y;
          else if (mode === "centerY") dy = u.y + u.h / 2 - (b.y + b.h / 2);
          else dy = u.y + u.h - (b.y + b.h);
          return { ...s, x: s.x + dx, y: s.y + dy };
        });
      });
    },
    [store]
  );
  const distributeSel = useCallback(
    (axis: "x" | "y") => {
      const shapes = store.selectedShapes();
      if (shapes.length < 3) return;
      const items = shapes.map((s) => ({ s, b: shapeBounds(s) }));
      items.sort((a, b) => (axis === "x" ? a.b.x - b.b.x : a.b.y - b.b.y));
      const first = items[0].b;
      const last = items[items.length - 1].b;
      const total = items.reduce((m, i) => m + (axis === "x" ? i.b.w : i.b.h), 0);
      const span =
        axis === "x" ? last.x + last.w - first.x : last.y + last.h - first.y;
      const gap = (span - total) / (items.length - 1);
      let cursor = axis === "x" ? first.x : first.y;
      const moves = new Map<string, number>();
      for (const it of items) {
        moves.set(it.s.id, cursor - (axis === "x" ? it.b.x : it.b.y));
        cursor += (axis === "x" ? it.b.w : it.b.h) + gap;
      }
      store.mutate(() => {
        store.shapes = store.shapes.map((s) => {
          const d = moves.get(s.id);
          if (d === undefined) return s;
          return axis === "x" ? { ...s, x: s.x + d } : { ...s, y: s.y + d };
        });
      });
    },
    [store]
  );

  // ---------- 组合 / 取消组合 ----------
  const groupSelection = useCallback(() => {
    if (store.selection.length < 2) return;
    const gid = newId();
    store.mutate(() => {
      store.shapes = store.shapes.map((s) =>
        store.selection.includes(s.id) ? { ...s, groupId: gid } : s
      );
    });
  }, [store]);
  const ungroupSelection = useCallback(() => {
    store.mutate(() => {
      store.shapes = store.shapes.map((s) =>
        store.selection.includes(s.id) ? { ...s, groupId: undefined } : s
      );
    });
  }, [store]);

  // ---------- 文本样式开关（加粗/斜体/下划线） ----------
  // 编辑中：作用于 TipTap 选区（行内级）；否则作用于选中文本形状（整块+全部分段），并记为新建默认
  const toggleTextStyle = useCallback(
    (k: "bold" | "italic" | "underline") => {
      const ted = tiptapRef.current;
      if (ted) {
        const c = ted.chain().focus();
        if (k === "bold") c.toggleBold();
        else if (k === "italic") c.toggleItalic();
        else c.toggleUnderline();
        c.run();
        return;
      }
      const texts = store.selectedShapes().filter((s): s is TextShape => s.type === "text");
      const eff = (t: TextShape) =>
        t.runs?.length ? t.runs.every((r) => !!r[k]) : !!t[k];
      const cur = texts.length ? texts.every(eff) : !!styleRef.current[k];
      const next = !cur;
      setStyle((s) => ({ ...s, [k]: next }));
      if (texts.length) {
        store.mutate(() => {
          store.shapes = store.shapes.map((s) => {
            if (!store.selection.includes(s.id) || s.type !== "text") return s;
            const upd: TextShape = { ...s, [k]: next || undefined };
            if (s.runs?.length) upd.runs = s.runs.map((r) => ({ ...r, [k]: next || undefined }));
            return upd;
          });
        });
      }
    },
    [store]
  );

  // ---------- 导出 PNG（选区优先，否则全部；离屏克隆不动正式画布） ----------
  const exportPng = useCallback(async () => {
    const targets = store.selection.length ? store.selectedShapes() : store.shapes;
    const keep = new Set(targets.map((s) => s.id));
    const b = unionBounds(targets);
    const src = contentRef.current;
    if (!b || !src) return;
    const pad = 32;
    const scale = Math.min(2, 8000 / Math.max(b.w + pad * 2, b.h + pad * 2));
    const holder = document.createElement("div");
    // 离屏渲染：用屏外定位而非 display:none——Konva Stage 在 display:none 容器里
    // 会得到空画布（toDataURL 返回空），屏外定位仍正常渲染。
    holder.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;opacity:0;";
    document.body.appendChild(holder);
    try {
      const stage = new Konva.Stage({
        container: holder,
        width: Math.ceil((b.w + pad * 2) * scale),
        height: Math.ceil((b.h + pad * 2) * scale),
      });
      const cloneLayer = src.clone({ listening: false }) as Konva.Layer;
      cloneLayer.position({ x: (-b.x + pad) * scale, y: (-b.y + pad) * scale });
      cloneLayer.scale({ x: scale, y: scale });
      stage.add(cloneLayer);
      for (const child of [...cloneLayer.getChildren()]) {
        if (!keep.has(child.id())) child.destroy();
        else child.visible(true); // 视口外裁剪过的形状导出时要恢复可见
      }
      cloneLayer.draw();
      const dataUrl = stage.toDataURL({ mimeType: "image/png" });
      stage.destroy();
      // 守卫：空内容时给明确提示，别再抛 "missing dataB64" 这种谜之错误
      if (!dataUrl || dataUrl.indexOf(",") < 0) {
        await msgDialog(
          "导出内容为空（可能图片还没加载完，或选区没有可见内容）。稍后重试，或改成「全部」导出。",
          { title: "导出 PNG", kind: "warning" },
        ).catch(() => {});
        return;
      }
      const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      const name = `${boards.find((bd) => bd.id === boardIdRef.current)?.name || "画板"}.png`;
      let path: string | null = null;
      try {
        path = await saveDialog({
          defaultPath: name,
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
      } catch (e) {
        // 桌面 app 里 saveDialog 不该失败；真失败就报错——别写出坏掉的浏览器下载
        //（WebView2 里 <a download> 存 data URL 会得到一个假 png/HTML 文件）。
        const isTauri =
          typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
        if (isTauri) {
          await msgDialog(`导出失败：${String(e)}`, { title: "导出 PNG", kind: "error" }).catch(
            () => {},
          );
        } else {
          const a = document.createElement("a");
          a.href = dataUrl;
          a.download = name;
          a.click();
        }
        return;
      }
      if (!path) return; // 用户取消了保存对话框
      try {
        await saveFile(path, b64);
        // 存好后直接打开所在文件夹并高亮该文件——再也不用找
        await revealItemInDir(path).catch(() => {});
      } catch (e) {
        await msgDialog(`导出失败：${String(e)}`, { title: "导出 PNG", kind: "error" }).catch(
          () => {},
        );
      }
    } finally {
      holder.remove();
    }
  }, [store, boards]);

  // ---------- 键盘 ----------
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable) return;
      const ctrl = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // 裁剪模式：Enter 提交，Esc 取消，其余快捷键屏蔽
      if (cropRef.current) {
        if (key === "escape") setCrop(null);
        else if (key === "enter") commitCrop();
        e.preventDefault();
        return;
      }

      if (key === " ") {
        spaceRef.current = true;
        setSpaceDown(true);
        e.preventDefault();
        return;
      }
      // 可自定义快捷键派发（绑定表：默认 + 用户改键）
      const combo = comboOf(e);
      if (combo) {
        const b = bindingsRef.current;
        const hit = HOTKEYS.find((h) => !h.fixed && b[h.id] === combo);
        if (hit) {
          e.preventDefault();
          const center = { x: size.w / 2, y: size.h / 2 };
          switch (hit.id) {
            case "tool.select": setTool("select"); return;
            case "tool.hand": setTool("hand"); return;
            case "tool.draw": setTool("draw"); return;
            case "tool.eraser": setTool("eraser"); return;
            case "tool.arrow": setTool("arrow"); return;
            case "tool.rect": setTool("rect"); return;
            case "tool.ellipse": setTool("ellipse"); return;
            case "tool.text": setTool("text"); return;
            case "edit.undo": store.undo(); return;
            case "edit.redo": store.redo(); return;
            case "edit.delete": store.deleteShapes([...store.selection]); return;
            case "edit.selectAll":
              store.setSelection(store.shapes.filter((s) => !s.locked).map((s) => s.id));
              return;
            case "edit.duplicate": store.duplicate(store.selection); return;
            case "edit.copy":
              boardClipboard = JSON.parse(JSON.stringify(store.selectedShapes()));
              return;
            case "edit.cut":
              boardClipboard = JSON.parse(JSON.stringify(store.selectedShapes()));
              store.deleteShapes([...store.selection]);
              return;
            case "edit.group": groupSelection(); return;
            case "edit.ungroup": ungroupSelection(); return;
            case "view.zoomIn": zoomAt(center, camRef.current.z * 1.25); return;
            case "view.zoomOut": zoomAt(center, camRef.current.z / 1.25); return;
            case "view.zoom100": zoomAt(center, 1); return;
            case "view.zoomFit": zoomToFit(); return;
            case "view.snap":
              setSnapOn((v) => {
                showToast(`对齐吸附 ${v ? "已关闭" : "已开启"}（${b["view.snap"]}）`);
                return !v;
              });
              return;
          }
        }
      }
      // 固定快捷键（不可改）
      if (ctrl && (key === "b" || key === "i" || key === "u")) {
        e.preventDefault();
        toggleTextStyle(key === "b" ? "bold" : key === "i" ? "italic" : "underline");
        return;
      }
      if (ctrl && key === "y") {
        store.redo();
        e.preventDefault();
        return;
      }
      // Ctrl+V 由容器的 onPaste 处理（系统剪贴板图片优先，否则内部形状）
      if (key === "delete" || key === "backspace") {
        store.deleteShapes([...store.selection]);
        return;
      }
      if (key === "escape") {
        if (store.selection.length) store.setSelection([]);
        else setTool("select");
        return;
      }
      if (key === "]" || key === "[") {
        const dir = key === "]" ? (e.shiftKey ? "front" : "forward") : e.shiftKey ? "back" : "backward";
        store.reorder([...store.selection], dir);
        return;
      }
      if (["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
        if (!store.selection.length) return;
        const d = e.shiftKey ? 10 : 1;
        const dx = key === "arrowleft" ? -d : key === "arrowright" ? d : 0;
        const dy = key === "arrowup" ? -d : key === "arrowdown" ? d : 0;
        store.mutate(() => {
          store.shapes = store.shapes.map((s) =>
            store.selection.includes(s.id) ? { ...s, x: s.x + dx, y: s.y + dy } : s
          );
        });
        e.preventDefault();
        return;
      }
    },
    [store, zoomAt, zoomToFit, size, commitCrop, groupSelection, ungroupSelection, showToast, toggleTextStyle]
  );
  const onKeyUp = useCallback((e: React.KeyboardEvent) => {
    if (e.key === " ") {
      spaceRef.current = false;
      setSpaceDown(false);
    }
  }, []);

  // ---------- 拖拽落图（素材网格 / 桌面文件 → 画板） ----------
  const onDragOver = useCallback((e: React.DragEvent) => {
    const types = e.dataTransfer.types;
    // 文件直接落到画板上（仅上板、不入库、不保存——可能只是临时参考）
    if (types.includes("Files")) {
      e.preventDefault();
      return;
    }
    if (types.includes("text/uri-list") || types.includes("text/plain")) e.preventDefault();
  }, []);
  // 桌面文件拖到画板：每个图片读成 dataURL 直接上板，不落盘、不入库
  const dropFiles = useCallback(
    (files: File[], at: P) => {
      const imgs = files.filter((f) => f.type.startsWith("image/"));
      imgs.forEach((file, i) => {
        const fr = new FileReader();
        fr.onload = () => {
          const url = String(fr.result);
          const im = new window.Image();
          im.onload = () => {
            const w0 = im.naturalWidth || 400;
            const h0 = im.naturalHeight || 400;
            const MAX = 360;
            const scale = Math.min(1, MAX / Math.max(w0, h0, 1));
            const w = Math.max(40, w0 * scale);
            const h = Math.max(40, h0 * scale);
            store.createShapes([
              {
                id: newId(), type: "image",
                x: at.x - w / 2 + i * 24, y: at.y - h / 2 + i * 24,
                rotation: 0, opacity: 1, w, h, src: url,
                name: file.name.replace(/\.[^.]+$/, "") || "拖入图片",
              },
            ]);
          };
          im.src = url;
        };
        fr.readAsDataURL(file);
      });
    },
    [store]
  );
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (e.dataTransfer.types.includes("Files")) {
        const files = Array.from(e.dataTransfer.files || []);
        if (!files.length) return;
        e.preventDefault();
        e.stopPropagation();
        dropFiles(files, toPage(clientToStage(e)));
        return;
      }
      const raw =
        e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
      const urls = raw
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && IMG_URL_RE.test(l));
      if (!urls.length) return;
      e.preventDefault();
      e.stopPropagation();
      const page = toPage(clientToStage(e));
      urls.forEach((url, i) => {
        const img = new window.Image();
        const place = (w0: number, h0: number) => {
          const MAX = 360;
          const scale = Math.min(1, MAX / Math.max(w0, h0, 1));
          const w = Math.max(40, w0 * scale);
          const h = Math.max(40, h0 * scale);
          store.createShapes([
            {
              id: newId(), type: "image",
              x: page.x - w / 2 + i * 24, y: page.y - h / 2 + i * 24,
              rotation: 0, opacity: 1, w, h, src: url, name: "拖入图片",
            },
          ]);
        };
        img.onload = () => place(img.naturalWidth, img.naturalHeight);
        img.onerror = () => place(400, 400);
        img.src = url;
      });
    },
    [toPage, clientToStage, store, dropFiles]
  );

  // 画板图片「保存到素材库」：把临时拖入的图（dataURL/外链）落盘入库，
  // 入库后把该形状改成引用库文件并记下 assetId/sourcePath。
  const saveSelectedToLibrary = useCallback(async () => {
    if (!onSaveToLibrary) return;
    const im = store.selectedShapes()[0];
    if (!im || im.type !== "image") return;
    let b64 = "";
    try {
      if (im.src.startsWith("data:")) {
        b64 = im.src.split(",")[1] ?? "";
      } else {
        const buf = await (await fetch(im.src)).arrayBuffer();
        b64 = bufToB64(buf);
      }
    } catch {
      showToast("读取图片失败，无法保存");
      return;
    }
    if (!b64) return;
    const ext = im.src.startsWith("data:")
      ? (im.src.slice(5, im.src.indexOf(";")).split("/")[1] || "png").replace("jpeg", "jpg")
      : "png";
    const saved = await onSaveToLibrary({ name: `${im.name || "画板图片"}.${ext}`, dataB64: b64 });
    if (!saved) return;
    store.mutate(() => {
      store.shapes = store.shapes.map((s) =>
        s.id === im.id && s.type === "image"
          ? {
              ...s,
              src: convertFileSrc(saved.sourcePath),
              sourcePath: saved.sourcePath,
              assetId: saved.assetId,
              thumbSrc: saved.thumb ? convertFileSrc(saved.thumb) : s.thumbSrc,
            }
          : s
      );
    });
    showToast("已保存到素材库");
  }, [onSaveToLibrary, store]);

  // ---------- 样式应用 ----------
  const applyStyle = useCallback(
    (patch: Partial<Style>) => {
      // 文本编辑中点色盘 = 给选区文字上色（行内级）
      if (patch.color && tiptapRef.current) {
        tiptapRef.current.chain().focus().setColor(colorHex(patch.color)).run();
        setStyle((s) => ({ ...s, color: patch.color! }));
        return;
      }
      setStyle((s) => ({ ...s, ...patch }));
      const ids = store.selection;
      if (!ids.length) return;
      store.mutate(() => {
        store.shapes = store.shapes.map((s) => {
          if (!ids.includes(s.id) || s.type === "image") return s;
          const next: any = { ...s };
          if (patch.color) {
            next.color = patch.color;
            // 整块改色 = 统一颜色，清掉分段级覆盖
            if (s.type === "text" && s.runs?.length) {
              next.runs = s.runs.map((r) => ({ ...r, color: undefined }));
            }
          }
          if (patch.size) {
            if (s.type === "text") next.fontSize = FONT_PX[patch.size];
            else next.size = patch.size;
          }
          if (patch.fill && s.type === "geo") next.fill = patch.fill;
          if (patch.brush && s.type === "draw") next.brush = patch.brush;
          return next;
        });
      });
    },
    [store]
  );

  // 桌面取色器（Ctrl+Alt+C）取到色 → 设为画板当前颜色（编辑中=给选区文字上色，
  // 选中形状=改其颜色，否则=之后新建文字/画笔/图形的默认色）。任意 hex 直接用。
  useEffect(() => {
    const un = listen<{ hex: string }>("color-picked", (e) => {
      if (e.payload?.hex) applyStyle({ color: e.payload.hex });
    });
    return () => {
      un.then((f) => f());
    };
  }, [applyStyle]);

  // ---------- 文本编辑覆盖层 ----------
  let editingShape: TextShape | null = null;
  if (editing) {
    if (editing.id) {
      const s = store.getShape(editing.id);
      editingShape = s?.type === "text" ? s : null;
    } else {
      // 新建中：纯浮层，未落库
      editingShape = {
        id: "", type: "text", x: editing.x, y: editing.y, rotation: 0, opacity: 1,
        text: "", color: style.color, fontSize: FONT_PX[style.size],
        bold: style.bold, italic: style.italic, underline: style.underline,
      };
    }
  }
  // TipTap 编辑器实例（编辑会话期间有效）；transaction 时刷新以联动样式面板高亮
  const tiptapRef = useRef<TiptapEditor | null>(null);
  const [, bumpEditor] = useReducer((x: number) => x + 1, 0);
  const onEditorReady = useCallback((ed: TiptapEditor) => {
    tiptapRef.current = ed;
    ed.on("transaction", bumpEditor);
    if (import.meta.env.DEV) (window as any).__nobiBoard.tiptap = ed;
  }, []);

  const commitText = useCallback(
    (doc: unknown) => {
      const ed = editingRef.current;
      if (!ed) return; // blur 与 Esc 双触发时只提交一次
      setEditing(null);
      tiptapRef.current = null;
      const runs = docToRuns(doc);
      const text = runsToText(runs);
      // 整块布尔与 runs 同步（全段一致才置位），面板/旧逻辑可继续依赖它们
      const summary = {
        bold: runs.length > 0 && runs.every((r) => r.bold) ? true : undefined,
        italic: runs.length > 0 && runs.every((r) => r.italic) ? true : undefined,
        underline: runs.length > 0 && runs.every((r) => r.underline) ? true : undefined,
      };
      if (ed.id) {
        const s = store.getShape(ed.id);
        if (!s || s.type !== "text") return;
        if (!text.trim()) {
          // 清空已有文本 = 删除
          store.mutate(() => {
            store.shapes = store.shapes.filter((sh) => sh.id !== ed.id);
            store.selection = store.selection.filter((i) => i !== ed.id);
          });
        } else {
          store.mutate(() => {
            store.shapes = store.shapes.map((sh) =>
              sh.id === ed.id && sh.type === "text" ? { ...sh, text, runs, ...summary } : sh
            );
          });
        }
      } else if (text.trim()) {
        // 新建：有内容才落库，空文本不留任何痕迹
        const st = styleRef.current;
        store.createShapes([
          {
            id: newId(), type: "text", x: ed.x, y: ed.y, rotation: 0, opacity: 1,
            text, runs, color: st.color, fontSize: FONT_PX[st.size], ...summary,
          },
        ]);
      }
    },
    [store]
  );

  // ---------- 渲染 ----------
  const sess = sessionRef.current;
  const st = styleRef.current;

  // 视口外裁剪：屏外形状 visible=false，Konva 跳过绘制（外扩 25% 防滚动闪边）
  const viewBox: Box = {
    x: (-cam.x - size.w * 0.25) / cam.z,
    y: (-cam.y - size.h * 0.25) / cam.z,
    w: (size.w * 1.5) / cam.z,
    h: (size.h * 1.5) / cam.z,
  };

  // 多选样式面板：选区内属性一致才高亮，混合时不高亮（无选区时显示默认样式）
  const styleable = selShapes.filter((s) => s.type !== "image");
  const allSame = <T,>(vals: (T | null)[]): T | null =>
    vals.length && vals.every((v) => v === vals[0]) ? vals[0] : null;
  const dispColor = styleable.length
    ? allSame(styleable.map((s) => colorHex((s as { color: string }).color).toLowerCase()))
    : colorHex(style.color).toLowerCase();
  const sizeKeyOf = (s: BoardShape): SizeKey | null =>
    s.type === "text"
      ? ((Object.keys(FONT_PX) as SizeKey[]).find((k) => FONT_PX[k] === s.fontSize) ?? null)
      : s.type === "image"
        ? null
        : s.size;
  const dispSize = styleable.length ? allSame(styleable.map(sizeKeyOf)) : style.size;
  const selGeos = selShapes.filter((s): s is GeoShape => s.type === "geo");
  const dispFill = selGeos.length ? allSame(selGeos.map((s) => s.fill)) : style.fill;
  const selDraws = selShapes.filter((s): s is DrawShape => s.type === "draw");
  const dispBrush = selDraws.length
    ? allSame(selDraws.map((s) => s.brush ?? "pen"))
    : style.brush;
  const selTexts = selShapes.filter((s): s is TextShape => s.type === "text");
  const showTextStyle = tool === "text" || selTexts.length > 0 || !!editing;
  const dispTS = (k: "bold" | "italic" | "underline") => {
    const ted = tiptapRef.current;
    if (ted) return ted.isActive(k); // 编辑中：跟随光标/选区
    return selTexts.length
      ? selTexts.every((t) => (t.runs?.length ? t.runs.every((r) => !!r[k]) : !!t[k]))
      : !!style[k];
  };

  const previewDraw: DrawShape | null =
    sess?.mode === "draw"
      ? {
          id: "__preview", type: "draw", x: 0, y: 0, rotation: 0, opacity: 1,
          points: sess.points, color: st.color, size: st.size, brush: st.brush,
          pressures: sess.isPen ? sess.press : undefined,
        }
      : null;

  let previewCreate: BoardShape | null = null;
  if (sess?.mode === "create") {
    const { start, cur, kind, shift } = sess;
    if (kind === "arrow") {
      previewCreate = {
        id: "__preview", type: "arrow", x: start.x, y: start.y, rotation: 0, opacity: 0.9,
        x2: cur.x - start.x, y2: cur.y - start.y, color: st.color, size: st.size,
      };
    } else {
      let w = Math.abs(cur.x - start.x);
      let h = Math.abs(cur.y - start.y);
      if (shift) w = h = Math.max(w, h);
      previewCreate = {
        id: "__preview", type: "geo", geo: kind === "ellipse" ? "ellipse" : "rectangle",
        x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y),
        rotation: 0, opacity: 0.9, w, h, color: st.color, fill: st.fill, size: st.size,
      };
    }
  }

  const marquee =
    sess?.mode === "marquee"
      ? {
          x: Math.min(sess.start.x, sess.cur.x),
          y: Math.min(sess.start.y, sess.cur.y),
          w: Math.abs(sess.start.x - sess.cur.x),
          h: Math.abs(sess.start.y - sess.cur.y),
        }
      : null;

  const arrowSel = singleArrow ? (selShapes[0] as ArrowShape) : null;

  const cursor =
    sess?.mode === "pan" ? "grabbing"
    : tool === "hand" || spaceDown ? "grab"
    : tool === "text" ? "text"
    : tool === "select" ? "default"
    : "crosshair";

  const showStyles =
    ["draw", "rect", "ellipse", "arrow", "text"].includes(tool) ||
    selShapes.some((s) => s.type !== "image");
  const showFill = tool === "rect" || tool === "ellipse" || selShapes.some((s) => s.type === "geo");
  const showBrush = tool === "draw" || selShapes.some((s) => s.type === "draw");

  const editorPos = editingShape ? toScreen({ x: editingShape.x, y: editingShape.y }) : null;

  return (
    <div
      ref={containerRef}
      className="bd-root"
      tabIndex={0}
      style={{ cursor }}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Stage
        ref={stageRef}
        width={Math.max(1, size.w)}
        height={Math.max(1, size.h)}
        onPointerDown={onStagePointerDown}
        onWheel={onWheel}
        onDblClick={onDblClick}
        onContextMenu={onContextMenu}
      >
        <Layer ref={contentRef} x={cam.x} y={cam.y} scaleX={cam.z} scaleY={cam.z}>
          {store.shapes.map((s) => (
            <ShapeView
              key={s.id}
              s={s}
              hidden={editing?.id === s.id || crop?.id === s.id}
              offscreen={!boxesIntersect(viewBox, shapeBounds(s))}
              // LOD：无独立缩略图或显示宽度超 512px 时加载原图（仅 image 形状）
              imgFull={s.type === "image" && (!s.thumbSrc || s.w * cam.z > 512)}
            />
          ))}
          {previewDraw && <ShapeView s={previewDraw} hidden={false} />}
          {previewCreate && <ShapeView s={previewCreate} hidden={false} />}
          {crop &&
            (() => {
              const s = store.getShape(crop.id);
              return s?.type === "image" ? (
                <CropEditor
                  shape={s}
                  rect={crop.rect}
                  zoom={cam.z}
                  onChange={(r) => setCrop({ id: crop.id, rect: r })}
                />
              ) : null;
            })()}
        </Layer>
        <Layer name="ui">
          <Transformer
            ref={trRef}
            name="ui"
            rotateEnabled
            flipEnabled={false}
            rotateAnchorOffset={26}
            anchorSize={9}
            anchorCornerRadius={2}
            anchorStroke={BLUE}
            anchorStrokeWidth={1.5}
            anchorFill="#fff"
            borderStroke={BLUE}
            borderStrokeWidth={1.5}
            ignoreStroke
            onTransformStart={onTransformStart}
            onTransformEnd={onTransformEnd}
          />
          {marquee && (
            <KRect
              name="ui"
              x={marquee.x}
              y={marquee.y}
              width={marquee.w}
              height={marquee.h}
              fill={hexAlpha(BLUE, 0.08)}
              stroke={BLUE}
              strokeWidth={1}
              listening={false}
            />
          )}
          {/* 吸附参考线 */}
          {sess?.mode === "move" &&
            sess.guides?.v.map((x, i) => (
              <KLine
                key={`gv${i}`}
                name="ui"
                points={[toScreen({ x, y: 0 }).x, 0, toScreen({ x, y: 0 }).x, size.h]}
                stroke="#e64980"
                strokeWidth={1}
                listening={false}
              />
            ))}
          {sess?.mode === "move" &&
            sess.guides?.h.map((y, i) => (
              <KLine
                key={`gh${i}`}
                name="ui"
                points={[0, toScreen({ x: 0, y }).y, size.w, toScreen({ x: 0, y }).y]}
                stroke="#e64980"
                strokeWidth={1}
                listening={false}
              />
            ))}
          {arrowSel &&
            !editing &&
            (["start", "end"] as const).map((which) => {
              const pt =
                which === "start"
                  ? toScreen({ x: arrowSel.x, y: arrowSel.y })
                  : toScreen({ x: arrowSel.x + arrowSel.x2, y: arrowSel.y + arrowSel.y2 });
              return (
                <KRect
                  key={which}
                  name="ui"
                  x={pt.x - 5}
                  y={pt.y - 5}
                  width={10}
                  height={10}
                  cornerRadius={5}
                  fill="#fff"
                  stroke={BLUE}
                  strokeWidth={1.5}
                  draggable
                  onDragStart={() => {
                    transformCp.current = store.checkpoint();
                  }}
                  onDragMove={(ev) => {
                    const p = toPage({ x: ev.target.x() + 5, y: ev.target.y() + 5 });
                    // 端点落在某形状上 → 绑定该形状（不含箭头自身）
                    const hit = hitTestShape(store.shapes, p, arrowSel.id);
                    const bind = hit ? { shapeId: hit } : undefined;
                    store.applyLive(() => {
                      store.shapes = reflowArrows(
                        store.shapes.map((sh) => {
                          if (sh.id !== arrowSel.id || sh.type !== "arrow") return sh;
                          if (which === "start") {
                            const endX = sh.x + sh.x2;
                            const endY = sh.y + sh.y2;
                            return { ...sh, x: p.x, y: p.y, x2: endX - p.x, y2: endY - p.y, bindStart: bind };
                          }
                          return { ...sh, x2: p.x - sh.x, y2: p.y - sh.y, bindEnd: bind };
                        })
                      );
                    });
                  }}
                  onDragEnd={() => {
                    if (transformCp.current) store.commit(transformCp.current);
                    transformCp.current = null;
                  }}
                />
              );
            })}
        </Layer>
      </Stage>

      {/* 文本编辑覆盖层（TipTap 富文本，选中部分文字可单独改样式） */}
      {editingShape && editorPos && (
        <TextEditorOverlay
          key={editing?.id ?? "new"}
          doc={shapeToDoc(editingShape)}
          initMarks={{ bold: style.bold, italic: style.italic, underline: style.underline }}
          onReady={onEditorReady}
          onCommit={commitText}
          style={{
            left: editorPos.x,
            top: editorPos.y,
            width: editingShape.w ? editingShape.w * cam.z : "max-content",
            minWidth: 24,
            maxWidth: editingShape.w ? undefined : 600 * cam.z,
            fontSize: editingShape.fontSize * cam.z,
            lineHeight: 1.35,
            color: colorHex(editingShape.color),
            fontFamily: FONT_FAMILY,
            textAlign: editingShape.align ?? "left",
            transform: `rotate(${editingShape.rotation}deg)`,
            transformOrigin: "left top",
          }}
        />
      )}

      {/* 右键菜单：Portal 到 body + fixed 定位（方案1，脱离画板容器裁切），长列表收进二级飞出菜单 */}
      {menu &&
        createPortal(
          <>
            <div
              className="bd-menu-overlay"
              onPointerDown={() => setMenu(null)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu(null);
              }}
            />
            <div ref={bdMenuRef} className="bd-menu bd-menu-fixed" style={{ left: menu.x, top: menu.y }}>
              {(
                [
                  ...(singleImage
                    ? ([
                        [
                          "裁剪图片", "双击", true,
                          () => {
                            const s = store.selectedShapes()[0];
                            if (s.type === "image") {
                              setCrop({ id: s.id, rect: s.crop ? { ...s.crop } : { x: 0, y: 0, w: 1, h: 1 } });
                            }
                          },
                        ],
                        ...(onOpenReference
                          ? [[
                              "悬浮到桌面（置顶参考）", "",
                              (() => {
                                const im = selShapes[0] as ImageShape;
                                return !!im.sourcePath || im.assetId != null;
                              })(),
                              () => {
                                const im = selShapes[0] as ImageShape;
                                onOpenReference({
                                  assetId: im.assetId,
                                  sourcePath: im.sourcePath,
                                  src: im.src,
                                  name: im.name,
                                  width: im.w,
                                  height: im.h,
                                });
                              },
                            ] as [string, string, boolean, () => void]]
                          : []),
                        // 找库里相似图：有 assetId 走 clip_similar，无则用图像素算向量反查
                        ...(onFindSimilar
                          ? [[
                              "找库里相似图", "", true,
                              () => {
                                const im = selShapes[0] as ImageShape;
                                onFindSimilar({ assetId: im.assetId, src: im.src });
                              },
                            ] as [string, string, boolean, () => void]]
                          : []),
                        // 保存到素材库：仅对「临时拖入、尚未入库」的图（无 assetId 也无 sourcePath）开放
                        ...(onSaveToLibrary
                          ? [[
                              "保存到素材库", "",
                              (() => {
                                const im = selShapes[0] as ImageShape;
                                return im.assetId == null && !im.sourcePath;
                              })(),
                              () => void saveSelectedToLibrary(),
                            ] as [string, string, boolean, () => void]]
                          : []),
                      ] as [string, string, boolean, () => void][])
                    : []),
                  ["复制", bindings["edit.copy"], selection.length > 0, () => {
                    boardClipboard = JSON.parse(JSON.stringify(store.selectedShapes()));
                  }],
                  ["粘贴", "Ctrl+V", boardClipboard.length > 0, () =>
                    pasteShapes(toPage(clientToStage({ clientX: menu.x, clientY: menu.y })))],
                  ["创建副本", bindings["edit.duplicate"], selection.length > 0, () => store.duplicate(selection)],
                  ["删除", bindings["edit.delete"], selection.length > 0, () => store.deleteShapes([...selection])],
                  null,
                  ["组合", bindings["edit.group"], selection.length >= 2, groupSelection],
                  ["取消组合", bindings["edit.ungroup"], selShapes.some((s) => s.groupId), ungroupSelection],
                  ["锁定", "", selection.length > 0, () => {
                    store.mutate(() => {
                      store.shapes = store.shapes.map((s) =>
                        store.selection.includes(s.id) ? { ...s, locked: true } : s
                      );
                      store.selection = [];
                    });
                  }],
                  ["解锁全部", "", store.shapes.some((s) => s.locked), () => {
                    store.mutate(() => {
                      store.shapes = store.shapes.map((s) => (s.locked ? { ...s, locked: undefined } : s));
                    });
                  }],
                  null,
                  {
                    sub: "排列",
                    enabled: selection.length > 0,
                    items: [
                      ["置于顶层", "Shift+]", true, () => store.reorder([...selection], "front")],
                      ["上移一层", "]", true, () => store.reorder([...selection], "forward")],
                      ["下移一层", "[", true, () => store.reorder([...selection], "backward")],
                      ["置于底层", "Shift+[", true, () => store.reorder([...selection], "back")],
                    ],
                  },
                  {
                    sub: "对齐",
                    enabled: selection.length >= 2,
                    items: [
                      ["左对齐", "", true, () => alignSel("left")],
                      ["水平居中", "", true, () => alignSel("centerX")],
                      ["右对齐", "", true, () => alignSel("right")],
                      ["顶对齐", "", true, () => alignSel("top")],
                      ["垂直居中", "", true, () => alignSel("centerY")],
                      ["底对齐", "", true, () => alignSel("bottom")],
                      null,
                      ["水平等距", "", selection.length >= 3, () => distributeSel("x")],
                      ["垂直等距", "", selection.length >= 3, () => distributeSel("y")],
                    ],
                  },
                  null,
                  [`导出 PNG${selection.length ? "（选区）" : "（全部）"}`, "", store.shapes.length > 0, () => void exportPng()],
                  ...(onSaveAsCollection
                    ? [[
                        "存成合集回库", "",
                        store.shapes.some((s) => s.type === "image" && s.assetId != null),
                        () => {
                          const ids = [
                            ...new Set(
                              store.shapes
                                .filter((s): s is ImageShape => s.type === "image" && s.assetId != null)
                                .map((s) => s.assetId!)
                            ),
                          ];
                          onSaveAsCollection(ids);
                        },
                      ] as [string, string, boolean, () => void]]
                    : []),
                  [`对齐吸附${snapOn ? "（开）" : "（关）"}`, bindings["view.snap"], true, () => {
                    setSnapOn((v) => !v);
                    showToast(`对齐吸附 ${snapOn ? "已关闭" : "已开启"}`);
                  }],
                  ["全选", bindings["edit.selectAll"], store.shapes.length > 0, () => store.setSelection(store.shapes.filter((s) => !s.locked).map((s) => s.id))],
                  ["缩放至适合", bindings["view.zoomFit"], true, zoomToFit],
                ] as (
                  | [string, string, boolean, () => void]
                  | null
                  | { sub: string; enabled: boolean; items: ([string, string, boolean, () => void] | null)[] }
                )[]
              ).map((item, i) => {
                if (item === null) return <div key={i} className="bd-menu-sep" />;
                if (Array.isArray(item))
                  return (
                    <button
                      key={i}
                      className="bd-menu-item"
                      disabled={!item[2]}
                      onClick={() => {
                        setMenu(null);
                        item[3]();
                      }}
                    >
                      <span>{item[0]}</span>
                      <kbd>{item[1]}</kbd>
                    </button>
                  );
                // 二级飞出菜单（PS 风格）：悬停展开，方向由 .flip 决定
                return (
                  <div key={i} className={"bd-menu-item bd-sub" + (item.enabled ? "" : " sub-disabled")}>
                    <span>{item.sub}</span>
                    <kbd>▸</kbd>
                    {item.enabled && (
                      <div className="bd-submenu">
                        {item.items.map((s, j) =>
                          s === null ? (
                            <div key={j} className="bd-menu-sep" />
                          ) : (
                            <button
                              key={j}
                              className="bd-menu-item"
                              disabled={!s[2]}
                              onClick={() => {
                                setMenu(null);
                                s[3]();
                              }}
                            >
                              <span>{s[0]}</span>
                              <kbd>{s[1]}</kbd>
                            </button>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>,
          document.body
        )}

      {/* 画板切换器 */}
      <div className="bd-boards">
        <button
          className="bd-boards-cur"
          title="切换画板"
          onClick={() => {
            setBoardMenu((v) => !v);
            setConfirmDel(null);
            setRenaming(null);
          }}
        >
          {boards.find((b) => b.id === boardId)?.name ?? "画板"}
          <span className="bd-caret">▾</span>
        </button>
        {boardMenu && (
          <div className="bd-boards-pop">
            {boards.map((b) =>
              renaming?.id === b.id ? (
                <input
                  key={b.id}
                  className="bd-boards-input"
                  autoFocus
                  value={renaming.value}
                  onChange={(e) => setRenaming({ id: b.id, value: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Enter") {
                      const name = renaming.value.trim() || b.name;
                      setRenaming(null);
                      setBoards((bs) => bs.map((x) => (x.id === b.id ? { ...x, name } : x)));
                      renameBoard(b.id, name).catch(() => {});
                    }
                    if (e.key === "Escape") setRenaming(null);
                  }}
                  onBlur={() => setRenaming(null)}
                />
              ) : (
                <div key={b.id} className={`bd-boards-row ${b.id === boardId ? "on" : ""}`}>
                  <button className="bd-boards-name" onClick={() => switchBoard(b.id)}>
                    {b.name}
                  </button>
                  <button
                    className="bd-boards-act"
                    title="重命名"
                    onClick={() => setRenaming({ id: b.id, value: b.name })}
                  >
                    ✎
                  </button>
                  {boards.length > 1 && (
                    <button
                      className="bd-boards-act"
                      title={confirmDel === b.id ? "再点一次确认删除" : "删除画板"}
                      onClick={() => {
                        if (confirmDel !== b.id) {
                          setConfirmDel(b.id);
                          return;
                        }
                        setConfirmDel(null);
                        deleteBoard(b.id).catch(() => {});
                        localStorage.removeItem(docKey(b.id));
                        localStorage.removeItem(camKey(b.id));
                        const rest = boards.filter((x) => x.id !== b.id);
                        setBoards(rest);
                        if (b.id === boardIdRef.current && rest.length) switchBoard(rest[0].id);
                      }}
                    >
                      {confirmDel === b.id ? "❗" : "🗑"}
                    </button>
                  )}
                </div>
              )
            )}
            <button
              className="bd-boards-new"
              onClick={async () => {
                const name = `画板 ${boards.length + 1}`;
                try {
                  const id = await createBoard(name);
                  setBoards((bs) => [...bs, { id, name, updated_at: 0 }]);
                  switchBoard(id);
                } catch {
                  /* 浏览器环境无后端 */
                }
              }}
            >
              ＋ 新建画板
            </button>
          </div>
        )}
      </div>

      {/* 样式面板 */}
      {showStyles && (
        <div className="bd-styles">
          {showBrush && (
            <div className="bd-row">
              {(
                [
                  ["pen", "钢笔"],
                  ["marker", "马克"],
                  ["pencil", "铅笔"],
                ] as [BrushKey, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`bd-chip ${dispBrush === k ? "on" : ""}`}
                  onClick={() => applyStyle({ brush: k })}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="bd-swatches">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                className={`bd-swatch ${dispColor === c ? "on" : ""}`}
                style={{ background: c }}
                title={c}
                onClick={() => applyStyle({ color: c })}
              />
            ))}
            <label className="bd-swatch bd-swatch-custom" title="自定义颜色">
              <input
                type="color"
                value={colorHex(style.color)}
                onChange={(e) => setStyle((s) => ({ ...s, color: e.target.value }))}
                onBlur={(e) => applyStyle({ color: e.target.value })}
              />
            </label>
          </div>
          <div className="bd-row">
            {(["s", "m", "l", "xl"] as SizeKey[]).map((sz) => (
              <button
                key={sz}
                className={`bd-chip ${dispSize === sz ? "on" : ""}`}
                onClick={() => applyStyle({ size: sz })}
              >
                {sz.toUpperCase()}
              </button>
            ))}
          </div>
          {showTextStyle && (
            <div className="bd-row">
              {(
                [
                  ["bold", "B", "加粗 (Ctrl+B)"],
                  ["italic", "I", "斜体 (Ctrl+I)"],
                  ["underline", "U", "下划线 (Ctrl+U)"],
                ] as const
              ).map(([k, label, title]) => (
                <button
                  key={k}
                  className={`bd-chip ts-${k} ${dispTS(k) ? "on" : ""}`}
                  title={title}
                  onClick={() => toggleTextStyle(k)}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {showFill && (
            <div className="bd-row">
              {(
                [
                  ["none", "空心"],
                  ["semi", "半透"],
                  ["solid", "实心"],
                ] as [FillKey, string][]
              ).map(([f, label]) => (
                <button
                  key={f}
                  className={`bd-chip ${dispFill === f ? "on" : ""}`}
                  onClick={() => applyStyle({ fill: f })}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 工具栏 */}
      <div className="bd-toolbar">
        <button
          className="bd-tool"
          title={`撤销 (${bindings["edit.undo"]})`}
          disabled={!store.canUndo()}
          onClick={() => store.undo()}
        >
          <Icon {...ICONS.undo} />
        </button>
        <button
          className="bd-tool"
          title={`重做 (${bindings["edit.redo"]})`}
          disabled={!store.canRedo()}
          onClick={() => store.redo()}
        >
          <Icon {...ICONS.redo} />
        </button>
        <div className="bd-toolbar-sep" />
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={`bd-tool ${tool === t.id ? "active" : ""}`}
            title={`${t.title} (${bindings[`tool.${t.id}`] ?? t.key})`}
            onClick={() => setTool(t.id)}
          >
            <Icon {...ICONS[t.id]} />
          </button>
        ))}
      </div>

      {/* 右下角帮助按钮（tldraw 风格）：快捷键面板入口 */}
      <button
        className={`bd-help ${hotkeysOpen ? "active" : ""}`}
        title="快捷键（查看 / 自定义）"
        onClick={() => {
          setHotkeysOpen((v) => !v);
          setCapturing(null);
          setHkMsg(null);
        }}
      >
        ?
      </button>

      {/* 快捷键面板 */}
      {hotkeysOpen && (
        <div
          className="bd-hotkeys"
          tabIndex={0}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (!capturing) {
              if (e.key === "Escape") setHotkeysOpen(false);
              return;
            }
            e.preventDefault();
            if (e.key === "Escape") {
              setCapturing(null);
              return;
            }
            const combo = comboOf(e);
            if (!combo) return; // 纯修饰键，继续等
            const conflict = HOTKEYS.find(
              (h) => !h.fixed && h.id !== capturing && bindings[h.id] === combo
            );
            if (conflict) {
              setHkMsg(`「${combo}」已被「${conflict.label}」占用`);
              return;
            }
            saveBinding(capturing, combo);
            setBindings((b) => ({ ...b, [capturing]: combo }));
            setCapturing(null);
            setHkMsg(null);
          }}
        >
          <div className="bd-hotkeys-head">
            <span>快捷键</span>
            <button
              className="bd-chip"
              onClick={() => {
                resetBindings();
                setBindings(loadBindings());
                setCapturing(null);
                setHkMsg(null);
              }}
            >
              重置默认
            </button>
            <button className="bd-tool" title="关闭" onClick={() => setHotkeysOpen(false)}>
              ✕
            </button>
          </div>
          {hkMsg && <div className="bd-hotkeys-msg">{hkMsg}</div>}
          <div className="bd-hotkeys-list">
            {HOTKEYS.map((h) => (
              <div key={h.id} className="bd-hotkeys-row">
                <span>{h.label}</span>
                {h.fixed ? (
                  <span className="bd-hotkeys-fixed">{h.def}</span>
                ) : (
                  <button
                    className={`bd-hotkeys-key ${capturing === h.id ? "capturing" : ""}`}
                    onClick={(ev) => {
                      setCapturing(h.id);
                      setHkMsg(null);
                      (ev.currentTarget.closest(".bd-hotkeys") as HTMLElement | null)?.focus();
                    }}
                  >
                    {capturing === h.id ? "按下新组合键…" : bindings[h.id]}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 轻提示 */}
      {toast && <div className="bd-toast">{toast}</div>}

      {/* 缩放控件 */}
      <div className="bd-zoom">
        <button
          className="bd-tool"
          title="缩小 (Ctrl+-)"
          onClick={() => zoomAt({ x: size.w / 2, y: size.h / 2 }, cam.z / 1.25)}
        >
          −
        </button>
        <button
          className="bd-zoom-pct"
          title="重置为 100% (Shift+0)"
          onClick={() => zoomAt({ x: size.w / 2, y: size.h / 2 }, 1)}
        >
          {Math.round(cam.z * 100)}%
        </button>
        <button
          className="bd-tool"
          title="放大 (Ctrl+=)"
          onClick={() => zoomAt({ x: size.w / 2, y: size.h / 2 }, cam.z * 1.25)}
        >
          +
        </button>
        <button className="bd-tool" title="缩放至适合 (Shift+1)" onClick={zoomToFit}>
          <Icon {...ICONS.fit} />
        </button>
      </div>
    </div>
  );
}

export { Editor };
export type { BoardShape };
