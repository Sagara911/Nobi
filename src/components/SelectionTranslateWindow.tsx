import { useEffect, useMemo, useState } from "react";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { SelectionTranslatePayload, TranslationResult } from "../types";
import * as api from "../api";
import "./SelectionTranslateWindow.css";

const STORAGE_KEY = "nobi.selectionTranslate.payload";

function readInitialPayload(): SelectionTranslatePayload | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SelectionTranslatePayload) : null;
  } catch {
    return null;
  }
}

function snippet(text: string, max = 96) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

export default function SelectionTranslateWindow() {
  const [payload, setPayload] = useState<SelectionTranslatePayload | null>(() =>
    readInitialPayload()
  );
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [message, setMessage] = useState("");

  const win = () => getCurrentWebviewWindow();
  const text = payload?.text.trim() || "";
  const preview = useMemo(() => snippet(text), [text]);

  useEffect(() => {
    const un = listen<SelectionTranslatePayload>("selection-translate-payload", (e) => {
      setPayload(e.payload);
      setResult(null);
      setMessage("");
      void win().setSize(new LogicalSize(360, 150));
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

  async function closeWindow() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    await win()
      .close()
      .catch(() => win().hide());
  }

  async function runTranslate() {
    if (!text || busy) return;
    setBusy(true);
    setMessage("");
    setResult(null);
    await win().setSize(new LogicalSize(400, 230)).catch(() => {});
    try {
      const r = await api.translateText({
        text,
        targetLang: "zh-CN",
        mode: "art_terms",
        provider: "auto",
        sourceApp: payload?.sourceApp || "system-selection",
        saveHistory: true,
      });
      setResult(r);
      setMessage(r.warning ? "已使用离线术语兜底" : "");
      await win().setSize(new LogicalSize(420, 330)).catch(() => {});
    } catch (e) {
      setMessage(`翻译失败：${e}`);
      await win().setSize(new LogicalSize(400, 230)).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  async function copyResult() {
    if (!result?.targetText) return;
    await navigator.clipboard.writeText(result.targetText);
    setMessage("已复制译文");
  }

  return (
    <main className="stw-shell">
      <section className="stw-card">
        <div className="stw-head" onPointerDown={() => void win().startDragging()}>
          <span>Nobi 翻译</span>
          <button
            className="stw-icon-btn"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
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
                  <p>{result.targetText}</p>
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
