import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import type { AiCfg, AiStatus } from "../types";
import * as api from "../api";

const AI_PRESETS: Record<string, AiCfg> = {
  "本地 Ollama (Gemma 4)": {
    aiBase: "http://localhost:11434/v1",
    aiModel: "gemma4:12b",
    aiKey: "ollama",
    embedModel: "bge-m3",
  },
  DeepSeek: {
    aiBase: "https://api.deepseek.com/v1",
    aiModel: "deepseek-vl2",
    aiKey: "",
    embedModel: "bge-m3",
  },
  OpenAI: {
    aiBase: "https://api.openai.com/v1",
    aiModel: "gpt-4o-mini",
    aiKey: "",
    embedModel: "text-embedding-3-small",
  },
};

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState<AiCfg>({ aiBase: "", aiModel: "", aiKey: "", embedModel: "" });
  const [saved, setSaved] = useState("");
  const [st, setSt] = useState<AiStatus | null>(null);
  const [pulling, setPulling] = useState(false);
  const [pullPct, setPullPct] = useState(0);
  const [pullMsg, setPullMsg] = useState("");
  const [pullName, setPullName] = useState("gemma4:12b");
  const [extMsg, setExtMsg] = useState("");

  const refreshStatus = useCallback(async () => {
    try {
      setSt(await api.aiStatus());
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    api.getSettings().then(setF).catch(() => {});
    refreshStatus();
  }, [refreshStatus]);

  async function doPull() {
    setPulling(true);
    setPullPct(0);
    setPullMsg("开始下载…");
    const un = await listen<{ status?: string; percent?: number }>("pull-progress", (e) => {
      const p = e.payload;
      if (typeof p.percent === "number" && p.percent >= 0) setPullPct(p.percent);
      if (p.status) setPullMsg(p.status);
    });
    try {
      await api.pullModel(pullName);
      setPullMsg("下载完成 ✓");
      await refreshStatus();
    } catch (e) {
      setPullMsg(`失败：${e}`);
    } finally {
      un();
      setPulling(false);
    }
  }

  async function save() {
    try {
      await api.setSettings(f);
      setSaved("已保存 ✓");
      setTimeout(onClose, 600);
    } catch (e) {
      setSaved(`保存失败：${e}`);
    }
  }

  async function exportExt() {
    try {
      const dir = await api.exportExtension();
      await openPath(dir);
      setExtMsg("插件文件夹已导出并打开 ✓ 按下面步骤在浏览器加载");
    } catch (e) {
      setExtMsg(`导出失败：${e}`);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>AI 设置</h3>
        <p className="dim">
          选本地 Ollama（装了 Gemma 就用），或填你自己的 OpenAI 兼容 API（DeepSeek / GPT
          等）。留空项回退默认。
        </p>

        <div className="ai-status">
          {!st ? (
            <span className="dim">检测本地 AI…</span>
          ) : !st.ollama ? (
            <div className="status-row">
              <span className="warn-text">⚠ 未检测到 Ollama（本地 Gemma 需要它）</span>
              <button className="btn" onClick={() => openUrl("https://ollama.com/download")}>
                获取 Ollama
              </button>
              <button className="btn link" onClick={refreshStatus}>
                重新检测
              </button>
            </div>
          ) : st.modelPresent ? (
            <span className="ok-text">✓ 本地 AI 就绪（{st.model}）</span>
          ) : (
            <div className="status-row col">
              <span className="dim">已检测到 Ollama，但未下载模型</span>
              <div className="status-row">
                <select
                  className="cfg-input"
                  style={{ flex: 1 }}
                  value={pullName}
                  onChange={(e) => setPullName(e.target.value)}
                  disabled={pulling}
                >
                  <option value="gemma4:12b">gemma4:12b（推荐，~7.6GB）</option>
                  <option value="gemma4:e4b">gemma4:e4b（轻量，~9.6GB）</option>
                </select>
                <button className="btn primary" onClick={doPull} disabled={pulling}>
                  {pulling ? `下载中 ${pullPct}%` : "一键下载 Gemma 4"}
                </button>
              </div>
              {pulling && (
                <div className="pull-bar">
                  <div className="pull-fill" style={{ width: `${pullPct}%` }} />
                </div>
              )}
              {pulling && <div className="dim">{pullMsg}</div>}
            </div>
          )}
        </div>

        <label>快速预设</label>
        <select
          className="cfg-input"
          defaultValue=""
          onChange={(e) => {
            const p = AI_PRESETS[e.target.value];
            if (p) setF((prev) => ({ ...prev, ...p }));
          }}
        >
          <option value="">— 选择预设 —</option>
          {Object.keys(AI_PRESETS).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label>API 地址 (Base URL)</label>
        <input
          className="cfg-input"
          value={f.aiBase}
          onChange={(e) => setF({ ...f, aiBase: e.target.value })}
          placeholder="http://localhost:11434/v1"
        />
        <label>视觉 / 对话模型</label>
        <input
          className="cfg-input"
          value={f.aiModel}
          onChange={(e) => setF({ ...f, aiModel: e.target.value })}
          placeholder="gemma4:12b"
        />
        <label>API Key</label>
        <input
          className="cfg-input"
          type="password"
          value={f.aiKey}
          onChange={(e) => setF({ ...f, aiKey: e.target.value })}
          placeholder="本地 Ollama 随便填；云端填你的 key"
        />
        <label>嵌入模型（语义搜索用）</label>
        <input
          className="cfg-input"
          value={f.embedModel}
          onChange={(e) => setF({ ...f, embedModel: e.target.value })}
          placeholder="bge-m3"
        />

        <div className="ext-section">
          <h4>浏览器采集插件</h4>
          <p className="dim">
            在网页<b>右键图片 → 「保存到 Nobi」</b>，图片连同来源出处一起入库。安装一次即可：
          </p>
          <ol className="ext-steps dim">
            <li>点下方按钮，导出并打开插件文件夹</li>
            <li>
              浏览器打开 <code>chrome://extensions</code>（Edge 为 <code>edge://extensions</code>
              ），右上角开启「开发者模式」
            </li>
            <li>点「加载已解压的扩展程序」→ 选刚打开的文件夹</li>
            <li>保持 Nobi 运行，去任意网页右键图片即可采集</li>
          </ol>
          <div className="status-row">
            <button className="btn primary" onClick={exportExt}>
              导出并打开插件文件夹
            </button>
            <span className="dim">{extMsg}</span>
          </div>
        </div>

        <div className="modal-actions">
          <span className="dim">{saved}</span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
