// 素材保存路径设置（编辑→素材保存路径）。粘贴/拖入/从画板存的素材落到这里。
import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";

export default function SavePathModal({ onClose }: { onClose: () => void }) {
  const [dir, setDir] = useState("");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    api.getImportDir().then(setDir).catch(() => {});
  }, []);

  const pick = async () => {
    const picked = await openDialog({ directory: true, title: "选择素材保存路径" }).catch(() => null);
    if (typeof picked === "string") {
      await api.setImportDir(picked).catch(() => {});
      setDir(await api.getImportDir().catch(() => picked));
      setMsg("已更新 ✓");
    }
  };
  const reset = async () => {
    await api.setImportDir("").catch(() => {});
    setDir(await api.getImportDir().catch(() => ""));
    setMsg("已恢复默认 ✓");
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 460, maxWidth: "92vw" }}>
        <h3>素材保存路径</h3>
        <p className="dim">
          粘贴 / 拖入 / 从画板保存的素材都放到这个文件夹（默认 <code>图片\Nobi</code>）。
          改路径只影响以后新存的，已有文件不动。
        </p>
        <div className="status-row">
          <input className="cfg-input" style={{ flex: 1 }} value={dir} readOnly title={dir} />
          <button className="btn primary" onClick={pick}>选择文件夹</button>
          <button className="btn link" onClick={reset}>恢复默认</button>
        </div>
        <div className="modal-actions">
          <span className="dim">{msg}</span>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
