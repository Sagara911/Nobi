// 快捷键注册表：默认绑定 + localStorage 覆盖，组合键序列化为 "Ctrl+Shift+Z" 形式。
// fixed 项只展示不可改（系统事件或修饰键行为，改了也拦不住浏览器）。

export interface HotkeyDef {
  id: string;
  label: string;
  def: string; // 默认组合键
  fixed?: boolean;
}

export const HOTKEYS: HotkeyDef[] = [
  { id: "tool.select", label: "选择工具", def: "V" },
  { id: "tool.hand", label: "抓手工具", def: "H" },
  { id: "tool.draw", label: "画笔", def: "D" },
  { id: "tool.eraser", label: "橡皮", def: "E" },
  { id: "tool.arrow", label: "箭头", def: "A" },
  { id: "tool.rect", label: "矩形", def: "R" },
  { id: "tool.ellipse", label: "椭圆", def: "O" },
  { id: "tool.text", label: "文本", def: "T" },
  { id: "edit.undo", label: "撤销", def: "Ctrl+Z" },
  { id: "edit.redo", label: "重做", def: "Ctrl+Shift+Z" },
  { id: "edit.delete", label: "删除", def: "Delete" },
  { id: "edit.selectAll", label: "全选", def: "Ctrl+A" },
  { id: "edit.duplicate", label: "创建副本", def: "Ctrl+D" },
  { id: "edit.copy", label: "复制", def: "Ctrl+C" },
  { id: "edit.cut", label: "剪切", def: "Ctrl+X" },
  { id: "edit.group", label: "组合", def: "Ctrl+G" },
  { id: "edit.ungroup", label: "取消组合", def: "Ctrl+Shift+G" },
  { id: "view.zoomIn", label: "放大", def: "Ctrl+=" },
  { id: "view.zoomOut", label: "缩小", def: "Ctrl+-" },
  { id: "view.zoom100", label: "缩放到 100%", def: "Shift+0" },
  { id: "view.zoomFit", label: "缩放至适合", def: "Shift+1" },
  { id: "view.snap", label: "对齐吸附开关", def: "Ctrl+R" },
  // —— 以下为固定行为，仅展示 ——
  { id: "fixed.paste", label: "粘贴（截图/图片/形状）", def: "Ctrl+V", fixed: true },
  { id: "fixed.pan", label: "平移画布", def: "右键拖动 / 空格 / 中键", fixed: true },
  { id: "fixed.wheel", label: "缩放画布", def: "滚轮", fixed: true },
  { id: "fixed.nudge", label: "微调位置", def: "方向键（Shift = 10px）", fixed: true },
  { id: "fixed.order", label: "层级上移 / 下移", def: "] / [（Shift = 顶/底）", fixed: true },
  { id: "fixed.clone", label: "拖拽出副本", def: "Alt + 拖动", fixed: true },
  { id: "fixed.shift", label: "反转等比 / 旋转 15° 吸附", def: "Shift（变换中）", fixed: true },
  { id: "fixed.textstyle", label: "文本加粗 / 斜体 / 下划线", def: "Ctrl+B / I / U", fixed: true },
  { id: "fixed.crop", label: "裁剪图片", def: "双击图片，Enter 提交 / Esc 取消", fixed: true },
  { id: "fixed.escape", label: "取消 / 清除选择", def: "Esc", fixed: true },
];

const STORE_KEY = "nobi-board-hotkeys-v1";

/** 当前绑定（默认值 + 用户覆盖） */
export function loadBindings(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of HOTKEYS) out[h.id] = h.def;
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    for (const [id, combo] of Object.entries(saved)) {
      if (typeof combo === "string" && HOTKEYS.some((h) => h.id === id && !h.fixed)) {
        out[id] = combo;
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function saveBinding(id: string, combo: string) {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    saved[id] = combo;
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  } catch {
    /* ignore */
  }
}

export function resetBindings() {
  localStorage.removeItem(STORE_KEY);
}

/** 键盘事件 → 组合键字符串（字母/数字用物理键位，Shift+数字不受符号干扰） */
export function comboOf(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; key: string; code: string }): string | null {
  let k: string;
  const c = e.code || "";
  if (/^Key[A-Z]$/.test(c)) k = c.slice(3);
  else if (/^Digit[0-9]$/.test(c)) k = c.slice(5);
  else {
    k = e.key;
    if (k === " ") k = "Space";
    if (["Control", "Shift", "Alt", "Meta"].includes(k)) return null; // 纯修饰键
    if (k.length === 1) k = k.toUpperCase();
  }
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(k);
  return parts.join("+");
}
