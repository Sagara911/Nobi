// 头像图片处理：把任意图片压成 64×64 方形缩略图的 data URL。
// 头像随每条消息带走（avatar 字段），所以必须小——data URL 约 2–4KB，
// 不占 Storage、不受 24h 清理影响、跨服务器都能显。

const AVATAR_SIZE = 64;

function loadAndCrop(objUrl: string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        if (!ctx) {
          reject(new Error("无法创建画布"));
          return;
        }
        // 居中裁成正方形（cover）
        const s = Math.min(img.width, img.height);
        const sx = (img.width - s) / 2;
        const sy = (img.height - s) / 2;
        ctx.drawImage(img, sx, sy, s, s, 0, 0, size, size);
        resolve(c.toDataURL("image/jpeg", 0.82));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    };
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = objUrl;
  });
}

/** 从 File（启动器"上传图片"）生成头像 data URL */
export async function fileToAvatar(file: File): Promise<string> {
  const objUrl = URL.createObjectURL(file);
  try {
    return await loadAndCrop(objUrl, AVATAR_SIZE);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

/** 从可 fetch 的 URL（素材库 convertFileSrc）生成头像 data URL。
 *  先 fetch→blob→objectURL，避免 canvas 被跨源污染（同 contactSheet 做法）。 */
export async function assetUrlToAvatar(url: string): Promise<string> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`读取图片失败：${resp.status}`);
  const blob = await resp.blob();
  const objUrl = URL.createObjectURL(blob);
  try {
    return await loadAndCrop(objUrl, AVATAR_SIZE);
  } finally {
    URL.revokeObjectURL(objUrl);
  }
}

/** 头像是否是图片（data URL 或 http），用于决定渲染 <img> 还是 emoji */
export function isImageAvatar(a?: string): boolean {
  return !!a && (a.startsWith("data:") || a.startsWith("http"));
}
