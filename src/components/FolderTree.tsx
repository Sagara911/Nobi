import { useState } from "react";
import type { FolderNode } from "../types";

/** 文件夹目录树：按层级可折叠；每个节点可点(筛选其下所有素材)、可级联删除(连子文件夹)。 */
export default function FolderTree({
  nodes,
  isActive,
  onPick,
  onDelete,
  pendingDel,
  setPendingDel,
}: {
  nodes: FolderNode[];
  isActive: (path: string) => boolean;
  onPick: (path: string) => void;
  onDelete: (path: string) => void;
  pendingDel: string | null;
  setPendingDel: (p: string | null) => void;
}) {
  // 默认展开第一层根节点，方便一眼看到导入的大文件夹下有什么
  const [open, setOpen] = useState<Set<string>>(() => new Set(nodes.map((n) => n.path)));
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const render = (node: FolderNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const isOpen = open.has(node.path);
    const pend = pendingDel === node.path;
    return (
      <div key={node.path}>
        <div
          className={"nav-item folder-node" + (isActive(node.path) ? " active" : "")}
          style={{ paddingLeft: 8 + depth * 14 }}
          title={node.path}
        >
          {hasChildren ? (
            <span
              className="chev"
              onClick={(e) => {
                e.stopPropagation();
                toggle(node.path);
              }}
            >
              {isOpen ? "▾" : "▸"}
            </span>
          ) : (
            <span className="chev placeholder">·</span>
          )}
          <span className="ellip" onClick={() => onPick(node.path)}>
            {node.label}
          </span>
          <span className="count">{node.total}</span>
          <button
            className={"folder-del" + (pend ? " confirm" : "")}
            title={
              pend
                ? "再点一次确认移除（连同所有子文件夹，不删原文件）"
                : hasChildren
                  ? "从库移除该文件夹及其所有子文件夹（不删原文件）"
                  : "从库移除该文件夹（不删原文件）"
            }
            onClick={(e) => {
              e.stopPropagation();
              if (pend) {
                setPendingDel(null);
                onDelete(node.path);
              } else {
                setPendingDel(node.path);
              }
            }}
          >
            {pend ? "❗" : "✕"}
          </button>
        </div>
        {hasChildren && isOpen && node.children.map((c) => render(c, depth + 1))}
      </div>
    );
  };

  return <>{nodes.map((n) => render(n, 0))}</>;
}
