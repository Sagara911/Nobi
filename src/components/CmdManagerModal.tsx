import { useState } from "react";
import type { AiCmd } from "../types";
import * as api from "../api";

/** 自定义 AI 指令管理：添加 / 删除用户自己的看图 prompt */
export default function CmdManagerModal({
  cmds,
  onChanged,
  onClose,
}: {
  cmds: AiCmd[];
  onChanged: () => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [msg, setMsg] = useState("");

  async function add() {
    try {
      await api.saveAiCommand(name, prompt);
      setName("");
      setPrompt("");
      setMsg("已添加 ✓");
      onChanged();
    } catch (e) {
      setMsg(`${e}`);
    }
  }
  async function del(id: number) {
    await api.deleteAiCommand(id);
    onChanged();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>自定义 AI 指令</h3>
        <p className="dim">
          添加你自己的看图指令（如"分析透视结构""猜画师用了什么笔刷"），保存后出现在详情面板的 AI
          操作列表里。
        </p>
        {cmds.length > 0 && (
          <div className="cmd-list">
            {cmds.map((c) => (
              <div className="cmd-item" key={c.id}>
                <div className="cmd-info">
                  <b>{c.name}</b>
                  <span className="dim" title={c.prompt}>
                    {c.prompt}
                  </span>
                </div>
                <button className="btn" onClick={() => del(c.id)}>
                  删除
                </button>
              </div>
            ))}
          </div>
        )}
        <label>指令名称</label>
        <input
          className="cfg-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例：分析透视结构"
        />
        <label>指令内容（对这张图提的要求）</label>
        <textarea
          className="cfg-input"
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="例：用中文分析这张图的透视类型、视平线位置和消失点，并给出临摹练习建议。"
        />
        <div className="modal-actions">
          <span className="dim">{msg}</span>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
          <button className="btn primary" onClick={add}>
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
