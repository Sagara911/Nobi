// 标签管理：全库重命名 / 合并 / 删除标签。AI 自动打标会堆长尾标签，这里批量整理。
import { useMemo, useState } from "react";

export default function TagManagerModal({
  tags,
  onRename,
  onDelete,
  onClose,
}: {
  tags: [string, number][];
  onRename: (from: string, to: string) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    const arr = kw ? tags.filter(([t]) => t.toLowerCase().includes(kw)) : tags;
    return [...arr].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [tags, q]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: "92vw" }}>
        <h3>标签管理 · {tags.length} 个</h3>
        <p className="dim">
          重命名会改写全库所有用到该标签的素材；改成一个已存在的标签即「合并」。删除只去掉标签，不删素材。
        </p>
        <input
          className="cfg-input"
          style={{ width: "100%", marginBottom: 8 }}
          placeholder="筛选标签…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div style={{ maxHeight: "50vh", overflow: "auto" }}>
          {list.length === 0 ? (
            <div className="dim" style={{ padding: 12 }}>没有匹配的标签</div>
          ) : (
            list.map(([name, count]) => (
              <div key={name} className="status-row" style={{ padding: "4px 0" }}>
                <span className="ellip" style={{ flex: 1 }} title={name}>
                  {name}
                </span>
                <span className="count" style={{ minWidth: 32, textAlign: "right" }}>{count}</span>
                <button
                  className="btn link"
                  onClick={() => {
                    const to = window.prompt(`把标签「${name}」重命名为（改成已有标签=合并）：`, name);
                    if (to && to.trim() && to.trim() !== name) onRename(name, to.trim());
                  }}
                >
                  重命名
                </button>
                <button
                  className="btn link"
                  onClick={() => {
                    if (window.confirm(`从全库删除标签「${name}」？（不删素材，仅去掉该标签）`))
                      onDelete(name);
                  }}
                >
                  删除
                </button>
              </div>
            ))
          )}
        </div>
        <div className="modal-actions">
          <span className="dim" />
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
