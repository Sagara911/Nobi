// 纯函数工具与常量（不依赖 Tauri / React）

import type { Asset } from "./types";

export const DOBBY_URL = "https://dobby-aih.pages.dev/";
export const REPO_URL = "https://github.com/Sagara911/Nobi";

const VIDEO_FORMATS = new Set(["MP4", "WEBM", "MOV", "MKV", "AVI"]);
export const isVideo = (a: Asset) => VIDEO_FORMATS.has(a.format);

const AUDIO_FORMATS = new Set(["MP3", "WAV", "OGG", "FLAC", "M4A", "AAC"]);
export const isAudio = (a: Asset) => AUDIO_FORMATS.has(a.format);

/** 3D 预览已下线：本机 WebView2 无法呈现实时 GPU 画布（详见 docs/3D 记录）。
 *  保留 isModel 接口但恒假，所有 3D 分支即死代码、永不触发；要彻底重做再说。 */
export const ENABLE_3D = false;

const MODEL_FORMATS = new Set(["GLB", "GLTF", "OBJ", "FBX", "STL"]);
export const isModel = (a: Asset) => ENABLE_3D && MODEL_FORMATS.has(a.format);

/** 普通图片（非视频/音频/3D）：AI 打标、CLIP 找相似、画板、悬浮参考等图像能力只对它开放 */
export const isImage = (a: Asset) => !isVideo(a) && !isAudio(a) && !isModel(a);

export function humanSize(bytes: number): string {
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

export const COLOR_BUCKETS = [
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

/** 取画面里最鲜艳的色来归类（避免暗调图全被算成黑白灰） */
export function primaryBucket(colors: string[]): string {
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
