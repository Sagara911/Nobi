// 首选项 · 快捷键（编辑→首选项）。集中改所有全局快捷键：
//   桌面工具（取色 / 参考窗穿透）· 聊天（老板键 / 透明度±）· 浏览窗（13 个）
// 各组都调既有的 get/set 命令，统一一个录键 UI（点改键→按新组合，冲突即拒）。
import { useEffect, useState } from "react";
import * as api from "../api";
import "./PreferencesModal.css";

// 加速键串（Alt+KeyC / Control+Alt+KeyR）→ 人话（Alt + C / Ctrl + Alt + R）
function fmtAccel(a: string): string {
  if (!a) return "（未设）";
  return a
    .split("+")
    .map((t) => {
      if (t === "Control") return "Ctrl";
      if (t === "Super") return "Win";
      if (/^Digit\d$/.test(t)) return t.slice(5);
      if (/^Key[A-Z]$/.test(t)) return t.slice(3);
      if (t === "Backquote") return "`";
      if (t === "Backslash") return "\\";
      if (t === "Space") return "Space";
      return t.replace(/^Arrow/, "");
    })
    .join(" + ");
}

const WEB_LABEL: Record<string, string> = {
  opacityDown: "变淡",
  opacityUp: "变浓",
  titlebar: "标题栏",
  through: "点击穿透",
  zoomOut: "页面缩小",
  zoomIn: "页面放大",
  nav: "地址栏 / 搜索",
  back: "网页后退",
  forward: "网页前进",
  mute: "静音",
  shot: "截图入库",
  dock: "贴角",
  boss: "老板键",
};

interface Row {
  id: string;
  label: string;
  accel: string;
  set: (a: string) => Promise<void>;
}
interface Group {
  title: string;
  items: Row[];
  onReset?: () => Promise<void>;
}

export default function PreferencesModal({ onClose }: { onClose: () => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [recording, setRecording] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");

  const reload = async () => {
    const [tool, boss, op, web, unlocked] = await Promise.all([
      api.toolGetKeys().catch(() => ["", ""]),
      api.chatGetBossKey().catch(() => ""),
      api.chatGetOpacityKeys().catch(() => ["", ""]),
      api.webGetKeys().catch(() => [] as [string, string][]),
      api.vaultGet().catch(() => false),
    ]);
    // 金库锁定时，连「聊天/浏览窗」的快捷键组也整组不显示——否则老板翻首选项就看出有这俩功能。
    // 「桌面工具」（取色/参考窗）不属隐藏功能，始终保留。
    const next: Group[] = [
      {
        title: "桌面工具",
        items: [
          { id: "tool-color", label: "取色器（吸管取屏幕色）", accel: tool[0] || "", set: (a) => api.toolSetKey("color", a) },
          { id: "tool-ref", label: "参考窗 · 点击穿透切换", accel: tool[1] || "", set: (a) => api.toolSetKey("ref", a) },
        ],
      },
    ];
    if (unlocked) {
      next.push(
        {
          title: "聊天（便签）",
          items: [
            { id: "chat-boss", label: "老板键（藏 / 显所有聊天窗）", accel: boss, set: (a) => api.chatSetBossKey(a) },
            { id: "chat-opd", label: "透明度 · 调淡", accel: op[0] || "", set: (a) => api.chatSetOpacityKey("down", a) },
            { id: "chat-opu", label: "透明度 · 调浓", accel: op[1] || "", set: (a) => api.chatSetOpacityKey("up", a) },
          ],
        },
        {
          title: "浏览窗（仅在浏览窗打开时生效）",
          items: web.map(([action, accel]) => ({
            id: `web-${action}`,
            label: WEB_LABEL[action] || action,
            accel,
            set: (a: string) => api.webSetKey(action, a),
          })),
          onReset: () => api.webResetKeys(),
        },
      );
    }
    setGroups(next);
  };

  useEffect(() => {
    void reload();
  }, []);

  // 录键：点改键后捕获下一个组合
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const mods: string[] = [];
      if (e.ctrlKey) mods.push("Control");
      if (e.altKey) mods.push("Alt");
      if (e.shiftKey) mods.push("Shift");
      if (e.metaKey) mods.push("Super");
      const accel = [...mods, e.code].join("+");
      const row = groups.flatMap((g) => g.items).find((r) => r.id === recording);
      setRecording(null);
      setErr("");
      setMsg("");
      if (!row) return;
      row
        .set(accel)
        .then(() => {
          setMsg(`「${row.label}」已改为 ${fmtAccel(accel)}`);
          void reload();
        })
        .catch((x) => setErr(String(x)));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, groups]);

  const doReset = (g: Group) => {
    if (!g.onReset) return;
    g.onReset()
      .then(() => {
        setErr("");
        setMsg(`已恢复「${g.title}」默认快捷键`);
        void reload();
      })
      .catch((x) => setErr(String(x)));
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal prefs-modal" onClick={(e) => e.stopPropagation()}>
        <h3>⌨ 首选项 · 快捷键</h3>
        <p className="modal-hint">
          点「改键」后按下新组合（Esc 取消）。已被别的软件全局占用的组合会被拒，换一个即可。
        </p>

        <div className="prefs-scroll">
          {groups.map((g) => (
            <div className="prefs-group" key={g.title}>
              <div className="prefs-group-head">
                <span className="prefs-group-title">{g.title}</span>
                {g.onReset && (
                  <button className="prefs-reset" onClick={() => doReset(g)}>恢复默认</button>
                )}
              </div>
              {g.items.map((r) => (
                <div className="prefs-row" key={r.id}>
                  <span className="prefs-row-label">{r.label}</span>
                  <input
                    className="prefs-row-accel"
                    readOnly
                    value={recording === r.id ? "按新组合…（Esc 取消）" : fmtAccel(r.accel)}
                  />
                  <button
                    onClick={() => {
                      setErr("");
                      setMsg("");
                      setRecording(r.id);
                    }}
                  >
                    改键
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        {err && <p className="prefs-err">{err}</p>}
        {msg && <p className="prefs-ok">{msg}</p>}
        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
