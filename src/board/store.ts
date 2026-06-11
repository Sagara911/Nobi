// 画板数据层：形状模型、选择、撤销重做、序列化，以及旧 tldraw 快照的一次性迁移。
// 持久化入口仍走 api.ts 的 saveBoard/loadBoard，本文件只关心内存模型与 JSON 格式。

// ---------- 样式常量（对齐 tldraw 暗色主题） ----------

export type SizeKey = "s" | "m" | "l" | "xl";
export type FillKey = "none" | "semi" | "solid";

export const PALETTE: Record<string, string> = {
  black: "#f2f2f2", // 暗色主题下 tldraw 的 black 渲染为近白
  grey: "#9398b0",
  "light-violet": "#e599f7",
  violet: "#ae3ec9",
  blue: "#4f72fc",
  "light-blue": "#4dabf7",
  yellow: "#f1ac4b",
  orange: "#e16919",
  green: "#099268",
  "light-green": "#40c057",
  "light-red": "#ff8787",
  red: "#e03131",
};
export const COLOR_KEYS = Object.keys(PALETTE);
export const colorHex = (key: string) => PALETTE[key] ?? key;

export const STROKE_W: Record<SizeKey, number> = { s: 2.5, m: 3.5, l: 5, xl: 7.5 };
export const FONT_PX: Record<SizeKey, number> = { s: 18, m: 24, l: 36, xl: 44 };
export const FONT_FAMILY =
  "'Segoe UI', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif";

// ---------- 形状模型 ----------

interface ShapeBase {
  id: string;
  x: number;
  y: number;
  rotation: number; // 度
  opacity: number;
  groupId?: string; // 组合：同组共进退（Ctrl+G / Ctrl+Shift+G）
  locked?: boolean; // 锁定：不可点选/框选/擦除，菜单可解锁
}

export interface ImageShape extends ShapeBase {
  type: "image";
  w: number;
  h: number;
  src: string;
  name: string;
  /** 归一化裁剪框（0-1，相对原图），无裁剪为 undefined */
  crop?: { x: number; y: number; w: number; h: number };
}

/** 画笔款式（对标 Apple 照片标记工具）：钢笔=实心带笔锋，马克笔=宽扁半透明，铅笔=细线石墨颗粒 */
export type BrushKey = "pen" | "marker" | "pencil";

export interface DrawShape extends ShapeBase {
  type: "draw";
  points: number[]; // 局部坐标 [x0,y0,x1,y1,...]
  color: string;
  size: SizeKey;
  brush?: BrushKey; // 旧数据无此字段，默认钢笔
  pressures?: number[]; // 数位板真实笔压（每个点一个 0-1 值），鼠标绘制无此字段
}

export interface GeoShape extends ShapeBase {
  type: "geo";
  geo: "rectangle" | "ellipse";
  w: number;
  h: number;
  color: string;
  fill: FillKey;
  size: SizeKey;
}

export interface ArrowShape extends ShapeBase {
  type: "arrow";
  x2: number; // 终点（相对 x,y）
  y2: number;
  color: string;
  size: SizeKey;
}

export interface TextShape extends ShapeBase {
  type: "text";
  text: string;
  color: string;
  fontSize: number;
  w?: number; // 换行宽度，无则自适应
  align?: "left" | "center";
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export type BoardShape = ImageShape | DrawShape | GeoShape | ArrowShape | TextShape;

export interface BoardImage {
  id: number;
  path: string;
  name: string;
  width: number;
  height: number;
}

let idSeed = 0;
export const newId = () =>
  `s${(idSeed++).toString(36)}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

// ---------- 包围盒 ----------

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 形状未旋转时的局部尺寸 */
export function shapeSize(s: BoardShape): { w: number; h: number } {
  switch (s.type) {
    case "image":
    case "geo":
      return { w: s.w, h: s.h };
    case "draw": {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < s.points.length; i += 2) {
        minX = Math.min(minX, s.points[i]);
        maxX = Math.max(maxX, s.points[i]);
        minY = Math.min(minY, s.points[i + 1]);
        maxY = Math.max(maxY, s.points[i + 1]);
      }
      if (minX === Infinity) return { w: 0, h: 0 };
      return { w: maxX - minX, h: maxY - minY };
    }
    case "arrow":
      return { w: Math.abs(s.x2), h: Math.abs(s.y2) };
    case "text": {
      const lines = s.text.split("\n");
      const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
      return {
        w: s.w ?? Math.max(40, longest * s.fontSize * 0.62),
        h: Math.max(s.fontSize * 1.35, lines.length * s.fontSize * 1.35),
      };
    }
  }
}

/** 旋转后的页面坐标 AABB */
export function shapeBounds(s: BoardShape): Box {
  // draw/arrow 的局部原点不一定是左上角，先取局部 bbox 起点
  let lx = 0, ly = 0;
  if (s.type === "draw") {
    let minX = Infinity, minY = Infinity;
    for (let i = 0; i < s.points.length; i += 2) {
      minX = Math.min(minX, s.points[i]);
      minY = Math.min(minY, s.points[i + 1]);
    }
    if (minX !== Infinity) { lx = minX; ly = minY; }
  } else if (s.type === "arrow") {
    lx = Math.min(0, s.x2);
    ly = Math.min(0, s.y2);
  }
  const { w, h } = shapeSize(s);
  const rad = ((s.rotation || 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const pts = [
    [lx, ly], [lx + w, ly], [lx, ly + h], [lx + w, ly + h],
  ].map(([px, py]) => [s.x + px * cos - py * sin, s.y + px * sin + py * cos]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return { x: minX, y: minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY };
}

export function unionBounds(shapes: BoardShape[]): Box | null {
  if (!shapes.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    const b = shapeBounds(s);
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export const boxesIntersect = (a: Box, b: Box) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

// ---------- Store：文档 + 选择 + 撤销重做 ----------

interface HistoryEntry {
  before: { shapes: BoardShape[]; selection: string[] };
  after: { shapes: BoardShape[]; selection: string[] };
}

export class BoardStore {
  shapes: BoardShape[] = [];
  selection: string[] = [];
  version = 0;

  private listeners = new Set<() => void>();
  private docListeners = new Set<() => void>();
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  /** 仅文档提交（用于持久化），拖动过程中的实时变更不触发 */
  onDocChange = (fn: () => void) => {
    this.docListeners.add(fn);
    return () => void this.docListeners.delete(fn);
  };
  private emit() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }
  private emitDoc() {
    this.docListeners.forEach((fn) => fn());
  }

  getShape(id: string) {
    return this.shapes.find((s) => s.id === id);
  }
  isSelected(id: string) {
    return this.selection.includes(id);
  }
  selectedShapes() {
    return this.shapes.filter((s) => this.selection.includes(s.id));
  }

  setSelection(ids: string[]) {
    this.selection = ids;
    this.emit();
  }

  /** 交互开始前取文档快照，配合 commit() 形成一条撤销记录 */
  checkpoint() {
    return { shapes: clone(this.shapes), selection: [...this.selection] };
  }

  /** 实时变更（拖动中）：改完即重绘，不入历史不触发持久化 */
  applyLive(fn: () => void) {
    fn();
    this.emit();
  }

  /** 提交：与 checkpoint 配对，写入撤销栈并触发持久化 */
  commit(before: { shapes: BoardShape[]; selection: string[] }) {
    const after = { shapes: clone(this.shapes), selection: [...this.selection] };
    if (JSON.stringify(before.shapes) === JSON.stringify(after.shapes)) return;
    this.undoStack.push({ before, after });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
    this.emit();
    this.emitDoc();
  }

  /** 单步修改（创建/删除/属性变更）的快捷方式 */
  mutate(fn: () => void) {
    const before = this.checkpoint();
    fn();
    this.commit(before);
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push(e);
    this.shapes = clone(e.before.shapes);
    this.selection = e.before.selection.filter((id) => this.getShape(id));
    this.emit();
    this.emitDoc();
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push(e);
    this.shapes = clone(e.after.shapes);
    this.selection = e.after.selection.filter((id) => this.getShape(id));
    this.emit();
    this.emitDoc();
  }

  createShapes(list: BoardShape[], select = true) {
    if (!list.length) return;
    this.mutate(() => {
      this.shapes.push(...list);
      if (select) this.selection = list.map((s) => s.id);
    });
  }

  deleteShapes(ids: string[]) {
    if (!ids.length) return;
    this.mutate(() => {
      this.shapes = this.shapes.filter((s) => !ids.includes(s.id));
      this.selection = this.selection.filter((id) => !ids.includes(id));
    });
  }

  duplicate(ids: string[], dx = 16, dy = 16): BoardShape[] {
    const src = this.shapes.filter((s) => ids.includes(s.id));
    const copies = src.map((s) => ({ ...clone(s), id: newId(), x: s.x + dx, y: s.y + dy }));
    this.createShapes(copies);
    return copies;
  }

  reorder(ids: string[], dir: "front" | "back" | "forward" | "backward") {
    if (!ids.length) return;
    this.mutate(() => {
      const moving = this.shapes.filter((s) => ids.includes(s.id));
      const rest = this.shapes.filter((s) => !ids.includes(s.id));
      if (dir === "front") this.shapes = [...rest, ...moving];
      else if (dir === "back") this.shapes = [...moving, ...rest];
      else {
        // 上移/下移一层：以选中形状在原数组中的极值位置为基准挪一格
        const idxs = moving.map((m) => this.shapes.indexOf(m));
        const target =
          dir === "forward"
            ? Math.min(this.shapes.length - moving.length, Math.max(...idxs) - moving.length + 2)
            : Math.max(0, Math.min(...idxs) - 1);
        rest.splice(target, 0, ...moving);
        this.shapes = rest;
      }
    });
  }

  /** 替换整个文档（加载/迁移时用），不入历史 */
  replaceDoc(shapes: BoardShape[]) {
    this.shapes = shapes;
    this.selection = [];
    this.undoStack = [];
    this.redoStack = [];
    this.emit();
  }
}

// ---------- 序列化 ----------

export function serializeDoc(store: BoardStore): string {
  return JSON.stringify({ version: 1, shapes: store.shapes });
}

export interface ParsedDoc {
  shapes: BoardShape[];
  migratedFromTldraw: boolean;
}

/** 解析持久化 JSON：兼容自家 v1 格式与旧 tldraw 快照（自动迁移） */
export function parseDoc(json: string): ParsedDoc | null {
  let data: any;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (data && data.version === 1 && Array.isArray(data.shapes)) {
    return { shapes: data.shapes as BoardShape[], migratedFromTldraw: false };
  }
  const records = data?.document?.store ?? data?.store;
  if (records && typeof records === "object") {
    return { shapes: migrateTldraw(records), migratedFromTldraw: true };
  }
  return null;
}

// ---------- tldraw 快照迁移 ----------

/** 抽取 TipTap 富文本中的纯文本 */
function richToText(rt: any): string {
  if (!rt) return "";
  if (typeof rt === "string") return rt;
  const paras: string[] = [];
  const walkInline = (n: any): string => {
    if (!n) return "";
    if (n.type === "text" && typeof n.text === "string") return n.text;
    if (Array.isArray(n.content)) return n.content.map(walkInline).join("");
    return "";
  };
  const walkBlock = (n: any) => {
    if (!n) return;
    if (Array.isArray(n.content) && n.type === "doc") n.content.forEach(walkBlock);
    else paras.push(walkInline(n));
  };
  walkBlock(rt);
  return paras.join("\n");
}

const SIZE_KEYS: SizeKey[] = ["s", "m", "l", "xl"];
const asSize = (v: any): SizeKey => (SIZE_KEYS.includes(v) ? v : "m");
const asColor = (v: any): string => (typeof v === "string" && PALETTE[v] ? v : "black");
const deg = (rad: number) => ((rad || 0) * 180) / Math.PI;

function migrateTldraw(records: Record<string, any>): BoardShape[] {
  const recs = Object.values(records).filter((r) => r && typeof r === "object");
  const assets = new Map<string, any>(
    recs.filter((r) => r.typeName === "asset").map((r) => [r.id, r])
  );
  const shapeRecs = recs.filter((r) => r.typeName === "shape");
  const pages = recs
    .filter((r) => r.typeName === "page")
    .sort((a, b) => (a.index < b.index ? -1 : 1));

  // 箭头绑定（v2+ 为独立 binding 记录）
  const arrowBindings = new Map<string, { start?: any; end?: any }>();
  for (const r of recs) {
    if (r.typeName !== "binding" || r.type !== "arrow") continue;
    const slot = arrowBindings.get(r.fromId) ?? {};
    if (r.props?.terminal === "start") slot.start = r;
    else slot.end = r;
    arrowBindings.set(r.fromId, slot);
  }

  // 父子层级（group/frame 的子形状坐标是相对的）→ 深度优先展开成页面坐标
  const byParent = new Map<string, any[]>();
  for (const s of shapeRecs) {
    const list = byParent.get(s.parentId) ?? [];
    list.push(s);
    byParent.set(s.parentId, list);
  }
  byParent.forEach((l) => l.sort((a, b) => (a.index < b.index ? -1 : 1)));

  interface Placed {
    rec: any;
    px: number;
    py: number;
    prot: number; // 弧度
  }
  const ordered: Placed[] = [];
  const placedById = new Map<string, Placed>();
  const walk = (parentId: string, ox: number, oy: number, orot: number) => {
    for (const s of byParent.get(parentId) ?? []) {
      const cos = Math.cos(orot), sin = Math.sin(orot);
      const px = ox + (s.x || 0) * cos - (s.y || 0) * sin;
      const py = oy + (s.x || 0) * sin + (s.y || 0) * cos;
      const prot = orot + (s.rotation || 0);
      const p = { rec: s, px, py, prot };
      ordered.push(p);
      placedById.set(s.id, p);
      walk(s.id, px, py, prot);
    }
  };
  for (const page of pages) walk(page.id, 0, 0, 0);
  // 兜底：父级丢失的孤儿形状直接按自身坐标放置
  for (const s of shapeRecs) {
    if (!placedById.has(s.id) && !byParent.has(s.id)) {
      const p = { rec: s, px: s.x || 0, py: s.y || 0, prot: s.rotation || 0 };
      ordered.push(p);
      placedById.set(s.id, p);
    }
  }

  /** 绑定终点 → 页面坐标（取被绑形状包围盒上的归一化锚点，忽略其旋转的近似） */
  const bindingPoint = (b: any): { x: number; y: number } | null => {
    const target = placedById.get(b.toId);
    if (!target) return null;
    const a = b.props?.normalizedAnchor ?? { x: 0.5, y: 0.5 };
    const w = target.rec.props?.w ?? 0;
    const h = target.rec.props?.h ?? 0;
    const cos = Math.cos(target.prot), sin = Math.sin(target.prot);
    const lx = a.x * w, ly = a.y * h;
    return { x: target.px + lx * cos - ly * sin, y: target.py + lx * sin + ly * cos };
  };

  const out: BoardShape[] = [];
  for (const { rec, px, py, prot } of ordered) {
    const p = rec.props ?? {};
    const opacity = typeof rec.opacity === "number" ? rec.opacity : 1;
    const base = { id: newId(), x: px, y: py, rotation: deg(prot), opacity };
    switch (rec.type) {
      case "image": {
        const asset = assets.get(p.assetId);
        const src = asset?.props?.src;
        if (!src) break;
        let crop: ImageShape["crop"];
        if (p.crop?.topLeft && p.crop?.bottomRight) {
          crop = {
            x: p.crop.topLeft.x,
            y: p.crop.topLeft.y,
            w: p.crop.bottomRight.x - p.crop.topLeft.x,
            h: p.crop.bottomRight.y - p.crop.topLeft.y,
          };
        }
        out.push({
          ...base, type: "image", w: p.w ?? 100, h: p.h ?? 100,
          src, name: asset?.props?.name ?? "图片", crop,
        });
        break;
      }
      case "draw":
      case "highlight": {
        const scale = p.scale ?? 1;
        const points: number[] = [];
        for (const seg of p.segments ?? []) {
          for (const pt of seg.points ?? []) points.push(pt.x * scale, pt.y * scale);
        }
        if (points.length < 2) break;
        out.push({
          ...base, type: "draw", points,
          color: asColor(p.color),
          size: asSize(p.size),
          brush: rec.type === "highlight" ? "marker" : "pen", // tldraw 荧光笔 → 马克笔
        });
        break;
      }
      case "geo": {
        const geo = p.geo === "ellipse" || p.geo === "oval" ? "ellipse" : "rectangle";
        const scale = p.scale ?? 1;
        out.push({
          ...base, type: "geo", geo,
          w: (p.w ?? 100) * scale, h: (p.h ?? 100) * scale,
          color: asColor(p.color),
          fill: p.fill === "solid" || p.fill === "fill" ? "solid" : p.fill === "none" ? "none" : p.fill === "semi" ? "semi" : "none",
          size: asSize(p.size),
        });
        const label = richToText(p.richText) || p.text || "";
        if (label.trim()) {
          out.push({
            id: newId(), type: "text", x: px, y: py + ((p.h ?? 100) * scale) / 2 - FONT_PX[asSize(p.size)] * 0.7,
            rotation: deg(prot), opacity,
            text: label, color: asColor(p.color), fontSize: FONT_PX[asSize(p.size)],
            w: (p.w ?? 100) * scale, align: "center",
          });
        }
        break;
      }
      case "frame": {
        out.push({
          ...base, type: "geo", geo: "rectangle",
          w: p.w ?? 100, h: p.h ?? 100, color: "grey", fill: "none", size: "s",
        });
        break;
      }
      case "note": {
        const scale = p.scale ?? 1;
        out.push({
          ...base, type: "geo", geo: "rectangle",
          w: 200 * scale, h: 200 * scale,
          color: asColor(p.color), fill: "solid", size: "m",
        });
        const label = richToText(p.richText) || p.text || "";
        if (label.trim()) {
          out.push({
            id: newId(), type: "text", x: px + 16 * scale, y: py + 16 * scale,
            rotation: deg(prot), opacity,
            text: label, color: "black", fontSize: FONT_PX[asSize(p.size)],
            w: 168 * scale,
          });
        }
        break;
      }
      case "text": {
        const text = richToText(p.richText) || p.text || "";
        if (!text.trim()) break;
        out.push({
          ...base, type: "text", text,
          color: asColor(p.color),
          fontSize: FONT_PX[asSize(p.size)] * (p.scale ?? 1),
          w: p.autoSize === false ? p.w : undefined,
        });
        break;
      }
      case "arrow": {
        const binds = arrowBindings.get(rec.id) ?? {};
        const cos = Math.cos(prot), sin = Math.sin(prot);
        const local = (pt: any) => ({
          x: px + (pt?.x ?? 0) * cos - (pt?.y ?? 0) * sin,
          y: py + (pt?.x ?? 0) * sin + (pt?.y ?? 0) * cos,
        });
        const start = (binds.start && bindingPoint(binds.start)) || local(p.start);
        const end = (binds.end && bindingPoint(binds.end)) || local(p.end);
        out.push({
          id: base.id, opacity, rotation: 0, type: "arrow",
          x: start.x, y: start.y, x2: end.x - start.x, y2: end.y - start.y,
          color: asColor(p.color), size: asSize(p.size),
        });
        break;
      }
      default:
        break; // group/embed/bookmark/video 等：组本身不可见，其余暂不迁移
    }
  }
  return out;
}

// ---------- Editor：组件外可调用的薄封装 ----------

interface ViewportApi {
  zoomToFit(): void;
}

export class Editor {
  store = new BoardStore();
  private viewport: ViewportApi | null = null;

  registerViewport(v: ViewportApi) {
    this.viewport = v;
  }
  zoomToFit() {
    this.viewport?.zoomToFit();
  }

  /** 把一批图按网格摊到画布上（与旧版 addImages 行为一致，新图摆在已有内容下方） */
  addImages(images: BoardImage[]) {
    if (!images.length) return;
    const MAX = 320;
    const perRow = 4;
    const gap = 28;
    const existing = unionBounds(this.store.shapes);
    let x = existing ? existing.x : 0;
    let y = existing ? existing.y + existing.h + gap * 2 : 0;
    const x0 = x;
    let col = 0;
    let rowH = 0;
    const created: BoardShape[] = [];
    for (const img of images) {
      const ratio = img.width && img.height ? img.height / img.width : 1;
      const w = MAX;
      const h = Math.max(40, Math.round(MAX * ratio));
      created.push({
        id: newId(), type: "image", x, y, rotation: 0, opacity: 1,
        w, h, src: imageSrc(img.path), name: img.name,
      });
      col++;
      rowH = Math.max(rowH, h);
      x += w + gap;
      if (col >= perRow) {
        col = 0;
        x = x0;
        y += rowH + gap;
        rowH = 0;
      }
    }
    this.store.createShapes(created);
    this.zoomToFit();
  }
}

// convertFileSrc 由调用方注入，避免本文件依赖 tauri（便于将来单测）
let imageSrc: (path: string) => string = (p) => p;
export function setImageSrcResolver(fn: (path: string) => string) {
  imageSrc = fn;
}
