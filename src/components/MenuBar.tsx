import { useEffect, useState } from "react";
import type { Menu } from "../types";

/** PR/PS 式菜单栏：点击展开、悬停切换、点外关闭 */
export default function MenuBar({ menus }: { menus: Menu[] }) {
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    if (open === null) return;
    const close = () => setOpen(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [open]);
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
              {m.items.map((it, j) =>
                it.sep ? (
                  <div key={j} className="ctx-sep" />
                ) : (
                  <div
                    key={j}
                    className="ctx-item"
                    onClick={() => {
                      setOpen(null);
                      it.action?.();
                    }}
                  >
                    {it.label}
                  </div>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
