import { useMemo, useState } from "react";

/** 层级标签树：按 "/" 分组，可展开折叠 */
export default function TagTree({
  tags,
  isActive,
  onPick,
}: {
  tags: [string, number][];
  isActive: (v: string) => boolean;
  onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const m = new Map<
      string,
      { selfCount: number; children: { full: string; leaf: string; count: number }[] }
    >();
    for (const [name, count] of tags) {
      const top = name.includes("/") ? name.slice(0, name.indexOf("/")) : name;
      if (!m.has(top)) m.set(top, { selfCount: 0, children: [] });
      const g = m.get(top)!;
      if (name.includes("/"))
        g.children.push({ full: name, leaf: name.slice(top.length + 1), count });
      else g.selfCount += count;
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [tags]);

  if (tags.length === 0)
    return <div className="nav-item child dim">（暂无，选中图片后可打标签）</div>;

  return (
    <>
      {groups.map(([top, g]) => {
        const hasChildren = g.children.length > 0;
        const isOpen = open.has(top);
        const total = g.selfCount + g.children.reduce((s, c) => s + c.count, 0);
        return (
          <div key={top}>
            <div className={"nav-item child" + (isActive(top) ? " active" : "")}>
              {hasChildren ? (
                <span
                  className="chev"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpen((p) => {
                      const n = new Set(p);
                      if (n.has(top)) n.delete(top);
                      else n.add(top);
                      return n;
                    });
                  }}
                >
                  {isOpen ? "▾" : "▸"}
                </span>
              ) : (
                <span className="chev placeholder">·</span>
              )}
              <span className="ellip" onClick={() => onPick(top)}>
                {top}
              </span>
              <span className="count">{total}</span>
            </div>
            {hasChildren &&
              isOpen &&
              g.children.map((c) => (
                <div
                  key={c.full}
                  className={"nav-item grandchild" + (isActive(c.full) ? " active" : "")}
                  onClick={() => onPick(c.full)}
                >
                  <span className="ellip">{c.leaf}</span>
                  <span className="count">{c.count}</span>
                </div>
              ))}
          </div>
        );
      })}
    </>
  );
}
