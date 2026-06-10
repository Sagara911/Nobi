// Nobi 采集扩展：右键图片 → 发给本地 Nobi（127.0.0.1:21420）
const ENDPOINT = "http://127.0.0.1:21420/collect";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "gringotts-collect",
    title: "🏦 保存到 Nobi",
    contexts: ["image"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== "gringotts-collect" || !info.srcUrl) return;
  try {
    const resp = await fetch(info.srcUrl);
    if (!resp.ok) throw new Error("图片下载失败 HTTP " + resp.status);
    const blob = await resp.blob();
    const dataB64 = await blobToBase64(blob);

    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        dataB64,
        mime: blob.type || "image/png",
        srcUrl: info.srcUrl,
        pageUrl: info.pageUrl || (tab && tab.url) || "",
        pageTitle: (tab && tab.title) || "",
      }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const j = await r.json();
    notify("已存入 Nobi ✓", j.name || "");
  } catch (e) {
    notify("保存失败", String(e) + "（Nobi 是否在运行？）");
  }
});

async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: "icon.png",
    title,
    message,
  });
}
