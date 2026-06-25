// 音频快剪台：主窗内的全屏工具浮层（仿 Audacity 的常用功能子集）。
// 纯 Web Audio：解码/播放/裁剪/效果/导出；改完可「另存为新素材」入库，不动原文件。
import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Asset } from "../types";
import * as api from "../api";
import * as dsp from "../audio/dsp";
import { bytesToB64 } from "../contactSheet";

export default function AudioEditor({
  asset,
  onClose,
  onSavedNew,
}: {
  asset: Asset | null; // null = 空白模式（可录音 / 提示右键音频素材）
  onClose: () => void;
  onSavedNew: () => void;
}) {
  const [buf, setBuf] = useState<AudioBuffer | null>(null);
  const [err, setErr] = useState("");
  const [status, setStatus] = useState("加载中…");
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null); // 采样下标，a<=b
  const [view, setView] = useState<{ start: number; spp: number } | null>(null); // 视窗起点 + 每像素采样数
  const [spectro, setSpectro] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);

  const bufRef = useRef<AudioBuffer | null>(null);
  useEffect(() => {
    bufRef.current = buf;
  }, [buf]);
  const undoRef = useRef<AudioBuffer[]>([]);
  const redoRef = useRef<AudioBuffer[]>([]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(900);
  const playRef = useRef<{ src: AudioBufferSourceNode; ctxStart: number; from: number } | null>(null);
  const headRef = useRef(0); // 当前播放头（采样）
  const rafRef = useRef(0);
  const dragRef = useRef<number | null>(null); // 选区拖拽起点采样

  // —— 加载并解码 ——
  useEffect(() => {
    if (!asset) {
      setStatus("空白：点「● 录音」开始，或关掉这里、右键某个音频素材来编辑");
      return;
    }
    let alive = true;
    (async () => {
      try {
        const resp = await fetch(convertFileSrc(asset.path));
        const bytes = await resp.arrayBuffer();
        const b = await dsp.decodeBytes(bytes);
        if (!alive) return;
        setBuf(b);
        setView({ start: 0, spp: Math.max(1, Math.ceil(b.length / width)) });
        setStatus(fmtInfo(b));
      } catch (e) {
        if (alive) setErr(`解码失败：${e}（此格式 WebView 可能不支持解码，可先转 wav/mp3）`);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset?.path]);

  // —— 容器宽度自适应 ——
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth - 4)));
    ro.observe(el);
    setWidth(Math.max(320, el.clientWidth - 4));
    return () => ro.disconnect();
  }, []);

  const stopPlay = useCallback(() => {
    if (playRef.current) {
      try {
        playRef.current.src.stop();
      } catch {
        /* already stopped */
      }
      playRef.current = null;
    }
    cancelAnimationFrame(rafRef.current);
    setPlaying(false);
  }, []);

  // 卸载清理
  useEffect(() => () => stopPlay(), [stopPlay]);

  // —— 绘制波形 / 频谱 / 选区 / 播放头 ——
  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv || !buf || !view) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width;
    const H = cv.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0e0e10";
    ctx.fillRect(0, 0, W, H);
    const viewLen = Math.min(buf.length - view.start, view.spp * W);

    if (spectro) {
      drawSpectro(ctx, buf, view.start, viewLen, W, H);
    } else {
      // 波形（取视窗段重算峰值到 W 桶）
      const seg = dsp.trim(buf, view.start, view.start + viewLen);
      const { min, max } = dsp.peaks(seg, W);
      ctx.strokeStyle = "#888";
      ctx.beginPath();
      ctx.moveTo(0, H / 2);
      ctx.lineTo(W, H / 2);
      ctx.stroke();
      ctx.fillStyle = "#e3b04b";
      for (let x = 0; x < W; x++) {
        const y1 = H / 2 - max[x] * (H / 2);
        const y2 = H / 2 - min[x] * (H / 2);
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    }

    // 选区
    if (sel) {
      const x1 = (sel.a - view.start) / view.spp;
      const x2 = (sel.b - view.start) / view.spp;
      ctx.fillStyle = "rgba(90,134,240,0.28)";
      ctx.fillRect(x1, 0, Math.max(1, x2 - x1), H);
    }
    // 播放头
    if (playing) {
      const x = (headRef.current - view.start) / view.spp;
      if (x >= 0 && x <= W) {
        ctx.strokeStyle = "#fff";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
    }
  }, [buf, view, sel, spectro, playing]);

  useEffect(() => {
    draw();
  }, [draw, width]);

  // —— 应用一次编辑（入撤销栈） ——
  const apply = useCallback(
    (next: AudioBuffer, msg?: string) => {
      if (bufRef.current) undoRef.current.push(bufRef.current);
      redoRef.current = [];
      setBuf(next);
      stopPlay();
      if (msg) setStatus(msg + " · " + fmtInfo(next));
    },
    [stopPlay],
  );

  const undo = () => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    if (bufRef.current) redoRef.current.push(bufRef.current);
    setBuf(prev);
    setSel(null);
    stopPlay();
    setStatus("已撤销");
  };
  const redo = () => {
    const nxt = redoRef.current.pop();
    if (!nxt) return;
    if (bufRef.current) undoRef.current.push(bufRef.current);
    setBuf(nxt);
    setSel(null);
    stopPlay();
    setStatus("已重做");
  };

  // —— 播放 ——
  const play = useCallback(() => {
    if (!buf) return;
    stopPlay();
    const actx = dsp.ac();
    const src = actx.createBufferSource();
    const fromSample = sel ? sel.a : 0;
    const toSample = sel ? sel.b : buf.length;
    if (sel && loop) {
      const seg = dsp.trim(buf, sel.a, sel.b);
      src.buffer = seg;
      src.loop = true;
    } else {
      src.buffer = buf;
    }
    src.connect(actx.destination);
    const offset = fromSample / buf.sampleRate;
    const dur = (toSample - fromSample) / buf.sampleRate;
    if (sel && loop) src.start(0, 0);
    else src.start(0, offset, dur);
    playRef.current = { src, ctxStart: actx.currentTime, from: fromSample };
    setPlaying(true);
    const tick = () => {
      const p = playRef.current;
      if (!p) return;
      const elapsed = (dsp.ac().currentTime - p.ctxStart) * buf.sampleRate;
      if (sel && loop) {
        const segLen = Math.max(1, sel.b - sel.a);
        headRef.current = sel.a + (elapsed % segLen);
      } else {
        headRef.current = p.from + elapsed;
        if (headRef.current >= toSample) {
          stopPlay();
          draw();
          return;
        }
      }
      draw();
      rafRef.current = requestAnimationFrame(tick);
    };
    src.onended = () => {
      if (!loop) stopPlay();
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [buf, sel, loop, stopPlay, draw]);

  // —— 鼠标选区 ——
  const xToSample = (clientX: number) => {
    const cv = canvasRef.current;
    if (!cv || !view) return 0;
    const rect = cv.getBoundingClientRect();
    const x = clientX - rect.left;
    return Math.round(view.start + x * view.spp);
  };
  const onDown = (e: React.MouseEvent) => {
    if (!buf) return;
    const s = clamp(xToSample(e.clientX), 0, buf.length);
    dragRef.current = s;
    setSel({ a: s, b: s });
  };
  const onMove = (e: React.MouseEvent) => {
    if (dragRef.current == null || !buf) return;
    const s = clamp(xToSample(e.clientX), 0, buf.length);
    const a = Math.min(dragRef.current, s);
    const b = Math.max(dragRef.current, s);
    setSel({ a, b });
  };
  const onUp = () => {
    if (dragRef.current != null && sel && sel.b - sel.a < 4) setSel(null); // 单击=清选区
    dragRef.current = null;
  };

  const zoom = (factor: number) => {
    if (!buf || !view) return;
    const center = view.start + (view.spp * width) / 2;
    const spp = clamp(view.spp * factor, 1, Math.ceil(buf.length / width) || 1);
    const start = clamp(Math.round(center - (spp * width) / 2), 0, Math.max(0, buf.length - spp * width));
    setView({ start, spp });
  };
  const selAll = () => buf && setSel({ a: 0, b: buf.length });

  // —— 效果（带 busy） ——
  const run = async (label: string, fn: () => AudioBuffer | Promise<AudioBuffer>) => {
    if (!buf) return;
    setBusy(true);
    setStatus(`${label}…`);
    try {
      const next = await fn();
      apply(next, label);
    } catch (e) {
      setStatus(`${label}失败：${e}`);
    } finally {
      setBusy(false);
    }
  };
  const S = () => (buf ? (sel ?? { a: 0, b: buf.length }) : { a: 0, b: 0 });
  const needSel = () => {
    if (!sel) {
      setStatus("先在波形上拖出一段选区");
      return false;
    }
    return true;
  };

  // —— 导出 / 入库 ——
  const exportFile = async (kind: "wav" | "mp3") => {
    if (!buf) return;
    try {
      setBusy(true);
      const path = await saveDialog({
        defaultPath: `${asset ? baseName(asset.name) : "录音"}.${kind}`,
        filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
      });
      if (!path) return;
      const bytes = kind === "wav" ? dsp.encodeWav(buf) : dsp.encodeMp3(buf);
      await api.saveFile(path, bytesToB64(bytes));
      setStatus(`已导出 → ${path}`);
    } catch (e) {
      setStatus(`导出失败：${e}`);
    } finally {
      setBusy(false);
    }
  };
  const saveAsNew = async (kind: "wav" | "mp3") => {
    if (!buf) return;
    try {
      setBusy(true);
      setStatus("另存为新素材…");
      const bytes = kind === "wav" ? dsp.encodeWav(buf) : dsp.encodeMp3(buf);
      const name = `${asset ? baseName(asset.name) : "录音"}_edit.${kind}`;
      await api.importBlob(name, bytesToB64(bytes));
      setStatus(`已存为新素材：${name}`);
      onSavedNew();
    } catch (e) {
      setStatus(`另存失败：${e}`);
    } finally {
      setBusy(false);
    }
  };
  // 把当前波形设成该音频资产的封面（库里浏览更直观）
  const setCover = async () => {
    if (!buf) return;
    if (!asset) {
      setStatus("空白模式没有关联素材，先「另存为素材」再设封面");
      return;
    }
    try {
      const off = document.createElement("canvas");
      off.width = 320;
      off.height = 200;
      const c = off.getContext("2d");
      if (!c) return;
      c.fillStyle = "#0e0e10";
      c.fillRect(0, 0, 320, 200);
      const { min, max } = dsp.peaks(buf, 320);
      c.fillStyle = "#e3b04b";
      for (let x = 0; x < 320; x++) {
        const y1 = 100 - max[x] * 96;
        const y2 = 100 - min[x] * 96;
        c.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
      const b64 = off.toDataURL("image/png").split(",")[1];
      await api.setThumb(asset.id, b64);
      setStatus("已设为波形封面（库里刷新后可见）");
      onSavedNew();
    } catch (e) {
      setStatus(`设封面失败：${e}`);
    }
  };

  // —— 录音（追加为新素材） ——
  const recRef = useRef<{ mr: MediaRecorder; chunks: BlobPart[]; stream: MediaStream } | null>(null);
  const [recording, setRecording] = useState(false);
  const toggleRecord = async () => {
    if (recording) {
      recRef.current?.mr.stop();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        recRef.current = null;
        try {
          const blob = new Blob(chunks, { type: "audio/webm" });
          const b = await dsp.decodeBytes(await blob.arrayBuffer());
          apply(b, "录音完成（已载入编辑器，可另存为素材）");
          setSel(null);
          setView({ start: 0, spp: Math.max(1, Math.ceil(b.length / width)) });
        } catch (e) {
          setStatus(`录音解码失败：${e}`);
        }
      };
      recRef.current = { mr, chunks, stream };
      mr.start();
      setRecording(true);
      setStatus("录音中…（再点停止）");
    } catch (e) {
      setStatus(`无法录音：${e}（需允许麦克风权限）`);
    }
  };

  return (
    <div className="modal-overlay audio-overlay" onClick={onClose}>
      <div className="audio-editor" onClick={(e) => e.stopPropagation()}>
        <div className="ae-head">
          <strong>🎵 音频编辑 · {asset ? asset.name : "新录音"}</strong>
          <span className="ae-status">{status}</span>
          <button className="btn" onClick={onClose}>关闭</button>
        </div>

        {err ? (
          <div className="ae-err">{err}</div>
        ) : (
          <>
            <div className="ae-wave" ref={wrapRef}>
              <canvas
                ref={canvasRef}
                width={width}
                height={220}
                style={{ width: "100%", height: 220, cursor: "text" }}
                onMouseDown={onDown}
                onMouseMove={onMove}
                onMouseUp={onUp}
                onMouseLeave={onUp}
              />
            </div>

            <div className="ae-bar">
              <button className="btn" disabled={!buf} onClick={playing ? stopPlay : play}>
                {playing ? "■ 停止" : "▶ 播放"}
              </button>
              <label className="ae-chk">
                <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} /> 循环选区
              </label>
              <button className="btn" disabled={!buf} onClick={selAll}>全选</button>
              <button className="btn" disabled={!buf} onClick={() => setSel(null)}>清选区</button>
              <span className="ae-sep" />
              <button className="btn" onClick={() => zoom(0.5)}>放大</button>
              <button className="btn" onClick={() => zoom(2)}>缩小</button>
              <button className={"btn" + (spectro ? " primary" : "")} onClick={() => setSpectro((s) => !s)}>
                {spectro ? "波形" : "频谱图"}
              </button>
              <span className="ae-sep" />
              <button className="btn" disabled={busy} onClick={undo}>↶ 撤销</button>
              <button className="btn" disabled={busy} onClick={redo}>↷ 重做</button>
              <button className={"btn" + (recording ? " primary" : "")} onClick={toggleRecord}>
                {recording ? "● 停止录音" : "● 录音"}
              </button>
            </div>

            <div className="ae-bar">
              <span className="ae-grp">剪辑:</span>
              <button className="btn" disabled={busy} onClick={() => needSel() && run("裁剪到选区", () => dsp.trim(buf!, S().a, S().b))}>裁剪</button>
              <button className="btn" disabled={busy} onClick={() => needSel() && run("删除选区", () => dsp.deleteRange(buf!, S().a, S().b))}>删除选区</button>
              <button className="btn" disabled={busy} onClick={() => needSel() && run("静音选区", () => dsp.silence(buf!, S().a, S().b))}>静音选区</button>
              <span className="ae-grp">增益:</span>
              <button className="btn" disabled={busy} onClick={() => run("淡入", () => dsp.fadeIn(buf!, S().a, S().b))}>淡入</button>
              <button className="btn" disabled={busy} onClick={() => run("淡出", () => dsp.fadeOut(buf!, S().a, S().b))}>淡出</button>
              <button className="btn" disabled={busy} onClick={() => run("归一化", () => dsp.normalize(buf!, -1))}>归一化</button>
              <button className="btn" disabled={busy} onClick={() => { const v = prompt("增益 dB（正为放大、负为减小）", "3"); if (v != null) run(`增益 ${v}dB`, () => dsp.gain(buf!, Number(v) || 0, S().a, S().b)); }}>增益…</button>
              <button className="btn" disabled={busy} onClick={() => run("反转", () => dsp.reverse(buf!, S().a, S().b))}>反转</button>
            </div>

            <div className="ae-bar">
              <span className="ae-grp">效果:</span>
              <button className="btn" disabled={busy} onClick={() => { const v = prompt("变速倍率（>1 加快并升调）", "1.25"); if (v != null) run(`变速 ${v}×`, () => dsp.changeSpeed(buf!, Number(v) || 1)); }}>变速…</button>
              <button className="btn" disabled={busy} onClick={() => { const v = prompt("低通截止频率 Hz", "4000"); if (v != null) run("低通", () => dsp.filter(buf!, "lowpass", Number(v) || 4000)); }}>低通…</button>
              <button className="btn" disabled={busy} onClick={() => { const v = prompt("高通截止频率 Hz", "200"); if (v != null) run("高通", () => dsp.filter(buf!, "highpass", Number(v) || 200)); }}>高通…</button>
              <button className="btn" disabled={busy} onClick={() => { const f = prompt("中心频率 Hz", "1000"); if (f == null) return; const g = prompt("增益 dB（+提升 / -削减）", "6"); if (g != null) run("EQ", () => dsp.filter(buf!, "peaking", Number(f) || 1000, Number(g) || 0, 1)); }}>EQ…</button>
              <button className="btn" disabled={busy} onClick={() => run("压缩", () => dsp.compress(buf!))}>压缩</button>
              <button className="btn" disabled={busy} onClick={() => run("混响", () => dsp.reverb(buf!))}>混响</button>
              <button className="btn" disabled={busy} onClick={() => run("回声", () => dsp.echo(buf!))}>回声</button>
            </div>

            <div className="ae-bar">
              <span className="ae-grp">导出:</span>
              <button className="btn primary" disabled={busy || !buf} onClick={() => saveAsNew("wav")}>另存为素材(WAV)</button>
              <button className="btn primary" disabled={busy || !buf} onClick={() => saveAsNew("mp3")}>另存为素材(MP3)</button>
              <button className="btn" disabled={busy || !buf} onClick={() => exportFile("wav")}>导出WAV…</button>
              <button className="btn" disabled={busy || !buf} onClick={() => exportFile("mp3")}>导出MP3…</button>
              <button className="btn" disabled={busy || !buf} onClick={setCover}>设为波形封面</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function drawSpectro(
  ctx: CanvasRenderingContext2D,
  buf: AudioBuffer,
  start: number,
  viewLen: number,
  W: number,
  H: number,
) {
  const N = 1024;
  const d = buf.getChannelData(0);
  const hop = Math.max(1, Math.floor(viewLen / W));
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let x = 0; x < W; x++) {
    const base = start + x * hop;
    for (let i = 0; i < N; i++) {
      const s = d[base + i] ?? 0;
      const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); // Hann
      re[i] = s * win;
      im[i] = 0;
    }
    dsp.fft(re, im);
    for (let y = 0; y < H; y++) {
      const bin = Math.floor((1 - y / H) * (N / 2));
      const mag = Math.hypot(re[bin], im[bin]);
      const db = 20 * Math.log10(mag + 1e-6);
      const v = clamp((db + 90) / 90, 0, 1); // -90..0 dB → 0..1
      const hue = 240 - v * 240;
      ctx.fillStyle = `hsl(${hue},80%,${10 + v * 50}%)`;
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
function fmtInfo(b: AudioBuffer) {
  const dur = b.length / b.sampleRate;
  return `${dur.toFixed(2)}s · ${b.sampleRate}Hz · ${b.numberOfChannels}声道`;
}
function baseName(name: string) {
  return name.replace(/\.[^.]+$/, "");
}
