import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SelectionTranslatePayload, TranslationResult } from "../types";
import * as api from "../api";
import {
  SELECTION_TRANSLATE_BUSY_SIZE,
  SELECTION_TRANSLATE_CHIP_SIZE,
  SELECTION_TRANSLATE_PANEL_SIZE,
  selectionTranslateAnchoredPosition,
  selectionTranslatePanelSize,
} from "../selectionTranslatePosition";
import "./SelectionTranslateWindow.css";

const STORAGE_KEY = "nobi.selectionTranslate.payload";

type WindowPayload = SelectionTranslatePayload & {
  openPanel?: boolean;
};

type ScreenClickPayload = {
  x: number;
  y: number;
};

function readInitialPayload(): WindowPayload | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as WindowPayload) : null;
  } catch {
    return null;
  }
}

function snippet(text: string, max = 96) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export default function SelectionTranslateWindow() {
  const [payload, setPayload] = useState<WindowPayload | null>(() => readInitialPayload());
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [message, setMessage] = useState("");

  const win = () => getCurrentWebviewWindow();
  const text = payload?.text.trim() || "";
  const preview = useMemo(() => snippet(text), [text]);

  useEffect(() => {
    const un = listen<WindowPayload>("selection-translate-payload", (e) => {
      setPayload(e.payload);
      setExpanded(!!e.payload.openPanel);
      setResult(null);
      setMessage("");
      setBusy(false);
      void win().setSize(
        e.payload.openPanel
          ? selectionTranslatePanelSize({ sourceText: e.payload.text })
          : SELECTION_TRANSLATE_CHIP_SIZE,
      );
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      void closeWindow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (expanded || !text) return;
    const timer = window.setTimeout(() => void closeWindow(), 3200);
    return () => window.clearTimeout(timer);
  }, [expanded, text]);

  useEffect(() => {
    if (expanded) return;

    const un = listen<ScreenClickPayload>("selection-translate-left-clicked", async (e) => {
      const current = win();
      const pos = await current.outerPosition().catch(() => null);
      if (!pos) return;

      const { x, y } = e.payload;
      const inside =
        x >= pos.x &&
        x <= pos.x + SELECTION_TRANSLATE_CHIP_SIZE.width &&
        y >= pos.y &&
        y <= pos.y + SELECTION_TRANSLATE_CHIP_SIZE.height;
      if (!inside) void closeWindow();
    });

    return () => {
      un.then((f) => f());
    };
  }, [expanded]);

  useEffect(() => {
    if (!expanded) return;

    let unlisten: (() => void) | undefined;
    void win()
      .onFocusChanged((e) => {
        if (e.payload) return;
        window.setTimeout(() => {
          void win()
            .isFocused()
            .then((focused) => {
              if (!focused) void closeWindow();
            })
            .catch(() => {});
        }, 120);
      })
      .then((un) => {
        unlisten = un;
      });

    return () => {
      unlisten?.();
    };
  }, [expanded]);

  async function closeWindow() {
    const current = win();
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    await api.closeSelectionTranslateWindow().catch(async () => {
      await current.hide().catch(() => {});
      await current.close().catch(() => {});
    });
  }

  function startDrag(e: React.PointerEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button")) return;
    void win().startDragging();
  }

  async function placeWindow(size = SELECTION_TRANSLATE_PANEL_SIZE) {
    const current = win();
    const anchor = await current.outerPosition().catch(() => null);
    if (!anchor) return;
    await current
      .setPosition(await selectionTranslateAnchoredPosition(anchor.x, anchor.y, size))
      .catch(() => {});
  }

  async function runTranslate() {
    if (!text || busy) return;
    setBusy(true);
    setMessage("");
    setResult(null);
    await placeWindow(SELECTION_TRANSLATE_BUSY_SIZE);
    await win().setSize(SELECTION_TRANSLATE_BUSY_SIZE).catch(() => {});
    try {
      const r = await api.translateText({
        text,
        targetLang: "auto",
        mode: "normal",
        provider: "auto",
        sourceApp: payload?.sourceApp || "system-selection",
        saveHistory: true,
      });
      setResult(r);
      const nextMessage =
        r.provider === "offline-fallback"
          ? "在线翻译不可用，已使用离线基础翻译。"
          : r.warning || "";
      setMessage(nextMessage);
      const nextSize = selectionTranslatePanelSize({
        sourceText: text,
        targetText: r.targetText,
        message: nextMessage,
        terms: r.usedGlossary.length,
        dictRows: (r.dictionary?.length ?? 0) + (r.phonetic ? 1 : 0),
      });
      await placeWindow(nextSize);
      await win().setSize(nextSize).catch(() => {});
    } catch (e) {
      const nextMessage = `翻译服务不可用：${e}`;
      setMessage(nextMessage);
      const nextSize = selectionTranslatePanelSize({ sourceText: text, message: nextMessage });
      await placeWindow(nextSize);
      await win().setSize(nextSize).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function expandAndTranslate() {
    if (!text || busy) return;
    setExpanded(true);
    await placeWindow(SELECTION_TRANSLATE_BUSY_SIZE);
    await win().setSize(SELECTION_TRANSLATE_BUSY_SIZE).catch(() => {});
    await win().setFocus().catch(() => {});
    void runTranslate();
  }

  async function copyResult() {
    if (!result?.targetText) return;
    await navigator.clipboard.writeText(result.targetText);
    setMessage("已复制译文");
  }

  if (!expanded) {
    return (
      <main className="stw-shell compact">
        <button className="stw-chip" onClick={() => void expandAndTranslate()} title="翻译选中文本">
          <span className="stw-chip-icon">译</span>
          <span>翻译</span>
        </button>
      </main>
    );
  }

  return (
    <main className="stw-shell expanded">
      <section className="stw-card">
        <div className="stw-head" data-tauri-drag-region onPointerDown={startDrag}>
          <span>Nobi 翻译</span>
          <button
            className="stw-icon-btn"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void closeWindow();
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void closeWindow();
            }}
            title="关闭"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="stw-body">
          {!text ? (
            <div className="stw-empty">没有读到选中文字</div>
          ) : (
            <>
              <p className="stw-preview">{preview}</p>

              {!result && (
                <button className="stw-primary" onClick={runTranslate} disabled={busy}>
                  {busy ? "翻译中..." : "Nobi 翻译"}
                </button>
              )}

              {result && (
                <div className="stw-result">
                  <div className="stw-meta">
                    <span>
                      {result.sourceLang} → {result.targetLang}
                    </span>
                    <span>{result.provider}</span>
                  </div>
                  {result.phonetic && <p className="stw-phonetic">/{result.phonetic}/</p>}
                  <p>{result.targetText}</p>
                  {result.dictionary && result.dictionary.length > 0 && (
                    <dl className="stw-dict">
                      {result.dictionary.map((d) => (
                        <div className="stw-dict-row" key={d.pos || d.terms.join(",")}>
                          {d.pos && <dt>{d.pos}</dt>}
                          <dd>{d.terms.join("；")}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {result.usedGlossary.length > 0 && (
                    <div className="stw-terms">
                      {result.usedGlossary.slice(0, 4).map((h) => (
                        <span key={`${h.source}-${h.target}`}>
                          {h.source} = {h.target}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="stw-actions">
                    <button onClick={runTranslate} disabled={busy}>
                      重译
                    </button>
                    <button className="stw-primary small" onClick={copyResult}>
                      复制译文
                    </button>
                  </div>
                </div>
              )}

              {message && <div className="stw-message">{message}</div>}
            </>
          )}
        </div>
      </section>
    </main>
  );
}
