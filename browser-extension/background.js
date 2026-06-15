// Nobi browser extension: right-click images to collect, or selected text to translate.
const COLLECT_ENDPOINT = "http://127.0.0.1:21420/collect";
const TRANSLATE_ENDPOINT = "http://127.0.0.1:21420/api/translate";

const MENU_COLLECT = "nobi-collect-image";
const MENU_TRANSLATE = "nobi-translate-selection";

chrome.runtime.onInstalled.addListener(setupMenus);

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_COLLECT,
      title: "保存到 Nobi",
      contexts: ["image"],
    });

    chrome.contextMenus.create({
      id: MENU_TRANSLATE,
      title: "Nobi 翻译「%s」",
      contexts: ["selection"],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === MENU_COLLECT && info.srcUrl) {
    await collectImage(info, tab);
    return;
  }

  if (info.menuItemId === MENU_TRANSLATE) {
    await translateSelection(info, tab);
  }
});

async function collectImage(info, tab) {
  try {
    const resp = await fetch(info.srcUrl);
    if (!resp.ok) throw new Error("图片下载失败 HTTP " + resp.status);
    const blob = await resp.blob();
    const dataB64 = await blobToBase64(blob);

    const r = await fetch(COLLECT_ENDPOINT, {
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
    notify("已存入 Nobi", j.name || "");
  } catch (e) {
    notify("保存失败", String(e) + "（Nobi 是否在运行？）");
  }
}

async function translateSelection(info, tab) {
  const text = (info.selectionText || "").trim();
  if (!text) {
    notify("Nobi 翻译", "请先选中文字");
    return;
  }

  try {
    const r = await fetch(TRANSLATE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        targetLang: "auto",
        mode: "art_terms",
        provider: "auto",
        sourceApp: "browser-extension",
        sourceUrl: info.pageUrl || (tab && tab.url) || "",
        saveHistory: true,
      }),
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.error || "HTTP " + r.status);

    const result = j.result || {};
    const payload = {
      sourceText: text,
      targetText: result.targetText || "",
      sourceLang: result.sourceLang || "",
      targetLang: result.targetLang || "zh-CN",
      provider: result.provider || "",
      glossaryHits: result.usedGlossary || result.glossaryHits || [],
      dictionary: Array.isArray(result.dictionary) ? result.dictionary : [],
      phonetic: result.phonetic || "",
    };

    const shown = await showTranslationInPage(tab && tab.id, payload);
    if (!shown) {
      notify("Nobi 翻译", truncateText(payload.targetText || "没有翻译结果", 320));
    }
  } catch (e) {
    notify("翻译失败", String(e) + "（Nobi 是否在运行？）");
  }
}

async function showTranslationInPage(tabId, payload) {
  if (!tabId || !chrome.scripting) return false;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: renderTranslationPopover,
      args: [payload],
    });
    return true;
  } catch {
    return false;
  }
}

function renderTranslationPopover(payload) {
  const existing = document.getElementById("nobi-translation-popover");
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = "nobi-translation-popover";
  host.style.all = "initial";
  host.style.position = "fixed";
  host.style.right = "24px";
  host.style.bottom = "24px";
  host.style.zIndex = "2147483647";
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    .card {
      width: min(420px, calc(100vw - 32px));
      max-height: min(520px, calc(100vh - 32px));
      overflow: auto;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 8px;
      background: #18181d;
      color: #f5f5f7;
      box-shadow: 0 18px 60px rgba(0,0,0,.42);
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid rgba(255,255,255,.1);
      font-weight: 700;
    }
    .body { padding: 12px 14px 14px; }
    .label {
      margin: 0 0 5px;
      color: rgba(245,245,247,.58);
      font-size: 12px;
    }
    .text {
      margin: 0 0 12px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .target {
      padding: 10px 11px;
      border-radius: 7px;
      background: rgba(255,255,255,.06);
      color: #fff;
    }
    .phonetic {
      margin: -6px 0 12px;
      color: rgba(245,245,247,.6);
      font-size: 13px;
    }
    .dict {
      margin: 0 0 12px;
      display: flex;
      flex-direction: column;
      gap: 5px;
    }
    .dict-row {
      display: flex;
      gap: 10px;
      align-items: baseline;
    }
    .dict-row dt {
      flex: 0 0 auto;
      min-width: 44px;
      color: rgba(245,245,247,.55);
      font-style: italic;
    }
    .dict-row dd {
      margin: 0;
      color: rgba(245,245,247,.92);
      word-break: break-word;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 10px;
      color: rgba(245,245,247,.55);
      font-size: 12px;
    }
    .pill {
      border: 1px solid rgba(255,255,255,.1);
      border-radius: 999px;
      padding: 2px 8px;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 0 14px 14px;
    }
    button {
      border: 0;
      border-radius: 7px;
      padding: 7px 11px;
      background: rgba(255,255,255,.1);
      color: #f5f5f7;
      font: inherit;
      cursor: pointer;
    }
    button.primary {
      background: #3f72e8;
      color: white;
    }
    button:hover { filter: brightness(1.08); }
  `;

  const card = document.createElement("section");
  card.className = "card";

  const head = document.createElement("div");
  head.className = "head";
  const title = document.createElement("span");
  title.textContent = "Nobi 翻译";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "关闭";
  close.addEventListener("click", () => host.remove());
  head.append(title, close);

  const body = document.createElement("div");
  body.className = "body";
  body.append(
    label("原文"),
    block(payload.sourceText || "", "text"),
    label("译文"),
    block(payload.targetText || "没有翻译结果", "text target"),
  );
  if (payload.phonetic) {
    body.append(block("/" + payload.phonetic + "/", "phonetic"));
  }
  const dictEl = dict(payload.dictionary);
  if (dictEl) {
    body.append(label("释义"), dictEl);
  }
  body.append(meta(payload));

  const actions = document.createElement("div");
  actions.className = "actions";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "primary";
  copy.textContent = "复制译文";
  copy.addEventListener("click", async () => {
    const ok = await copyText(payload.targetText || "");
    copy.textContent = ok ? "已复制" : "复制失败";
    setTimeout(() => (copy.textContent = "复制译文"), 1200);
  });
  actions.append(copy);

  card.append(head, body, actions);
  shadow.append(style, card);

  function label(text) {
    const p = document.createElement("p");
    p.className = "label";
    p.textContent = text;
    return p;
  }

  function block(text, className) {
    const p = document.createElement("p");
    p.className = className;
    p.textContent = text;
    return p;
  }

  function dict(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const wrap = document.createElement("dl");
    wrap.className = "dict";
    for (const e of entries) {
      const terms = Array.isArray(e.terms) ? e.terms : [];
      if (terms.length === 0) continue;
      const rowEl = document.createElement("div");
      rowEl.className = "dict-row";
      if (e.pos) {
        const dt = document.createElement("dt");
        dt.textContent = e.pos;
        rowEl.appendChild(dt);
      }
      const dd = document.createElement("dd");
      dd.textContent = terms.join("；");
      rowEl.appendChild(dd);
      wrap.appendChild(rowEl);
    }
    return wrap.children.length ? wrap : null;
  }

  function meta(data) {
    const row = document.createElement("div");
    row.className = "meta";
    const items = [];
    if (data.sourceLang || data.targetLang) {
      items.push(`${data.sourceLang || "auto"} -> ${data.targetLang || "zh-CN"}`);
    }
    if (data.provider) items.push(`provider: ${data.provider}`);
    if (Array.isArray(data.glossaryHits) && data.glossaryHits.length) {
      items.push(`术语命中: ${data.glossaryHits.length}`);
    }
    for (const item of items) {
      const pill = document.createElement("span");
      pill.className = "pill";
      pill.textContent = item;
      row.appendChild(pill);
    }
    return row;
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    }
  }
}

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
    message: truncateText(message || "", 420),
  });
}

function truncateText(text, max) {
  if (!text || text.length <= max) return text || "";
  return text.slice(0, max - 1) + "…";
}
