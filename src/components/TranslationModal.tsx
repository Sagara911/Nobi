import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type {
  GlossaryTerm,
  TranslationHistoryItem,
  TranslationProvider,
  TranslationResult,
} from "../types";
import * as api from "../api";

const PROVIDERS: Array<{ key: TranslationProvider; label: string }> = [
  { key: "auto", label: "自动（在线优先）" },
  { key: "online", label: "在线翻译" },
  { key: "offline", label: "离线翻译" },
  { key: "model", label: "当前模型" },
];

export default function TranslationModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("Hello, I need to translate this sentence.");
  const [targetLang, setTargetLang] = useState("zh-CN");
  const mode = "normal";
  const [provider, setProvider] = useState<TranslationProvider>("auto");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TranslationResult | null>(null);
  const [msg, setMsg] = useState("");
  const [terms, setTerms] = useState<GlossaryTerm[]>([]);
  const [history, setHistory] = useState<TranslationHistoryItem[]>([]);
  const [termSource, setTermSource] = useState("");
  const [termTarget, setTermTarget] = useState("");
  const [termExplanation, setTermExplanation] = useState("");
  const [termCategory, setTermCategory] = useState("通用");
  const [nmt, setNmt] = useState<{ enZh: boolean; zhEn: boolean } | null>(null);
  const [nmtBusy, setNmtBusy] = useState(false);
  const [nmtProgress, setNmtProgress] = useState("");

  useEffect(() => {
    api.nmtStatus().then(setNmt).catch(() => {});
    const un = listen<{
      dir: string;
      file: string;
      index: number;
      totalFiles: number;
      downloaded: number;
      total: number;
    }>("nmt-download-progress", (e) => {
      const p = e.payload;
      const mb = (n: number) => (n / 1024 / 1024).toFixed(0);
      const pct = p.total ? ` ${Math.floor((p.downloaded / p.total) * 100)}%` : "";
      setNmtProgress(`${p.dir} ${p.file} (${p.index}/${p.totalFiles}) ${mb(p.downloaded)}MB${pct}`);
    });
    return () => {
      un.then((f) => f());
    };
  }, []);

  async function downloadNmt() {
    if (nmtBusy) return;
    setNmtBusy(true);
    setNmtProgress("准备下载…");
    try {
      await api.downloadNmtModels();
      setNmt(await api.nmtStatus());
      setNmtProgress("离线翻译包已就绪");
    } catch (e) {
      setNmtProgress(`下载失败：${e}`);
    } finally {
      setNmtBusy(false);
    }
  }

  async function refresh() {
    const [gs, hs] = await Promise.all([
      api.listGlossaryTerms().catch(() => []),
      api.listTranslationHistory(12).catch(() => []),
    ]);
    setTerms(gs);
    setHistory(hs);
  }

  useEffect(() => {
    refresh();
  }, []);

  const previewTerms = useMemo(() => terms.slice(0, 8), [terms]);

  async function run() {
    if (!text.trim()) {
      setMsg("先输入要翻译的文本");
      return;
    }
    setBusy(true);
    setMsg("");
    try {
      const r = await api.translateText({
        text,
        targetLang,
        mode,
        provider,
        sourceApp: "Nobi",
        saveHistory: true,
      });
      setResult(r);
      setMsg(r.warning ? "已使用离线兜底" : "完成");
      await refresh();
    } catch (e) {
      setMsg(`翻译失败：${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function addTerm() {
    if (!termSource.trim() || !termTarget.trim()) {
      setMsg("原文和译文不能为空");
      return;
    }
    try {
      await api.saveGlossaryTerm({
        source: termSource,
        target: termTarget,
        explanation: termExplanation,
        category: termCategory,
        tags: termCategory ? [termCategory] : [],
      });
      setTermSource("");
      setTermTarget("");
      setTermExplanation("");
      setMsg("词条已保存");
      await refresh();
    } catch (e) {
      setMsg(`保存词条失败：${e}`);
    }
  }

  async function removeTerm(id: number) {
    await api.deleteGlossaryTerm(id);
    await refresh();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal translation-modal" onClick={(e) => e.stopPropagation()}>
        <h3>翻译实验室</h3>
        <p className="dim">
          这是程序内翻译核心的测试入口。之后网页划词、全局快捷键、OCR 都会接到同一套引擎。
        </p>

        <div className="tr-grid">
          <section className="tr-main">
            <label>原文</label>
            <textarea
              className="cfg-input tr-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              placeholder="粘贴要翻译的文本"
            />

            <div className="tr-row">
              <div>
                <label>Provider</label>
                <select
                  className="cfg-input"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as TranslationProvider)}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label>目标语言</label>
                <select
                  className="cfg-input"
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                >
                  <option value="zh-CN">中文</option>
                  <option value="en">English</option>
                  <option value="ja">日本语</option>
                  <option value="ko">한국어</option>
                </select>
              </div>
            </div>

            <div className="tr-actions">
              <button className="btn primary" onClick={run} disabled={busy}>
                {busy ? "翻译中..." : "运行翻译"}
              </button>
              {result && (
                <button
                  className="btn"
                  onClick={() => navigator.clipboard.writeText(result.targetText)}
                >
                  复制结果
                </button>
              )}
              <span className="dim">{msg}</span>
            </div>

            {result && (
              <div className="tr-result">
                <div className="tr-result-head">
                  <span>{result.provider}</span>
                  <span>
                    {result.sourceLang} → {result.targetLang}
                  </span>
                </div>
                {result.phonetic && <div className="tr-phonetic">/{result.phonetic}/</div>}
                <pre>{result.targetText}</pre>
                {result.dictionary && result.dictionary.length > 0 && (
                  <dl className="tr-dict">
                    {result.dictionary.map((d) => (
                      <div className="tr-dict-row" key={d.pos || d.terms.join(",")}>
                        {d.pos && <dt>{d.pos}</dt>}
                        <dd>{d.terms.join("；")}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {result.warning && <div className="warn-text">Provider 警告：{result.warning}</div>}
                {result.usedGlossary.length > 0 && (
                  <div className="tr-hit-list">
                    {result.usedGlossary.map((h) => (
                      <span className="tr-hit" key={`${h.source}-${h.target}`}>
                        {h.source} = {h.target}
                      </span>
                    ))}
                  </div>
                )}
                {result.keywords.length > 0 && (
                  <div className="tr-hit-list">
                    {result.keywords.map((k) => (
                      <span className="tag" key={k}>
                        {k}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>

          <aside className="tr-side">
            <h4>离线翻译包</h4>
            <div className="tr-nmt">
              <div className="dim">
                整句离线翻译（中英互译，约 220MB）。装好后断网、无本地模型也能翻句子。
              </div>
              {nmt && (
                <div className="tr-nmt-status">
                  英→中 {nmt.enZh ? "✓ 已装" : "✗ 未装"} ・ 中→英 {nmt.zhEn ? "✓ 已装" : "✗ 未装"}
                </div>
              )}
              {nmt && (!nmt.enZh || !nmt.zhEn) && (
                <button className="btn" onClick={downloadNmt} disabled={nmtBusy}>
                  {nmtBusy ? "下载中…" : "下载离线翻译包"}
                </button>
              )}
              {nmtProgress && <div className="dim tr-nmt-progress">{nmtProgress}</div>}
            </div>

            <h4>自定义词库</h4>
            <div className="tr-term-form">
              <input
                className="cfg-input"
                value={termSource}
                onChange={(e) => setTermSource(e.target.value)}
                placeholder="hello"
              />
              <input
                className="cfg-input"
                value={termTarget}
                onChange={(e) => setTermTarget(e.target.value)}
                placeholder="你好"
              />
              <input
                className="cfg-input"
                value={termCategory}
                onChange={(e) => setTermCategory(e.target.value)}
                placeholder="分类"
              />
              <textarea
                className="cfg-input"
                value={termExplanation}
                onChange={(e) => setTermExplanation(e.target.value)}
                placeholder="解释"
                rows={2}
              />
              <button className="btn" onClick={addTerm}>
                保存词条
              </button>
            </div>

            <div className="tr-terms">
              {previewTerms.length === 0 && <div className="dim">还没有自定义词条</div>}
              {previewTerms.map((t) => (
                <div className="tr-term" key={t.id}>
                  <div>
                    <b>{t.source}</b>
                    <span>{t.target}</span>
                  </div>
                  <button className="btn link" onClick={() => removeTerm(t.id)}>
                    删除
                  </button>
                </div>
              ))}
            </div>

            <h4>历史</h4>
            <div className="tr-history">
              {history.length === 0 && <div className="dim">暂无历史</div>}
              {history.map((h) => (
                <button
                  className="tr-history-item"
                  key={h.id}
                  onClick={() => {
                    setText(h.sourceText);
                    setResult({
                      id: h.id,
                      sourceText: h.sourceText,
                      targetText: h.targetText,
                      sourceLang: h.sourceLang,
                      targetLang: h.targetLang,
                      mode: h.mode,
                      provider: h.provider,
                      usedGlossary: [],
                      keywords: [],
                    });
                  }}
                >
                  <span>{h.sourceText}</span>
                  <small>{new Date(h.createdAt * 1000).toLocaleString()}</small>
                </button>
              ))}
            </div>
          </aside>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
