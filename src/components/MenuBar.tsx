import { useEffect, useState } from "react";
import type { Menu, MenuItem } from "../types";

/** PR/PS 式菜单栏：点击展开、悬停切换、点外关闭；item.sub = 二级悬停飞出 */
export default function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const [sub, setSub] = useState<number | null>(null); // 当前飞出的二级项下标
  useEffect(() => {
    if (open === null) return;
    const close = () => setOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
  useEffect(() => setSub(null), [open]);

  const renderItem = (it: MenuItem, j: number, closeAll: () => void) => {
    if (it.sep) return <div key={j} className="ctx-sep" />;
    if (it.sub) {
      return (
        <div
          key={j}
          className="ctx-item has-sub"
          onMouseEnter={() => setSub(j)}
          onMouseLeave={() => setSub((v) => (v === j ? null : v))}
        >
          {it.label}
          <span className="sub-arrow">▸</span>
          {sub === j && (
            <div className="menu-drop menu-flyout">
              {it.sub.map((s, k) =>
                s.sep ? (
                  <div key={k} className="ctx-sep" />
                ) : (
                  <div
                    key={k}
                    className="ctx-item"
                    onClick={() => {
                      closeAll();
                      s.action?.();
                    }}
                  >
                    <span className="check">{s.checked ? "✓" : ""}</span>
                    {s.label}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      );
    }
    return (
      <div
        key={j}
        className="ctx-item"
        onMouseEnter={() => setSub(null)}
        onClick={() => {
          closeAll();
          it.action?.();
        }}
      >
        {it.label}
      </div>
    );
  };

  return (
    <div className="menubar">
      {menus.map((m, i) => (
        <div key={m.title} className="menu-wrap">
          <div
            className={"menubar-item" + (open === i ? " open" : "")}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(open === i ? null : i);
            }}
            onMouseEnter={() => {
              if (open !== null) setOpen(i);
            }}
          >
            {m.title}
          </div>
          {open === i && (
            <div className="menu-drop" onClick={(e) => e.stopPropagation()}>
              {m.items.map((it, j) => renderItem(it, j, () => setOpen(null)))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
