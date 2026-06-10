import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { AiCmd, Asset } from "../types";
import { humanSize, isVideo } from "../utils";

export default function Inspector({
  asset,
  onAddTag,
  onRemoveTag,
  onAi,
  aiBusy,
  aiResult,
  onSimilar,
  onAddBoard,
  onFav,
  cmds,
  onAiCustom,
  onManageCmds,
}: {
  asset: Asset | null;
  onAddTag: (id: number, tag: string) => void;
  onRemoveTag: (id: number, tag: string) => void;
  onAi: (id: number, mode: string) => void;
  aiBusy: string | null;
  aiResult: string;
  onSimilar: (id: number) => void;
  onAddBoard: (id: number) => void;
  onFav: (id: number, fav: boolean) => void;
  cmds: AiCmd[];
  onAiCustom: (id: number, cmd: AiCmd) => void;
  onManageCmds: () => void;
}) {
  const [tagInput, setTagInput] = useState("");
  if (!asset) {
    return (
      <section className="inspector">
        <div className="empty">从网格中选择一张素材查看详情</div>
      </section>
    );
  }
  return (
    <section className="inspector">
      {isVideo(asset) ? (
        <video className="preview" src={convertFileSrc(asset.path)} controls muted loop />
      ) : (
        <img className="preview" src={convertFileSrc(asset.path)} alt={asset.name} />
      )}
      <h3 title={asset.name}>
        <button
          className={"fav-btn inline" + (asset.favorite ? " on" : "")}
          title={asset.favorite ? "取消收藏" : "收藏"}
          onClick={() => onFav(asset.id, !asset.favorite)}
        >
          ★
        </button>{" "}
        {asset.name}
      </h3>
      <div className="dim">
        {asset.format} · {asset.width}×{asset.height} · {humanSize(asset.sizeBytes)}
      </div>

      <div className="section">
        <h5>来源</h5>
        <div className="dim">
          {asset.source || "—"}
          {asset.author ? ` · 作者 ${asset.author}` : ""}
        </div>
        <div className="dim path" title={asset.path}>
          {asset.path}
        </div>
      </div>

      <div className="section">
        <h5>标签</h5>
        <div className="tags">
          {asset.tags.map((t) => (
            <span className="tag removable" key={t} onClick={() => onRemoveTag(asset.id, t)}>
              {t} <span className="x">×</span>
            </span>
          ))}
        </div>
        <input
          className="tag-input"
          placeholder="添加标签后回车（可用 / 分层，如 场景/夜景）"
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && tagInput.trim()) {
              onAddTag(asset.id, tagInput.trim());
              setTagInput("");
            }
          }}
        />
      </div>

      <div className="section">
        <h5>配色</h5>
        <div className="palette">
          {asset.colors.length === 0 ? (
            <span className="dim">—</span>
          ) : (
            asset.colors.map((c, i) => (
              <div className="swatch" key={c + i} style={{ background: c }} title={c} />
            ))
          )}
        </div>
      </div>

      <div className="section">
        <h5>AI 操作</h5>
        <div className="ai-actions">
          <button className="ai-btn" disabled={!!aiBusy} onClick={() => onAi(asset.id, "prompt")}>
            {aiBusy === "prompt" ? "生成中…" : "反推绘画提示词"}
            <span className="hint">从这张图生成 SD/MJ 提示词</span>
          </button>
          <button className="ai-btn" disabled={!!aiBusy} onClick={() => onAi(asset.id, "tags")}>
            {aiBusy === "tags" ? "识别中…" : "自动打标签"}
            <span className="hint">Gemma 看图生成标签并写入</span>
          </button>
          <button className="ai-btn" disabled={!!aiBusy} onClick={() => onAi(asset.id, "describe")}>
            {aiBusy === "describe" ? "分析中…" : "分析画面"}
            <span className="hint">打光 / 构图 / 配色拉片</span>
          </button>
          <button className="ai-btn" onClick={() => onSimilar(asset.id)}>
            找相似<span className="hint">语义向量检索视觉/题材近似</span>
          </button>
          <button className="ai-btn" onClick={() => onAddBoard(asset.id)}>
            加入参考板<span className="hint">摊到无限画布上对着画</span>
          </button>
          {cmds.map((c) => (
            <button
              key={c.id}
              className="ai-btn"
              disabled={!!aiBusy}
              onClick={() => onAiCustom(asset.id, c)}
            >
              {aiBusy === `c${c.id}` ? "执行中…" : c.name}
              <span className="hint">自定义指令</span>
            </button>
          ))}
          <button className="ai-btn manage" onClick={onManageCmds}>
            ＋ 自定义指令<span className="hint">添加你自己的看图 prompt</span>
          </button>
        </div>
        {aiResult && (
          <div className="ai-result-wrap">
            <pre className="ai-result">{aiResult}</pre>
            <button className="btn copy" onClick={() => navigator.clipboard.writeText(aiResult)}>
              复制
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
