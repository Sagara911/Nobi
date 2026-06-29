// 桌宠助手窗（#pet 路由）：常驻桌面的置顶小浮窗，你说人话 → 转给 codex/claude CLI 干活。
// 壳子很薄：起子进程、流式回显都在 Rust(agent.rs)，这里只管 UI + 设置。
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getCurrentWindow,
  availableMonitors,
  primaryMonitor,
  LogicalSize,
  PhysicalPosition,
  PhysicalSize,
} from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import "./PetWindow.css";

// step = 过程类（命令/改文件/token/codex 日志），默认折叠隐藏
// via 标记这条属于哪条路：cli=派给 codex 干活 / chat=API 聊天（决定是否进聊天记忆 + 气泡标记）
// streaming=该助手气泡还在流式追加中
type Line = {
  role: "user" | "out" | "step" | "err" | "sys";
  text: string;
  via?: "cli" | "chat";
  streaming?: boolean;
  imgs?: string[]; // 用户这条带的图片（data URL），看图说话用
  docs?: string[]; // 用户这条带的文件名（看文件用）
};
const PREFS = "nobi-pet-settings-v1";
const CHAT_PREFS = "nobi-winky-chat-v1"; // 聊天 API 配置（Base URL / Key / 模型）
const POS_KEY = "nobi-winky-pos-v1"; // 记住手动摆放的图标位置（物理坐标）
const ICON = 60; // 折叠态小图标默认边长（逻辑像素），与 open_pet_window 的 inner_size 一致
const SIZE_PREFS = "nobi-winky-size-v1"; // 折叠图标大小（可调）
function loadPetSize(): number {
  const n = Number(localStorage.getItem(SIZE_PREFS));
  return n >= 44 && n <= 200 ? n : ICON;
}
const SPEED_PREFS = "nobi-winky-fps-v1"; // 动画帧速（fps，可调）
function loadFps(): number {
  const n = Number(localStorage.getItem(SPEED_PREFS));
  return n >= 2 && n <= 30 ? n : 6;
}
// 有的宠物作者把"向左/向右跑"两行画反了 → 按宠物 id 记一个"镜像左右"开关
const FLIP_PREFS = "nobi-winky-flip-v1";
function loadFlips(): Record<string, boolean> {
  try {
    const o = JSON.parse(localStorage.getItem(FLIP_PREFS) || "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function savePos(x: number, y: number) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify({ x, y }));
  } catch {
    /* ignore */
  }
}
function loadPos(): { x: number; y: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(POS_KEY) || "null");
    return v && typeof v.x === "number" && typeof v.y === "number" ? v : null;
  } catch {
    return null;
  }
}
// 按坐标找包含该点的显示器（避开"当前窗口所在屏"在接缝处的歧义）；找不到回退主屏
async function monitorForPoint(px: number, py: number) {
  try {
    const all = await availableMonitors();
    const hit = all.find(
      (m) =>
        px >= m.position.x &&
        px < m.position.x + m.size.width &&
        py >= m.position.y &&
        py < m.position.y + m.size.height,
    );
    if (hit) return hit;
  } catch {
    /* ignore */
  }
  return (await primaryMonitor()) ?? null;
}
const SANDBOX_LABEL: Record<string, string> = {
  "read-only": "只读（安全）",
  "workspace-write": "工作区可写",
  full: "完全放手（危险）",
};

function loadPrefs(): api.AgentOpts {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || "{}");
    return {
      agent: p.agent || "codex",
      bin: p.bin || "",
      cwd: p.cwd || "",
      sandbox: p.sandbox || "read-only",
      prompt: "",
    };
  } catch {
    return { agent: "codex", bin: "", cwd: "", sandbox: "read-only", prompt: "" };
  }
}

// 技能：有名字的能力 = 一段系统提示词 +（可选）顺带开的工具（联网/查库）。
// 可在设置里增删改；内置这几个当默认种子，builtin 仅用于"恢复默认"判断，删改不受限。
type Skill = { id: string; name: string; prompt: string; web?: boolean; lib?: boolean; builtin?: boolean };
const BUILTIN_SKILLS: Skill[] = [
  { id: "assistant", name: "助手", builtin: true, prompt: "你是 Winky，住在桌面角落的小助手。回答简洁、友好，默认用中文。" },
  { id: "translate", name: "翻译", builtin: true, prompt: "你是翻译助手。中文内容翻成地道英文，其他语言一律翻成中文。只输出译文，不解释、不加引号。" },
  { id: "polish", name: "润色", builtin: true, prompt: "你是中文润色助手。把用户给的文字改写得更通顺、专业、自然，保持原意和篇幅。只输出润色后的文字。" },
  { id: "naming", name: "起名", builtin: true, prompt: "你是命名助手。根据用户的描述，给出 5 个简洁好记的候选名字，每个名字后附一句话理由。" },
  { id: "code", name: "写码", builtin: true, prompt: "你是编程助手。给出可直接运行的代码 + 简短说明；中文解释，代码注释精炼。" },
  { id: "research", name: "查资料", builtin: true, web: true, prompt: "你是研究助手。优先依据联网搜到的资料回答，给出要点和依据；资料不足就说明。" },
  { id: "asset", name: "找素材", builtin: true, lib: true, prompt: "你帮我在 Nobi 素材库里找东西：根据匹配到的素材列表，告诉我有哪些、并简要描述。" },
];

// 一套 API 配置（OpenAI 兼容）。可存多套、随时在设置里切换。
type ApiProfile = { id: string; name: string; baseUrl: string; apiKey: string; model: string };
type ChatCfg = { profiles: ApiProfile[]; activeId: string; skills: Skill[]; activeSkillId: string };
const CHAT_PRESETS: { label: string; baseUrl: string }[] = [
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { label: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com" },
  { label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { label: "月之暗面 Kimi", baseUrl: "https://api.moonshot.cn/v1" },
  { label: "通义千问（阿里）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
];
function newId(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  } catch {
    /* ignore */
  }
  return "p" + Math.random().toString(36).slice(2, 9);
}
function blankProfile(name = "新配置"): ApiProfile {
  return { id: newId(), name, baseUrl: "", apiKey: "", model: "" };
}
function loadSkills(p: { skills?: Partial<Skill>[]; persona?: string }): { skills: Skill[]; activeSkillId: string } {
  // 已存过技能：用用户那份（含他的增删改）；没存过：种入内置默认
  const skills: Skill[] = Array.isArray(p.skills)
    ? p.skills.map((x) => ({
        id: x.id || newId(),
        name: x.name || "技能",
        prompt: x.prompt || "",
        web: !!x.web,
        lib: !!x.lib,
        builtin: !!x.builtin,
      }))
    : BUILTIN_SKILLS.map((s) => ({ ...s }));
  // 选中项：优先 activeSkillId，回退旧 persona（id 同名），再回退第一个
  const wantId = (p as { activeSkillId?: string }).activeSkillId || p.persona || skills[0]?.id;
  const activeSkillId = skills.some((s) => s.id === wantId) ? wantId : skills[0]?.id || "assistant";
  return { skills, activeSkillId };
}
function loadChatCfg(): ChatCfg {
  try {
    const p = JSON.parse(localStorage.getItem(CHAT_PREFS) || "{}");
    const { skills, activeSkillId } = loadSkills(p);
    // 新结构：多套配置
    if (Array.isArray(p.profiles) && p.profiles.length) {
      const profiles: ApiProfile[] = p.profiles.map((x: Partial<ApiProfile>) => ({
        id: x.id || newId(),
        name: x.name || "配置",
        baseUrl: x.baseUrl || "",
        apiKey: x.apiKey || "",
        model: x.model || "",
      }));
      const activeId = profiles.some((x) => x.id === p.activeId) ? p.activeId : profiles[0].id;
      return { profiles, activeId, skills, activeSkillId };
    }
    // 旧的单套配置 → 迁移成一套
    const first: ApiProfile = {
      id: newId(),
      name: "默认",
      baseUrl: p.baseUrl || "",
      apiKey: p.apiKey || "",
      model: p.model || "",
    };
    return { profiles: [first], activeId: first.id, skills, activeSkillId };
  } catch {
    const first = blankProfile("默认");
    return { profiles: [first], activeId: first.id, skills: BUILTIN_SKILLS.map((s) => ({ ...s })), activeSkillId: "assistant" };
  }
}

// 读一个图片 File 成 data URL（拖入/粘贴用）
function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });
}
// 读一个 File 成纯 base64（去掉 data:...;base64, 前缀），给 Rust 抽文件文字用
function fileToB64(f: File): Promise<string> {
  return fileToDataUrl(f).then((u) => u.slice(u.indexOf(",") + 1));
}
// 从用户粘进来的任意内容里提取宠物 slug：
//   "npx petdex@latest install anon" / "petdex install anon" → anon
//   "irm https://petdex.dev/install/anon?platform=win | iex" → anon
//   "anon" → anon
function extractSlug(raw: string): string {
  const s = raw.trim();
  const url = s.match(/install\/([a-z0-9_-]+)/i); // URL 形式 .../install/<slug>
  if (url) return url[1];
  const cmd = s.match(/\binstall\s+([a-z0-9_-]+)/i); // 命令形式 ... install <slug>
  if (cmd) return cmd[1];
  const tokens = s.split(/[\s/?&=|]+/).filter(Boolean);
  const last = tokens[tokens.length - 1];
  return last && /^[a-z0-9_-]+$/i.test(last) ? last : s;
}

export type WinkyPhase = "idle" | "waiting" | "running" | "done";
// Winky logo：参考图的样式(粗描边/那个 `>` 形/黄方块) + 终端提示符表情
// 空闲 `>_`(光标闪) / 等待 `>_•` / 执行中 `>_…`(呼吸) / 完成 `>_✓`
function WinkyLogo({ className, phase = "idle" }: { className?: string; phase?: WinkyPhase }) {
  return (
    <svg className={className} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <rect x="14" y="14" width="72" height="72" rx="20" fill="#F5A623" />
      <g fill="none" stroke="#2b2b2b" strokeWidth="5.75" strokeLinecap="round" strokeLinejoin="round">
        {/* > 左眼 */}
        <polyline points="26,43 36,51 26,59" />
        {/* _ 嘴 */}
        <line className={phase === "idle" ? "winky-cursor" : undefined} x1="42" y1="72.5" x2="60" y2="72.5" />
      </g>
      {/* 状态符号当"右眼"位（中心 69.5, 50） */}
      {phase === "waiting" && <circle cx="69.5" cy="50" r="5" fill="#2b2b2b" />}
      {phase === "running" && (
        <g className="winky-dots" fill="#2b2b2b">
          <circle cx="60.5" cy="50" r="3.5" />
          <circle cx="69.5" cy="50" r="3.5" />
          <circle cx="78.5" cy="50" r="3.5" />
        </g>
      )}
      {phase === "done" && (
        <polyline
          points="61.5,50 67.5,58 79.1,44.4"
          fill="none"
          stroke="#2b2b2b"
          strokeWidth="5.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

// 复制按钮：点一下复制文本，短暂显 ✓
function CopyBtn({ text, className }: { text: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className={className}
      title="复制"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          })
          .catch(() => {});
      }}
    >
      {done ? "✓" : "📋"}
    </button>
  );
}

// 行内 Markdown：`代码` 与 **粗体**
function renderInline(s: string, keyBase: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) nodes.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={`${keyBase}-${i}`} className="pet-md-code">{tok.slice(1, -1)}</code>);
    else nodes.push(<strong key={`${keyBase}-${i}`}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
    i++;
  }
  if (last < s.length) nodes.push(s.slice(last));
  return nodes;
}

// 轻量 Markdown 渲染（助手回复用）：``` 代码块(带复制) + 行内 code/粗体；其余靠 pre-wrap 保留换行。
function MarkdownText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const fence = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = fence.exec(text))) {
    if (m.index > last)
      parts.push(<span key={`t${i}`} className="pet-md-text">{renderInline(text.slice(last, m.index), `t${i}`)}</span>);
    const code = m[2].replace(/\n$/, "");
    parts.push(
      <div key={`c${i}`} className="pet-md-pre">
        <CopyBtn text={code} className="pet-md-copy" />
        <pre>
          <code>{code}</code>
        </pre>
      </div>,
    );
    last = m.index + m[0].length;
    i++;
  }
  if (last < text.length)
    parts.push(<span key={`t${i}`} className="pet-md-text">{renderInline(text.slice(last), `t${i}`)}</span>);
  return <>{parts}</>;
}

// ===== 皮肤（Petdex 宠物精灵）=====
const SKIN_PREFS = "nobi-winky-skin-v1";
type SkinSel = { kind: "default" | "preset" | "custom"; id: string; dir?: string };
function loadSkin(): SkinSel {
  try {
    const s = JSON.parse(localStorage.getItem(SKIN_PREFS) || "null");
    if (s && (s.kind === "default" || s.kind === "preset" || s.kind === "custom")) return s;
  } catch {
    /* ignore */
  }
  return { kind: "default", id: "" };
}
// 内置预设宠物（打包在 public/pets/，前端直接用 URL，不经 Rust）
const PRESET_PETS: { id: string; name: string; url: string }[] = [
  { id: "paperclip", name: "回形针", url: "pets/paperclip/spritesheet.webp" },
  { id: "bolt-2", name: "Bolt", url: "pets/bolt-2/spritesheet.webp" },
  { id: "white-zuccitchi", name: "White Zuccitchi", url: "pets/white-zuccitchi/spritesheet.webp" },
  { id: "code-default", name: "Code", url: "pets/code-default/spritesheet.png" },
];
// Petdex spritesheet 约定：8 列 × 9 行，每帧 192×208；行=动画状态（clawdex 权威映射）
const SHEET_COLS = 8;
const SHEET_ROWS = 9;
const FRAME_W = 192;
const FRAME_H = 208;
type SpriteState = WinkyPhase | "walk-left" | "walk-right" | "jumping" | "failed" | "review";
const PHASE_ROW: Record<SpriteState, { row: number; frames: number }> = {
  idle: { row: 0, frames: 6 }, // idle
  "walk-right": { row: 1, frames: 8 }, // running-right（向右走）
  "walk-left": { row: 2, frames: 8 }, // running-left（向左走）
  done: { row: 3, frames: 4 }, // waving（挥手庆祝）
  jumping: { row: 4, frames: 5 }, // jumping（蹦）
  failed: { row: 5, frames: 8 }, // failed（出错/沮丧）
  waiting: { row: 6, frames: 6 }, // waiting
  running: { row: 7, frames: 6 }, // running
  review: { row: 8, frames: 6 }, // review（审阅）
};
// 待机时随机穿插的小动作（让桌面那只活起来）；failed 留给真出错时用
const FIDGETS: SpriteState[] = ["jumping", "done", "review"];
const DEFAULT_FRAME_MS = 180; // 每帧默认时长（ms）≈5.5fps，贴近 Petdex 官方节奏
// 精灵动画：按 phase 选行，在该行帧数内循环，JS 定时器逐帧切背景。frameMs 由速度设置传入
function PetSprite({
  url,
  phase,
  size,
  frameMs = DEFAULT_FRAME_MS,
}: {
  url: string;
  phase: SpriteState;
  size: number;
  frameMs?: number;
}) {
  const [col, setCol] = useState(0);
  const { row, frames } = PHASE_ROW[phase] || PHASE_ROW.idle;
  useEffect(() => {
    setCol(0);
    const t = setInterval(() => setCol((c) => (c + 1) % frames), frameMs);
    return () => clearInterval(t);
  }, [phase, frames, frameMs]);
  const f = size / FRAME_H; // 按高度把一帧适配进 size 方框
  const w = Math.round(FRAME_W * f);
  const h = Math.round(FRAME_H * f);
  return (
    <div
      className="pet-sprite"
      style={{
        width: w,
        height: h,
        backgroundImage: `url(${url})`,
        backgroundSize: `${SHEET_COLS * w}px ${SHEET_ROWS * h}px`,
        backgroundPosition: `-${col * w}px -${row * h}px`,
      }}
    />
  );
}

export default function PetWindow() {
  const [cfg, setCfg] = useState<api.AgentOpts>(loadPrefs);
  const [chatCfg, setChatCfg] = useState<ChatCfg>(loadChatCfg);
  const [showCfg, setShowCfg] = useState(false);
  const [cfgTab, setCfgTab] = useState<"api" | "skill" | "skin" | "work">("api"); // 设置分页
  const [collapsed, setCollapsed] = useState(true); // 默认折叠成小图标
  const [closing, setClosing] = useState(false); // 收起过渡中：聊天内容淡出，盖住"硬切成图标"
  const [origin, setOrigin] = useState("100% 0%"); // 展开动画的起点角（随图标位置动态定）
  const [autoshow, setAutoshow] = useState(false); // 开机自动出现
  const [input, setInput] = useState("");
  const [imgs, setImgs] = useState<string[]>([]); // 待发送的图片（data URL），看图说话
  const [docs, setDocs] = useState<{ name: string; text: string }[]>([]); // 待发送的文件（已抽好文字）
  const [dragOver, setDragOver] = useState(false); // 拖图悬停高亮
  const [web, setWeb] = useState(false); // 联网搜索开关：开了每次发送先搜一下再答
  const [lib, setLib] = useState(false); // 查素材库开关：开了每次发送先在 Nobi 库里搜一下
  const [skin, setSkin] = useState<SkinSel>(loadSkin); // 皮肤选择
  const [flips, setFlips] = useState<Record<string, boolean>>(loadFlips); // 各宠物"镜像左右"开关
  const [petSize, setPetSize] = useState<number>(loadPetSize); // 折叠图标大小（逻辑像素）
  const [fps, setFps] = useState<number>(loadFps); // 动画帧速
  const petSizeRef = useRef(petSize); // 给几何函数读当前值，避开闭包陈旧
  const [dragging, setDragging] = useState(false); // 拖动中（图标态切走路动作）
  const [dragDir, setDragDir] = useState<"left" | "right">("right"); // 拖动方向→朝向
  const lastXRef = useRef<number | null>(null); // 上一帧窗口 x，用来判方向
  const [fidget, setFidget] = useState<SpriteState | null>(null); // 待机随机小动作（一次性）
  const phaseRef = useRef<WinkyPhase>("idle"); // 给定时器读当前 phase/dragging，避开闭包陈旧
  const draggingRef = useRef(false);
  const [skinUrl, setSkinUrl] = useState(""); // 解析出的 spritesheet URL（空=用默认终端脸）
  const [customPets, setCustomPets] = useState<api.PetInfo[]>([]); // 用户自己装的宠物
  const [petSlug, setPetSlug] = useState(""); // 设置里直接装宠物：输入名字
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState("");
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<WinkyPhase>("idle"); // 表情：空闲/等待/执行中/完成
  const [log, setLog] = useState<Line[]>([]); // 内存态：折叠/展开期间在，关窗即清
  const [status, setStatus] = useState("检测中…");
  const logRef = useRef<HTMLDivElement | null>(null);
  const cfgRef = useRef<HTMLDivElement | null>(null);

  // 置顶/未聚焦窗里原生滚轮常失效（WebView2 老坑）——手动接管 wheel，hover 即可滚。
  // 设置面板（开了才有）+ 聊天记录区各接一份。
  useEffect(() => {
    const wire = (el: HTMLDivElement | null) => {
      if (!el) return () => {};
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        el.scrollTop += e.deltaY;
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      return () => el.removeEventListener("wheel", onWheel);
    };
    const off1 = wire(cfgRef.current);
    const off2 = wire(logRef.current);
    return () => {
      off1();
      off2();
    };
  }, [showCfg, collapsed]);

  const save = (next: Partial<api.AgentOpts>) => {
    setCfg((c) => {
      const merged = { ...c, ...next };
      localStorage.setItem(
        PREFS,
        JSON.stringify({ agent: merged.agent, bin: merged.bin, cwd: merged.cwd, sandbox: merged.sandbox }),
      );
      return merged;
    });
  };
  // 当前生效的那套 API 配置
  const active = chatCfg.profiles.find((p) => p.id === chatCfg.activeId) || chatCfg.profiles[0];
  const persistChat = (next: ChatCfg) => {
    localStorage.setItem(CHAT_PREFS, JSON.stringify(next));
    setChatCfg(next);
  };
  // 改当前这套的字段（地址/Key/模型/名字）
  const updateActive = (patch: Partial<ApiProfile>) =>
    persistChat({
      ...chatCfg,
      profiles: chatCfg.profiles.map((p) => (p.id === chatCfg.activeId ? { ...p, ...patch } : p)),
    });
  const switchProfile = (id: string) => persistChat({ ...chatCfg, activeId: id });
  // 当前技能
  const activeSkill = chatCfg.skills.find((s) => s.id === chatCfg.activeSkillId) || chatCfg.skills[0];
  // 切技能：换提示词 + 顺带把它绑定的工具开/关（用户之后仍可手动覆盖）
  const switchSkill = (id: string) => {
    persistChat({ ...chatCfg, activeSkillId: id });
    const s = chatCfg.skills.find((x) => x.id === id);
    if (s) {
      setWeb(!!s.web);
      setLib(!!s.lib);
    }
  };
  const updateSkill = (id: string, patch: Partial<Skill>) =>
    persistChat({ ...chatCfg, skills: chatCfg.skills.map((s) => (s.id === id ? { ...s, ...patch } : s)) });
  const addSkill = () => {
    const ns: Skill = { id: newId(), name: `技能 ${chatCfg.skills.length + 1}`, prompt: "" };
    persistChat({ ...chatCfg, skills: [...chatCfg.skills, ns], activeSkillId: ns.id });
  };
  const deleteSkill = (id: string) => {
    if (chatCfg.skills.length <= 1) return; // 至少留一个
    const skills = chatCfg.skills.filter((s) => s.id !== id);
    const activeSkillId = id === chatCfg.activeSkillId ? skills[0].id : chatCfg.activeSkillId;
    persistChat({ ...chatCfg, skills, activeSkillId });
  };
  const addProfile = () => {
    const np = blankProfile(`配置 ${chatCfg.profiles.length + 1}`);
    persistChat({ ...chatCfg, profiles: [...chatCfg.profiles, np], activeId: np.id });
  };
  const deleteActiveProfile = () => {
    if (chatCfg.profiles.length <= 1) return; // 至少留一套
    const profiles = chatCfg.profiles.filter((p) => p.id !== chatCfg.activeId);
    persistChat({ ...chatCfg, profiles, activeId: profiles[0].id });
  };

  // 开窗时让 🌐/📁 跟随当前技能的绑定
  useEffect(() => {
    setWeb(!!activeSkill.web);
    setLib(!!activeSkill.lib);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 解析皮肤 → spritesheet URL（预设直接用 URL；自定义经 Rust 读成 data URL；默认空=终端脸）
  useEffect(() => {
    let alive = true;
    if (skin.kind === "preset") {
      setSkinUrl(PRESET_PETS.find((p) => p.id === skin.id)?.url || "");
    } else if (skin.kind === "custom" && skin.dir) {
      api
        .winkyReadPetSheet(skin.dir)
        .then((u) => alive && setSkinUrl(u))
        .catch(() => alive && setSkinUrl(""));
    } else {
      setSkinUrl("");
    }
    return () => {
      alive = false;
    };
  }, [skin]);
  // 列出用户已装的宠物（皮肤选择器用）
  useEffect(() => {
    api.winkyListPets().then(setCustomPets).catch(() => {});
  }, []);
  const chooseSkin = (s: SkinSel) => {
    localStorage.setItem(SKIN_PREFS, JSON.stringify(s));
    setSkin(s);
  };
  // 当前宠物是否需要镜像左右
  const flipped = !!(skin.id && flips[skin.id]);
  const toggleFlip = () => {
    if (skin.kind === "default" || !skin.id) return;
    const next = { ...flips };
    if (next[skin.id]) delete next[skin.id];
    else next[skin.id] = true;
    localStorage.setItem(FLIP_PREFS, JSON.stringify(next));
    setFlips(next);
  };
  // 给 fidget 定时器读当前 phase/dragging（避开闭包陈旧）
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    draggingRef.current = dragging;
  }, [dragging]);
  // 待机随机小动作：折叠态 + 有皮肤时，每隔 8–18s 趁空闲随机蹦一下/挥手/审阅，播一轮回 idle
  useEffect(() => {
    if (!skinUrl || !collapsed) return;
    let t: ReturnType<typeof setTimeout>;
    let clr: ReturnType<typeof setTimeout>;
    const schedule = () => {
      t = setTimeout(
        () => {
          if (phaseRef.current === "idle" && !draggingRef.current) {
            const pick = FIDGETS[Math.floor(Math.random() * FIDGETS.length)];
            setFidget(pick);
            clr = setTimeout(() => setFidget(null), loopMs(pick)); // 播完一轮回 idle
          }
          schedule();
        },
        5000 + Math.random() * 3000, // 5–8s 一次
      );
    };
    schedule();
    return () => {
      clearTimeout(t);
      clearTimeout(clr);
      setFidget(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skinUrl, collapsed]);
  // 删除当前选中的自定义宠物（只能删自定义，预设/默认删不了）
  const deletePet = async () => {
    if (skin.kind !== "custom" || !skin.id) return;
    const id = skin.id;
    try {
      await api.winkyDeletePet(id);
      chooseSkin({ kind: "default", id: "" }); // 删完回默认终端脸
      setCustomPets(await api.winkyListPets());
      setInstallMsg(`已删除 ${id}`);
    } catch (e) {
      setInstallMsg(`✗ ${String(e)}`);
    }
  };
  // 在设置里直接装宠物：后台跑 npx petdex install，装完刷新并启用
  const installPet = async () => {
    const s = extractSlug(petSlug); // 整条命令/链接/名字都能解析出 slug
    if (!s || installing) return;
    setInstalling(true);
    setInstallMsg(`安装中 ${s}…（首次较慢，要联网下载）`);
    try {
      await api.winkyInstallPet(s);
      const pets = await api.winkyListPets();
      setCustomPets(pets);
      const pet = pets.find((p) => p.id === s);
      if (pet) chooseSkin({ kind: "custom", id: pet.id, dir: pet.dir });
      setInstallMsg(`✓ 已安装并启用 ${s}`);
      setPetSlug("");
    } catch (e) {
      setInstallMsg(`✗ ${String(e)}`);
    } finally {
      setInstalling(false);
    }
  };

  // 探测 CLI 是否就绪
  const check = (agent: string, bin: string) => {
    setStatus("检测中…");
    api
      .agentCheck(agent, bin)
      .then((v) => setStatus(`✓ ${agent} ${v}`))
      .catch((e) => setStatus(`✗ ${e}`));
  };
  useEffect(() => {
    check(cfg.agent, cfg.bin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.agent, cfg.bin]);

  // 流式输出
  useEffect(() => {
    const un1 = listen<{ stream: string; line: string }>("agent-output", (e) => {
      const { stream, line } = e.payload;
      setPhase((p) => (p === "waiting" ? "running" : p)); // 出第一条输出 → 执行中
      // stderr：codex 的人类日志，显暗灰（不是错误）
      if (stream === "err") {
        if (line.trim()) setLog((l) => [...l, { role: "step", text: line }]);
        return;
      }
      // stdout：codex --json 的 JSONL 事件，只挑有用的显示
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        if (line.trim()) setLog((l) => [...l, { role: "out", text: line }]);
        return;
      }
      const push = (role: Line["role"], text: string) =>
        text && setLog((l) => [...l, { role, text }]);
      if (ev.type === "item.completed" || ev.type === "item.started") {
        const it = ev.item || {};
        if (it.type === "agent_message" || it.type === "assistant_message") {
          if (ev.type === "item.completed") push("out", it.text || "");
        } else if (it.type === "command_execution") {
          if (ev.type === "item.started") push("step", "🛠 " + (it.command || it.cmd || "运行命令"));
        } else if (it.type === "file_change" || it.type === "patch") {
          push("step", "✏ 改动文件");
        } else if (it.type === "error") {
          push("err", it.message || JSON.stringify(it));
        }
      } else if (ev.type === "turn.completed") {
        const u = ev.usage || {};
        push("step", `· tokens 用量 in ${u.input_tokens ?? "?"} / out ${u.output_tokens ?? "?"}`);
      } else if (ev.type === "error") {
        push("err", ev.message || line);
      }
    });
    const un2 = listen<{ code: number | null }>("agent-done", (e) => {
      setRunning(false);
      const code = e.payload.code;
      if (code != null && code !== 0) {
        // 非零退出 = 失败 → 沮丧表情
        setPhase("idle");
        setFidget("failed");
        setTimeout(() => setFidget((f) => (f === "failed" ? null : f)), loopMs("failed"));
      } else {
        setPhase("done"); // 完成 → ✓，2.5s 后回空闲
        setTimeout(() => setPhase((p) => (p === "done" ? "idle" : p)), 2500);
      }
      setLog((l) => [...l, { role: "sys", text: `— 完成（退出码 ${code ?? "?"}）—` }]);
    });
    // 聊天流式 token：追加到最后一个「流式中的聊天助手气泡」，没有就新建
    const un3 = listen<{ text: string }>("chat-delta", (e) => {
      const t = e.payload.text;
      setPhase((p) => (p === "waiting" ? "running" : p)); // 首个 token → 执行中
      setLog((l) => {
        const last = l[l.length - 1];
        if (last && last.role === "out" && last.via === "chat" && last.streaming) {
          const copy = l.slice();
          copy[copy.length - 1] = { ...last, text: last.text + t };
          return copy;
        }
        return [...l, { role: "out", via: "chat", text: t, streaming: true }];
      });
    });
    return () => {
      un1.then((f) => f());
      un2.then((f) => f());
      un3.then((f) => f());
    };
  }, []);

  // 有新消息、或重新展开窗口时，都滚到最新（底部）。
  // rAF 等展开动画/布局落定后再滚，避免高度未定位导致停在旧消息上。
  useEffect(() => {
    requestAnimationFrame(() => {
      logRef.current?.scrollTo(0, logRef.current.scrollHeight);
    });
  }, [log, collapsed]);

  // 出错时让宠物做个"失败/沮丧"表情（failed 行），约 1.3s 后回归
  const flashFailed = () => {
    setFidget("failed");
    setTimeout(() => setFidget((f) => (f === "failed" ? null : f)), loopMs("failed"));
  };

  // 派活给 CLI（codex/claude）：以 / 开头时走这里
  const runTask = async (task: string) => {
    setLog((l) => [...l, { role: "user", text: task, via: "cli" }]);
    setInput("");
    setRunning(true);
    setPhase("waiting"); // 已发送、等首条输出
    try {
      await api.agentRun({ ...cfg, prompt: task });
    } catch (e) {
      setRunning(false);
      setPhase("idle");
      flashFailed();
      setLog((l) => [...l, { role: "err", text: String(e) }]);
    }
  };

  // 聊天（API）：默认这条；把聊天历史拼成 messages 多轮上下文一起发。images=本条带的图片
  // baseLog=拿哪份日志算历史（重新生成时传砍掉旧回复的版本，避免读到陈旧 state）
  const runChat = async (content: string, images: string[] = [], baseLog: Line[] = log) => {
    if (!active.apiKey.trim() || !active.baseUrl.trim()) {
      setShowCfg(true);
      setLog((l) => [...l, { role: "err", text: "先在 ⚙ 设置里填 API 地址、Key 和模型名" }]);
      return;
    }
    // 只把「聊天」往来收进记忆，/任务 的 CLI 输出不计入（历史只带文字，图片只随当前这条发）
    const history = baseLog
      .filter((l) => l.via === "chat" && (l.role === "user" || l.role === "out") && l.text.trim())
      .map((l) => ({ role: l.role === "user" ? ("user" as const) : ("assistant" as const), content: l.text }));
    // 先把用户这条放出来、清输入、进等待态（取资料可能要几秒）
    const attachedDocs = docs; // 本条带的文件（已抽好文字）
    setLog((l) => [
      ...l,
      {
        role: "user",
        text: content,
        via: "chat",
        imgs: images.length ? images : undefined,
        docs: attachedDocs.length ? attachedDocs.map((d) => d.name) : undefined,
      },
    ]);
    setInput("");
    setImgs([]);
    setDocs([]);
    setRunning(true);
    setPhase("waiting");

    // 取外部资料当「参考资料」：读链接（消息里的网址自动抓）+ 联网搜索（开了 🌐 才搜）
    const refs: string[] = [];
    const urls = (content.match(/https?:\/\/[^\s，。、）)】」"']+/g) || []).slice(0, 2);
    for (const u of urls) {
      setLog((l) => [...l, { role: "step", text: `📄 读取网页 ${u}` }]);
      try {
        refs.push(`【网页 ${u} 的内容】\n${await api.fetchUrlText(u)}`);
      } catch (e) {
        setLog((l) => [...l, { role: "step", text: `· 网页读取失败：${String(e)}` }]);
      }
    }
    if (web && content.trim()) {
      setLog((l) => [...l, { role: "step", text: `🔎 联网搜索：${content.trim()}` }]);
      try {
        const hits = await api.webSearch(content.trim());
        if (hits.length)
          refs.push(
            "【联网搜索结果】\n" + hits.map((h, i) => `${i + 1}. ${h.title}\n${h.snippet}`).join("\n\n"),
          );
      } catch (e) {
        setLog((l) => [...l, { role: "step", text: `· 搜索失败：${String(e)}` }]);
      }
    }
    if (lib && content.trim()) {
      setLog((l) => [...l, { role: "step", text: `📁 查素材库：${content.trim()}` }]);
      try {
        const hits = await api.winkySearchLibrary(content.trim());
        if (hits.length)
          refs.push(
            "【Nobi 素材库匹配到的素材】\n" +
              hits
                .map(
                  (h, i) =>
                    `${i + 1}. ${h.name}${h.tags.length ? `（标签：${h.tags.join("、")}）` : ""}${h.folder ? ` [${h.folder}]` : ""}`,
                )
                .join("\n"),
          );
        else setLog((l) => [...l, { role: "step", text: "· 库里没匹配到" }]);
      } catch (e) {
        setLog((l) => [...l, { role: "step", text: `· 查库失败：${String(e)}` }]);
      }
    }
    // 文件：带了文件就把抽好的文字塞进参考资料
    for (const d of attachedDocs) {
      refs.push(`【文件 ${d.name} 的内容】\n${d.text}`);
    }

    // 当前这条：带图→图文段数组（OpenAI vision）；纯文字→字符串
    const userContent: api.ChatMsg["content"] = images.length
      ? [
          ...(content ? [{ type: "text" as const, text: content }] : []),
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ]
      : content;
    const messages: api.ChatMsg[] = [
      { role: "system", content: activeSkill.prompt || "你是 Winky，一个有用的小助手。" },
      ...(refs.length
        ? [
            {
              role: "system" as const,
              content:
                "下面是供你参考的资料，请据此回答（与你已知冲突时以资料为准）：\n\n" + refs.join("\n\n---\n\n"),
            },
          ]
        : []),
      ...history,
      { role: "user", content: userContent },
    ];
    try {
      await api.chatSend({ baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model, messages });
      // 整段说完：定格流式气泡、回到完成态
      setLog((l) => {
        const last = l[l.length - 1];
        if (last && last.streaming) {
          const copy = l.slice();
          copy[copy.length - 1] = { ...last, streaming: false };
          return copy;
        }
        return l;
      });
      setRunning(false);
      setPhase("done");
      setTimeout(() => setPhase((p) => (p === "done" ? "idle" : p)), 2500);
    } catch (e) {
      setRunning(false);
      setPhase("idle");
      flashFailed();
      const msg = String(e);
      // 带图却报 image_url 不认 = 这个模型不支持视觉，给个明确提示
      const hint =
        images.length && /image_url|image|vision/i.test(msg)
          ? "\n\n（这个模型看不了图——换个视觉模型试试：gpt-4o / qwen-vl-max / glm-4v）"
          : "";
      setLog((l) => [...l, { role: "err", text: msg + hint }]);
    }
  };

  const sendText = async (raw: string) => {
    const text = raw.trim();
    if ((!text && imgs.length === 0 && docs.length === 0) || running) return;
    // 带了图片/文件 → 一定走聊天（看图/看文件），没文字给个默认问法
    if (imgs.length > 0 || docs.length > 0) {
      const fallback = imgs.length > 0 ? "看看这张图，描述一下" : "帮我看看这个文件";
      await runChat(text || fallback, imgs);
      return;
    }
    // 以 / 开头 → 派给 CLI 干活；// 转义成字面 /（当普通聊天）
    if (text.startsWith("/") && !text.startsWith("//")) {
      const task = text.slice(1).trim();
      if (!task) return; // 光一个斜杠：忽略
      await runTask(task);
    } else {
      await runChat(text.startsWith("//") ? text.slice(1) : text);
    }
  };

  // 重新生成：砍掉最后一条聊天回复（及其后内容），用同一句重问一次
  const regenerate = () => {
    if (running) return;
    let lastUser: Line | null = null;
    const trimmed = log.slice();
    for (let k = log.length - 1; k >= 0; k--) {
      if (log[k].role === "user" && log[k].via === "chat") {
        lastUser = log[k];
        trimmed.length = k; // 砍到这条 user 之前（runChat 会重新加这条 user）
        break;
      }
    }
    if (!lastUser) return;
    setLog(trimmed);
    void runChat(lastUser.text, lastUser.imgs || [], trimmed);
  };

  // 新对话：清空当前这段（内存态，关窗本就会清）
  const clearChat = () => {
    if (running) return;
    setLog([]);
    setPhase("idle");
  };

  // 收图：拖入 / 粘贴的图片 File → data URL 进待发送区
  const addImageFiles = async (files: File[]) => {
    const imgFiles = files.filter((f) => f.type.startsWith("image/"));
    if (!imgFiles.length) return;
    try {
      const urls = await Promise.all(imgFiles.map(fileToDataUrl));
      setImgs((cur) => [...cur, ...urls]);
    } catch {
      setLog((l) => [...l, { role: "err", text: "读图片失败" }]);
    }
  };

  // 收文件（拖入的非图片）：读字节 → Rust 抽文字 → 进待发送区
  const addDocFiles = async (files: File[]) => {
    for (const f of files) {
      if (f.type.startsWith("image/")) continue; // 图片走 addImageFiles
      setLog((l) => [...l, { role: "step", text: `📄 解析文件 ${f.name}…` }]);
      try {
        const b64 = await fileToB64(f);
        const text = await api.extractFileText(f.name, "", b64);
        setDocs((cur) => [...cur, { name: f.name, text }]);
      } catch (e) {
        setLog((l) => [...l, { role: "err", text: `「${f.name}」${String(e)}` }]);
      }
    }
  };

  // 文件选择器选文件（拖小浮窗不方便时用）：拿到路径交给 Rust 按路径读
  const pickDoc = async () => {
    const sel = await openDialog({
      multiple: true,
      title: "选文件给 Winky 看",
      filters: [{ name: "文档", extensions: ["pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json"] }],
    }).catch(() => null);
    const paths = Array.isArray(sel) ? sel : sel ? [sel] : [];
    for (const p of paths) {
      const name = p.split(/[\\/]/).pop() || p;
      setLog((l) => [...l, { role: "step", text: `📄 解析文件 ${name}…` }]);
      try {
        const text = await api.extractFileText(name, p, "");
        setDocs((cur) => [...cur, { name, text }]);
      } catch (e) {
        setLog((l) => [...l, { role: "err", text: `「${name}」${String(e)}` }]);
      }
    }
  };

  // 展开态：Ctrl+V 粘贴图片 → 进待发送区（截图问 Winky 的主路）
  useEffect(() => {
    if (collapsed) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const it of Array.from(items)) {
        if (it.kind === "file" && it.type.startsWith("image/")) {
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      }
      if (!files.length) return;
      e.preventDefault();
      void addImageFiles(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);
  const send = () => sendText(input);
  const stop = () => {
    // 两条路都喊停（互不影响：没在跑的那条是空操作）
    api.agentCancel().catch(() => {});
    api.chatCancel().catch(() => {});
    setRunning(false);
    setPhase("idle");
    // 定格可能正在流式的聊天气泡
    setLog((l) => {
      const last = l[l.length - 1];
      if (last && last.streaming) {
        const copy = l.slice();
        copy[copy.length - 1] = { ...last, streaming: false };
        return copy;
      }
      return l;
    });
  };
  const pickCwd = async () => {
    const d = await openDialog({ directory: true, title: "选 Agent 干活的工作目录" }).catch(() => null);
    if (typeof d === "string") save({ cwd: d });
  };

  // 把连续的「过程」行归并成一个可折叠块（右侧小箭头展开/收起）
  type Row = { kind: "line"; line: Line } | { kind: "steps"; steps: Line[] };
  const rows = useMemo<Row[]>(() => {
    const r: Row[] = [];
    for (const l of log) {
      if (l.role === "step") {
        const last = r[r.length - 1];
        if (last && last.kind === "steps") last.steps.push(l);
        else r.push({ kind: "steps", steps: [l] });
      } else {
        r.push({ kind: "line", line: l });
      }
    }
    return r;
  }, [log]);

  const win = getCurrentWindow();
  // 改折叠图标大小：存盘 + 同步 ref；若此刻是折叠态，立即应用到窗口
  const changeSize = (n: number) => {
    const v = Math.max(44, Math.min(200, Math.round(n)));
    localStorage.setItem(SIZE_PREFS, String(v));
    petSizeRef.current = v;
    setPetSize(v);
    if (collapsed) win.setSize(new LogicalSize(v, v)).catch(() => {});
  };
  const frameMs = Math.round(1000 / fps); // 每帧时长
  const frameMsRef = useRef(frameMs); // 给定时器读当前帧速，避开闭包陈旧
  frameMsRef.current = frameMs; // 每次渲染同步最新值
  // 一个动作播完整一轮所需时长（按当前帧速算），+一点缓冲让末帧露全
  const loopMs = (s: SpriteState) => PHASE_ROW[s].frames * frameMsRef.current + 60;
  const changeSpeed = (n: number) => {
    const v = Math.max(2, Math.min(30, Math.round(n)));
    localStorage.setItem(SPEED_PREFS, String(v));
    setFps(v);
  };
  // 标题栏手动拖动：data-tauri-drag-region 在本机 WebView2 不稳，改成 mousedown 直接 startDragging（和图标同款）。
  // 点在按钮/下拉/输入这些交互件上不触发拖动。
  const onHeadDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, select, input, textarea")) return;
    win.startDragging().catch(() => {});
  };
  // 窗口从当前尺寸/位置平滑变到目标(物理像素)。用 rAF 驱动 + 每帧不 await(fire-and-forget)，
  // 让窗口以刷新率最快速度跟着长大——这是逐帧 resize 在本机能做到的最顺，不再卡。
  function animateBox(tx: number, ty: number, tw: number, th: number) {
    return new Promise<void>((resolve) => {
      void (async () => {
        let sx: number;
        let sy: number;
        let sw: number;
        let sh: number;
        try {
          const sp = await win.outerPosition();
          const ss = await win.outerSize();
          sx = sp.x;
          sy = sp.y;
          sw = ss.width;
          sh = ss.height;
        } catch {
          resolve();
          return;
        }
        const t0 = performance.now();
        const dur = 190;
        const step = (now: number) => {
          const p = Math.min(1, (now - t0) / dur);
          const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
          // 先 position 后 size（IPC 有序），保证锚定边每帧都稳，不抖
          void win.setPosition(
            new PhysicalPosition(Math.round(sx + (tx - sx) * e), Math.round(sy + (ty - sy) * e)),
          );
          void win.setSize(
            new PhysicalSize(Math.round(sw + (tw - sw) * e), Math.round(sh + (th - sh) * e)),
          );
          if (p < 1) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      })();
    });
  }

  const expand = async () => {
    try {
      const cur = await win.outerPosition();
      const mon = await monitorForPoint(cur.x, cur.y);
      let tx = cur.x;
      let ty = cur.y;
      let tw = 360;
      let th = 480;
      if (mon) {
        const s = mon.scaleFactor;
        const w = Math.round(360 * s);
        const h = Math.round(480 * s);
        const pad = Math.round(8 * s);
        const size = Math.round(petSizeRef.current * s);
        const { x: mx, y: my } = mon.position;
        const { width: mw, height: mh } = mon.size;
        const rightSide = cur.x + size / 2 > mx + mw / 2;
        const bottomSide = cur.y + size / 2 > my + mh / 2;
        tx = rightSide ? cur.x + size - w : cur.x; // 右侧→向左展(右缘锚定)；左侧→向右展
        ty = bottomSide ? cur.y + size - h : cur.y; // 下半→向上展；上半→向下展
        tx = Math.max(mx + pad, Math.min(tx, mx + mw - w - pad));
        ty = Math.max(my + pad, Math.min(ty, my + mh - h - pad));
        tw = w;
        th = h;
        setOrigin(`${rightSide ? "100%" : "0%"} ${bottomSide ? "100%" : "0%"}`);
      }
      await win.setResizable(true);
      setCollapsed(false); // 内容先就位，随窗口一起长大
      await animateBox(tx, ty, tw, th);
      win.setFocus();
    } catch {
      await win.setSize(new LogicalSize(360, 480));
      setCollapsed(false);
    }
  };

  const collapse = async () => {
    const target = loadPos(); // 收起后回到图标上次停的位置
    // 可见的"缩小+淡出"全用 CSS transform(GPU、圆角完好)；窗口尺寸不在此变，避开透明窗 resize 的直角 artifact
    setClosing(true);
    await new Promise((r) => setTimeout(r, 200)); // 等 .pet 缩放淡出跑完
    try {
      // 此刻 .pet 已透明，窗口一步 setSize / 移位都看不见
      await win.setResizable(false);
      await win.setSize(new LogicalSize(petSizeRef.current, petSizeRef.current));
      if (target) await win.setPosition(new PhysicalPosition(target.x, target.y));
    } catch {
      /* ignore */
    }
    setCollapsed(true); // 换成图标（自带淡入）
    setClosing(false);
    if (!target) {
      try {
        const pos = await win.outerPosition();
        await snapToEdge(pos.x, pos.y, true);
      } catch {
        /* ignore */
      }
    }
  };

  // 图标态：按住拖动挪位置 / 轻点展开（靠移动距离区分）；松手吸附最近屏幕边
  const downRef = useRef<{ x: number; y: number } | null>(null);
  const movedRef = useRef(false);
  const onIconDown = (e: React.MouseEvent) => {
    downRef.current = { x: e.screenX, y: e.screenY };
    movedRef.current = false;
  };
  const onIconMove = (e: React.MouseEvent) => {
    if (!downRef.current || e.buttons !== 1) return;
    const dx = e.screenX - downRef.current.x;
    if (Math.abs(dx) + Math.abs(e.screenY - downRef.current.y) > 4) {
      movedRef.current = true;
      // 用刚起手那几像素的光标方向定朝向（真实 mousemove，最准）；之后 onMoved 再修正
      if (Math.abs(dx) >= 2) setDragDir(dx < 0 ? "left" : "right");
      downRef.current = null;
      win.startDragging().catch(() => {});
    }
  };
  const onIconClick = () => {
    if (!movedRef.current) expand();
  };

  // 拖完（窗口停止移动 220ms）：靠近某条边才吸附，且平滑飘过去
  const snappingRef = useRef(false);
  useEffect(() => {
    if (!collapsed) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const unP = win.onMoved(({ payload }) => {
      if (snappingRef.current) return; // 飘移动画自身触发的移动，忽略
      setDragging(true); // 拖动中 → 切到走路动作
      const px = lastXRef.current;
      if (px != null) {
        if (payload.x > px + 1) setDragDir("right"); // 往右拖 → 向右走
        else if (payload.x < px - 1) setDragDir("left"); // 往左拖 → 向左走
      }
      lastXRef.current = payload.x;
      clearTimeout(t);
      t = setTimeout(() => {
        setDragging(false);
        void snapToEdge(payload.x, payload.y);
      }, 220);
    });
    return () => {
      clearTimeout(t);
      unP.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  // 缓动飘到目标位置（easeOutCubic，约 200ms）
  async function glideTo(tx: number, ty: number) {
    snappingRef.current = true;
    try {
      const start = await win.outerPosition();
      const sx = start.x;
      const sy = start.y;
      const steps = 14;
      for (let i = 1; i <= steps; i++) {
        const e = 1 - Math.pow(1 - i / steps, 3);
        await win.setPosition(
          new PhysicalPosition(Math.round(sx + (tx - sx) * e), Math.round(sy + (ty - sy) * e)),
        );
        await new Promise((r) => setTimeout(r, 14));
      }
    } catch {
      /* ignore */
    } finally {
      snappingRef.current = false;
    }
  }

  async function snapToEdge(px: number, py: number, force = false) {
    try {
      // 用图标所在那块屏（跨屏也支持），避开"当前窗口所在屏"在接缝处的歧义
      const mon = await monitorForPoint(px, py);
      if (!mon) return;
      const s = mon.scaleFactor;
      const size = Math.round(petSizeRef.current * s);
      const margin = Math.round(8 * s);
      const threshold = Math.round(90 * s); // 只在离边 90px 内才吸附；拖到中间则留在原地
      const { x: mx, y: my } = mon.position;
      const { width: mw, height: mh } = mon.size;
      const dL = px - mx;
      const dR = mx + mw - (px + size);
      const dT = py - my;
      const dB = my + mh - (py + size);
      const m = Math.min(dL, dR, dT, dB);
      if (!force && m > threshold) {
        savePos(px, py); // 不吸附也记住手动摆放的位置
        return;
      }
      let nx = px;
      let ny = py;
      if (m === dL) nx = mx + margin;
      else if (m === dR) nx = mx + mw - size - margin;
      else if (m === dT) ny = my + margin;
      else ny = my + mh - size - margin;
      savePos(nx, ny); // 记住吸附后的位置
      if (Math.abs(nx - px) < 2 && Math.abs(ny - py) < 2) return; // 已贴边，别重复飘
      await glideTo(nx, ny);
    } catch {
      /* 吸附失败不致命 */
    }
  }

  // 打开时定位：优先回到上次手动摆放的位置；没有/失效则默认主屏右边缘
  useEffect(() => {
    (async () => {
      try {
        await win.setSize(new LogicalSize(petSizeRef.current, petSizeRef.current)); // 强制方形，避免首开被拉成椭圆
        const saved = loadPos();
        if (saved) {
          const m = await monitorForPoint(saved.x, saved.y);
          if (m) {
            await win.setPosition(new PhysicalPosition(saved.x, saved.y));
            return;
          }
        }
        const mon = await primaryMonitor();
        if (!mon) return;
        const s = mon.scaleFactor;
        const size = Math.round(petSizeRef.current * s);
        const margin = Math.round(12 * s);
        const x = mon.position.x + mon.size.width - size - margin;
        const y = mon.position.y + Math.round(mon.size.height * 0.32);
        await win.setPosition(new PhysicalPosition(x, y));
        savePos(x, y);
      } catch {
        /* ignore */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 读「开机自动出现」回显
  useEffect(() => {
    api.winkyGetAutoshow().then(setAutoshow).catch(() => {});
  }, []);
  const toggleAutoshow = (on: boolean) => {
    setAutoshow(on);
    api.winkySetAutoshow(on).catch(() => {});
  };

  // 折叠态：只是个小图标，点开展开成聊天窗；拖动可挪位置
  if (collapsed) {
    return (
      <div
        className={"winky-bubble" + (running ? " busy" : "")}
        title="点击展开 Winky · 按住拖动可挪位置（松手吸附边缘）"
        onMouseDown={onIconDown}
        onMouseMove={onIconMove}
        onClick={onIconClick}
      >
        {skinUrl ? (
          <PetSprite
            url={skinUrl}
            phase={
              dragging
                ? (dragDir === "left") !== flipped
                  ? "walk-left"
                  : "walk-right"
                : fidget ?? phase
            }
            size={petSize - 2}
            frameMs={frameMs}
          />
        ) : (
          <WinkyLogo className="winky-logo" phase={phase} />
        )}
      </div>
    );
  }

  return (
    <div
      className={"pet" + (closing ? " closing" : "") + (dragOver ? " dragover" : "")}
      style={{ transformOrigin: origin }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragOver) setDragOver(true);
      }}
      onDragLeave={(e) => {
        // 只在真正离开整个窗口时取消高亮（避免子元素间移动闪烁）
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const files = Array.from(e.dataTransfer?.files || []);
        const imgs = files.filter((f) => f.type.startsWith("image/"));
        const others = files.filter((f) => !f.type.startsWith("image/"));
        if (imgs.length) void addImageFiles(imgs);
        if (others.length) void addDocFiles(others);
      }}
    >
      <div className="pet-head" onMouseDown={onHeadDown}>
        <span className="pet-face">
          {skinUrl ? (
            <PetSprite url={skinUrl} phase={fidget ?? phase} size={26} frameMs={frameMs} />
          ) : (
            <WinkyLogo className="winky-logo" phase={phase} />
          )}
        </span>
        <span className="pet-titlewrap">
          <span className="pet-title">Winky</span>
        </span>
        <select
          className="pet-persona-sel"
          value={chatCfg.activeSkillId}
          onChange={(e) => switchSkill(e.target.value)}
          title="切换技能（换提示词，顺带开它绑定的工具）"
        >
          {chatCfg.skills.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {log.length > 0 && (
          <button className="pet-x" title="新对话（清空当前）" onClick={clearChat}>🧹</button>
        )}
        <button className="pet-x" title="设置" onClick={() => setShowCfg((s) => !s)}>⚙</button>
        <button className="pet-x" title="收回小图标" onClick={collapse}>—</button>
        <button className="pet-x" title="关闭" onClick={() => win.close()}>✕</button>
      </div>

      <div className="pet-body">
      {showCfg && (
        <div className="pet-cfg" ref={cfgRef}>
          <div className="pet-tabs">
            <button className={"pet-tab" + (cfgTab === "api" ? " on" : "")} onClick={() => setCfgTab("api")}>
              💬 API
            </button>
            <button className={"pet-tab" + (cfgTab === "skill" ? " on" : "")} onClick={() => setCfgTab("skill")}>
              🧩 技能
            </button>
            <button className={"pet-tab" + (cfgTab === "skin" ? " on" : "")} onClick={() => setCfgTab("skin")}>
              🐾 皮肤
            </button>
            <button className={"pet-tab" + (cfgTab === "work" ? " on" : "")} onClick={() => setCfgTab("work")}>
              🛠 干活
            </button>
          </div>

          {cfgTab === "api" && (
            <>
              <label className="pet-cfg-row">
                当前配置
                <select value={chatCfg.activeId} onChange={(e) => switchProfile(e.target.value)}>
                  {chatCfg.profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name || "未命名"}
                      {p.model ? ` · ${p.model}` : ""}
                    </option>
                  ))}
                </select>
                <button onClick={addProfile} title="新建一套配置">＋</button>
                <button onClick={deleteActiveProfile} title="删除当前配置" disabled={chatCfg.profiles.length <= 1}>
                  🗑
                </button>
              </label>
              <label className="pet-cfg-row">
                名字
                <input
                  value={active.name}
                  placeholder="给这套起个名（如 DeepSeek、公司中转）"
                  onChange={(e) => updateActive({ name: e.target.value })}
                />
              </label>
              <label className="pet-cfg-row">
                服务商
                <select
                  value={CHAT_PRESETS.find((p) => p.baseUrl === active.baseUrl)?.baseUrl || ""}
                  onChange={(e) => e.target.value && updateActive({ baseUrl: e.target.value })}
                >
                  <option value="">自定义 / 选个预置…</option>
                  {CHAT_PRESETS.map((p) => (
                    <option key={p.baseUrl} value={p.baseUrl}>{p.label}</option>
                  ))}
                </select>
              </label>
              <label className="pet-cfg-row">
                API 地址
                <input
                  value={active.baseUrl}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) => updateActive({ baseUrl: e.target.value })}
                />
              </label>
              <label className="pet-cfg-row">
                API Key
                <input
                  type="password"
                  value={active.apiKey}
                  placeholder="sk-..."
                  onChange={(e) => updateActive({ apiKey: e.target.value })}
                />
              </label>
              <label className="pet-cfg-row">
                模型名
                <input
                  value={active.model}
                  placeholder="gpt-4o-mini / deepseek-chat ..."
                  onChange={(e) => updateActive({ model: e.target.value })}
                />
              </label>
            </>
          )}

          {cfgTab === "skill" && (
            <>
              <label className="pet-cfg-row">
                名字
                <input value={activeSkill.name} onChange={(e) => updateSkill(activeSkill.id, { name: e.target.value })} />
                <button onClick={addSkill} title="新建技能">＋</button>
                <button
                  onClick={() => deleteSkill(activeSkill.id)}
                  title="删除当前技能"
                  disabled={chatCfg.skills.length <= 1}
                >
                  🗑
                </button>
              </label>
              <label className="pet-cfg-col">
                提示词
                <textarea
                  className="pet-skill-prompt"
                  value={activeSkill.prompt}
                  placeholder="告诉 Winky 这个技能该怎么回答…"
                  onChange={(e) => updateSkill(activeSkill.id, { prompt: e.target.value })}
                />
              </label>
              <div className="pet-skill-tools">
                <label className="pet-chk">
                  <input
                    type="checkbox"
                    checked={!!activeSkill.web}
                    onChange={(e) => {
                      updateSkill(activeSkill.id, { web: e.target.checked });
                      setWeb(e.target.checked);
                    }}
                  />
                  选中时自动联网 🌐
                </label>
                <label className="pet-chk">
                  <input
                    type="checkbox"
                    checked={!!activeSkill.lib}
                    onChange={(e) => {
                      updateSkill(activeSkill.id, { lib: e.target.checked });
                      setLib(e.target.checked);
                    }}
                  />
                  选中时自动查库 📁
                </label>
              </div>
            </>
          )}

          {cfgTab === "skin" && (
            <>
              <div className="pet-skin-preview">
                {skinUrl ? (
                  <PetSprite url={skinUrl} phase={phase} size={84} frameMs={frameMs} />
                ) : (
                  <WinkyLogo className="winky-logo" phase={phase} />
                )}
              </div>
              <label className="pet-cfg-row">
                大小
                <input
                  type="range"
                  min={44}
                  max={160}
                  value={petSize}
                  onChange={(e) => changeSize(+e.target.value)}
                />
                <input
                  className="pet-size-num"
                  type="number"
                  min={44}
                  max={200}
                  value={petSize}
                  onChange={(e) => changeSize(+e.target.value)}
                />
                <span className="pet-size-val">px</span>
              </label>
              <label className="pet-cfg-row">
                速度
                <input
                  type="range"
                  min={2}
                  max={30}
                  value={fps}
                  onChange={(e) => changeSpeed(+e.target.value)}
                />
                <input
                  className="pet-size-num"
                  type="number"
                  min={2}
                  max={30}
                  value={fps}
                  onChange={(e) => changeSpeed(+e.target.value)}
                />
                <span className="pet-size-val">fps</span>
              </label>
              <label className="pet-chk">
                <input
                  type="checkbox"
                  checked={flipped}
                  disabled={skin.kind === "default"}
                  onChange={toggleFlip}
                />
                这只左右跑反了 → 镜像修正
              </label>
              <label className="pet-cfg-row">
                皮肤
                <select
                  value={skin.kind === "default" ? "default" : `${skin.kind}:${skin.id}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "default") return chooseSkin({ kind: "default", id: "" });
                    if (v.startsWith("preset:")) return chooseSkin({ kind: "preset", id: v.slice(7) });
                    if (v.startsWith("custom:")) {
                      const id = v.slice(7);
                      const pet = customPets.find((p) => p.id === id);
                      if (pet) chooseSkin({ kind: "custom", id, dir: pet.dir });
                    }
                  }}
                >
                  <option value="default">默认（终端脸）</option>
                  <optgroup label="内置预设">
                    {PRESET_PETS.map((p) => (
                      <option key={p.id} value={`preset:${p.id}`}>{p.name}</option>
                    ))}
                  </optgroup>
                  {customPets.filter((p) => !PRESET_PETS.some((x) => x.id === p.id)).length > 0 && (
                    <optgroup label="我装的（自定义）">
                      {customPets
                        .filter((p) => !PRESET_PETS.some((x) => x.id === p.id))
                        .map((p) => (
                          <option key={p.id} value={`custom:${p.id}`}>{p.displayName}</option>
                        ))}
                    </optgroup>
                  )}
                </select>
                <button onClick={() => api.winkyListPets().then(setCustomPets).catch(() => {})} title="刷新已装宠物">
                  ↻
                </button>
                <button
                  onClick={() => void deletePet()}
                  disabled={skin.kind !== "custom"}
                  title={skin.kind === "custom" ? "删除当前选中的自定义宠物" : "只能删「我装的」自定义宠物"}
                >
                  🗑
                </button>
              </label>
              <label className="pet-cfg-row">
                装新宠物
                <input
                  value={petSlug}
                  placeholder="名字 或 整条命令(npx petdex install xxx) 都行"
                  onChange={(e) => setPetSlug(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void installPet();
                  }}
                />
                <button onClick={() => void installPet()} disabled={installing || !petSlug.trim()}>
                  {installing ? "装…" : "安装"}
                </button>
              </label>
              <div className="pet-skin-hint">
                {installMsg || (
                  <>
                    在 <a href="https://petdex.dev" target="_blank" rel="noreferrer">petdex.dev</a> 找喜欢的宠物，把它的名字填上面点「安装」即可（需装 Node）。
                  </>
                )}
              </div>
            </>
          )}

          {cfgTab === "work" && (
            <>
              <label>
                Agent
                <select value={cfg.agent} onChange={(e) => save({ agent: e.target.value })}>
                  <option value="codex">Codex</option>
                  <option value="claude">Claude</option>
                </select>
              </label>
              <label>
                权限
                <select value={cfg.sandbox} onChange={(e) => save({ sandbox: e.target.value })}>
                  <option value="read-only">{SANDBOX_LABEL["read-only"]}</option>
                  <option value="workspace-write">{SANDBOX_LABEL["workspace-write"]}</option>
                  <option value="full">{SANDBOX_LABEL["full"]}</option>
                </select>
              </label>
              <label className="pet-cfg-row">
                工作目录
                <input value={cfg.cwd} placeholder="(默认当前目录)" onChange={(e) => save({ cwd: e.target.value })} />
                <button onClick={pickCwd}>选…</button>
              </label>
              <label className="pet-cfg-row">
                可执行
                <input value={cfg.bin} placeholder={`(默认 ${cfg.agent})`} onChange={(e) => save({ bin: e.target.value })} />
              </label>
              <label className="pet-chk">
                <input type="checkbox" checked={autoshow} onChange={(e) => toggleAutoshow(e.target.checked)} />
                开机自动出现（需 Nobi 已开机自启）
              </label>
              <div className="pet-status">{status}</div>
            </>
          )}
        </div>
      )}

      <div className="pet-log" ref={logRef}>
        {log.length === 0 && (
          <div className="pet-empty">
            <div className="pet-empty-face">
              {skinUrl ? <PetSprite url={skinUrl} phase={phase} size={68} frameMs={frameMs} /> : <WinkyLogo className="winky-logo" />}
            </div>
            <div className="pet-empty-hi">我是 Winky</div>
            <div className="pet-empty-sub">
              直接打字跟我聊；开头加 <b>/</b> 转给 {cfg.agent} 干活；拖图/粘图能看图说话（需视觉模型）；
              <b>📎</b> 发文件、<b>🌐</b> 联网、<b>📁</b> 查素材库、粘网址自动读网页
            </div>
            <div className="pet-chips">
              {["讲个程序员冷笑话", "/列出当前目录有哪些文件", "/找找代码里的 TODO"].map((s) => (
                <button key={s} className="pet-chip" onClick={() => sendText(s)} disabled={running}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {rows.map((row, i) =>
          row.kind === "steps" ? (
            <details key={i} className="pet-steps">
              <summary>过程 · {row.steps.length} 步</summary>
              {row.steps.map((s, j) => (
                <div key={j} className="pet-step">{s.text}</div>
              ))}
            </details>
          ) : row.line.role === "user" ? (
            <div key={i} className="pet-msg pet-msg-user">
              <div className="pet-bubble pet-bubble-user">
                {row.line.imgs && row.line.imgs.length > 0 && (
                  <div className="pet-bubble-imgs">
                    {row.line.imgs.map((u, k) => (
                      <img key={k} src={u} alt="" />
                    ))}
                  </div>
                )}
                {row.line.docs && row.line.docs.length > 0 && (
                  <div className="pet-bubble-docs">
                    {row.line.docs.map((n, k) => (
                      <span key={k} className="pet-doc-tag">📄 {n}</span>
                    ))}
                  </div>
                )}
                {row.line.via === "cli" && <span className="pet-tag" title="派给 CLI 干活">🛠</span>}
                {row.line.text}
              </div>
            </div>
          ) : row.line.role === "sys" ? (
            <div key={i} className="pet-sysline">{row.line.text}</div>
          ) : (
            <div key={i} className="pet-msg pet-msg-bot">
              <span className="pet-msg-ava"><WinkyLogo className="winky-logo" /></span>
              <div className={"pet-bubble" + (row.line.role === "err" ? " pet-bubble-err" : "")}>
                {row.line.role === "out" ? <MarkdownText text={row.line.text} /> : row.line.text}
                {row.line.role === "out" && !row.line.streaming && row.line.text.trim() && (
                  <CopyBtn text={row.line.text} className="pet-bubble-copy" />
                )}
              </div>
            </div>
          ),
        )}
        {running && phase === "waiting" && (
          <div className="pet-msg pet-msg-bot">
            <span className="pet-msg-ava">🌀</span>
            <div className="pet-bubble pet-typing">思考中…</div>
          </div>
        )}
        {!running && log.length > 0 && log[log.length - 1]?.role === "out" && (
          <div className="pet-regen-row">
            <button className="pet-regen" onClick={regenerate} title="用同一句重问一次">↻ 重新生成</button>
          </div>
        )}
      </div>
      </div>

      <div className="pet-input">
        {imgs.length > 0 && (
          <div className="pet-attach">
            {imgs.map((u, k) => (
              <span key={k} className="pet-attach-item">
                <img src={u} alt="" />
                <button
                  className="pet-attach-x"
                  title="移除"
                  onClick={() => setImgs((cur) => cur.filter((_, j) => j !== k))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        {docs.length > 0 && (
          <div className="pet-attach">
            {docs.map((d, k) => (
              <span key={k} className="pet-doc-chip" title={d.name}>
                📄 {d.name}
                <button
                  className="pet-doc-x"
                  title="移除"
                  onClick={() => setDocs((cur) => cur.filter((_, j) => j !== k))}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <div
          className="pet-input-pill"
          title={"直接打字 = 跟我聊天\n/ 开头 = 派给 CLI 干活（例：/列出当前目录文件）\n// 开头 = 发一句以 / 开头的聊天（转义）\n粘网址 = 自动读网页正文"}
        >
          <button
            className={"pet-web" + (web ? " on" : "")}
            title={web ? "联网搜索：开（每次发送先搜再答）" : "联网搜索：关"}
            onClick={() => setWeb((v) => !v)}
          >
            🌐
          </button>
          <button
            className={"pet-web" + (lib ? " on" : "")}
            title={lib ? "查素材库：开（每次发送先在 Nobi 库里搜）" : "查素材库：关"}
            onClick={() => setLib((v) => !v)}
          >
            📁
          </button>
          <button className="pet-web" title="选文件给我看（PDF/Word/Excel/PPT/txt）" onClick={pickDoc}>
            📎
          </button>
          <textarea
            value={input}
            placeholder="聊天直接说 · 开头加 / 让我干活"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {running ? (
            <button className="pet-send danger" title="停止" onClick={stop}>■</button>
          ) : (
            <button className="pet-send" title="发送（Enter）" onClick={send} disabled={!input.trim() && imgs.length === 0 && docs.length === 0}>↑</button>
          )}
        </div>
      </div>
    </div>
  );
}
