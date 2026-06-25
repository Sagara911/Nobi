// 音频处理：纯函数（AudioBuffer 进 / 出），不依赖 React/Tauri。
// 全部走浏览器原生 Web Audio；编码 WAV 自写、MP3 用 lamejs。
// 选区操作的 start/end 均为采样下标（[start,end)）。

import { Mp3Encoder } from "@breezystack/lamejs";

let _ac: AudioContext | null = null;
/** 共享 AudioContext（解码/播放用） */
export function ac(): AudioContext {
  if (!_ac) _ac = new AudioContext();
  return _ac;
}

/** 解码音频字节 → AudioBuffer */
export async function decodeBytes(bytes: ArrayBuffer): Promise<AudioBuffer> {
  return await ac().decodeAudioData(bytes.slice(0));
}

/** 新建空 AudioBuffer */
export function makeBuffer(channels: number, length: number, sampleRate: number): AudioBuffer {
  return new AudioBuffer({
    numberOfChannels: Math.max(1, channels),
    length: Math.max(1, length),
    sampleRate,
  });
}

function mapChannels<T>(buf: AudioBuffer, f: (data: Float32Array, ch: number) => T): T[] {
  const out: T[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) out.push(f(buf.getChannelData(c), c));
  return out;
}

/** 整段克隆 */
export function clone(buf: AudioBuffer): AudioBuffer {
  const out = makeBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  mapChannels(buf, (d, c) => out.getChannelData(c).set(d));
  return out;
}

// ===== 选区裁剪类（纯下标操作） =====

/** 裁剪：只保留 [start,end) */
export function trim(buf: AudioBuffer, start: number, end: number): AudioBuffer {
  const s = clampIdx(start, buf.length);
  const e = clampIdx(end, buf.length);
  const len = Math.max(1, e - s);
  const out = makeBuffer(buf.numberOfChannels, len, buf.sampleRate);
  mapChannels(buf, (d, c) => out.getChannelData(c).set(d.subarray(s, s + len)));
  return out;
}

/** 删除 [start,end)，前后拼接 */
export function deleteRange(buf: AudioBuffer, start: number, end: number): AudioBuffer {
  const s = clampIdx(start, buf.length);
  const e = clampIdx(end, buf.length);
  const len = Math.max(1, buf.length - (e - s));
  const out = makeBuffer(buf.numberOfChannels, len, buf.sampleRate);
  mapChannels(buf, (d, c) => {
    const o = out.getChannelData(c);
    o.set(d.subarray(0, s), 0);
    o.set(d.subarray(e), s);
  });
  return out;
}

/** 把 [start,end) 置静音（原地复制改） */
export function silence(buf: AudioBuffer, start: number, end: number): AudioBuffer {
  const out = clone(buf);
  const s = clampIdx(start, out.length);
  const e = clampIdx(end, out.length);
  mapChannels(out, (d) => d.fill(0, s, e));
  return out;
}

// ===== 增益 / 归一 / 淡变 / 反转（纯样本运算） =====

/** 增益（dB），可只作用于选区（默认整段） */
export function gain(buf: AudioBuffer, db: number, start = 0, end = buf.length): AudioBuffer {
  const factor = Math.pow(10, db / 20);
  const out = clone(buf);
  const s = clampIdx(start, out.length);
  const e = clampIdx(end, out.length);
  mapChannels(out, (d) => {
    for (let i = s; i < e; i++) d[i] = clampSample(d[i] * factor);
  });
  return out;
}

/** 归一化到目标峰值（dBFS，默认 -1dB） */
export function normalize(buf: AudioBuffer, targetDb = -1): AudioBuffer {
  let peak = 0;
  mapChannels(buf, (d) => {
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  });
  if (peak <= 0) return clone(buf);
  const target = Math.pow(10, targetDb / 20);
  const factor = target / peak;
  const out = clone(buf);
  mapChannels(out, (d) => {
    for (let i = 0; i < d.length; i++) d[i] = clampSample(d[i] * factor);
  });
  return out;
}

/** 淡入（在 [start,end) 上从 0→1 线性） */
export function fadeIn(buf: AudioBuffer, start = 0, end = buf.length): AudioBuffer {
  return fade(buf, start, end, true);
}
/** 淡出（在 [start,end) 上从 1→0 线性） */
export function fadeOut(buf: AudioBuffer, start = 0, end = buf.length): AudioBuffer {
  return fade(buf, start, end, false);
}
function fade(buf: AudioBuffer, start: number, end: number, fadeIn: boolean): AudioBuffer {
  const out = clone(buf);
  const s = clampIdx(start, out.length);
  const e = clampIdx(end, out.length);
  const n = Math.max(1, e - s);
  mapChannels(out, (d) => {
    for (let i = s; i < e; i++) {
      const t = (i - s) / n;
      d[i] = clampSample(d[i] * (fadeIn ? t : 1 - t));
    }
  });
  return out;
}

/** 反转（默认整段，可只反转选区） */
export function reverse(buf: AudioBuffer, start = 0, end = buf.length): AudioBuffer {
  const out = clone(buf);
  const s = clampIdx(start, out.length);
  const e = clampIdx(end, out.length);
  mapChannels(out, (d) => {
    let lo = s;
    let hi = e - 1;
    while (lo < hi) {
      const tmp = d[lo];
      d[lo] = d[hi];
      d[hi] = tmp;
      lo++;
      hi--;
    }
  });
  return out;
}

/** 变速（rate>1 加快、连带升调；线性插值重采样，整段） */
export function changeSpeed(buf: AudioBuffer, rate: number): AudioBuffer {
  const r = Math.max(0.1, Math.min(8, rate));
  const newLen = Math.max(1, Math.floor(buf.length / r));
  const out = makeBuffer(buf.numberOfChannels, newLen, buf.sampleRate);
  mapChannels(buf, (d, c) => {
    const o = out.getChannelData(c);
    for (let i = 0; i < newLen; i++) {
      const pos = i * r;
      const i0 = Math.floor(pos);
      const frac = pos - i0;
      const a = d[i0] ?? 0;
      const b = d[i0 + 1] ?? a;
      o[i] = a + (b - a) * frac;
    }
  });
  return out;
}

// ===== 离线渲染类效果（Web Audio 原生节点） =====

async function renderOffline(
  buf: AudioBuffer,
  tailSec: number,
  build: (ctx: OfflineAudioContext, src: AudioBufferSourceNode) => AudioNode,
): Promise<AudioBuffer> {
  const len = buf.length + Math.ceil(tailSec * buf.sampleRate);
  const ctx = new OfflineAudioContext(buf.numberOfChannels, len, buf.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  build(ctx, src).connect(ctx.destination);
  src.start();
  return await ctx.startRendering();
}

/** 滤波/EQ：lowpass/highpass/peaking。peaking 用 gainDb，lowpass/highpass 用 q。 */
export function filter(
  buf: AudioBuffer,
  type: "lowpass" | "highpass" | "peaking",
  freq: number,
  gainDb = 0,
  q = 1,
): Promise<AudioBuffer> {
  return renderOffline(buf, 0, (ctx, src) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.gain.value = gainDb;
    src.connect(f);
    return f;
  });
}

/** 动态压缩（默认参数足够日常用） */
export function compress(buf: AudioBuffer): Promise<AudioBuffer> {
  return renderOffline(buf, 0, (ctx, src) => {
    const c = ctx.createDynamicsCompressor();
    c.threshold.value = -24;
    c.knee.value = 30;
    c.ratio.value = 4;
    c.attack.value = 0.003;
    c.release.value = 0.25;
    src.connect(c);
    return c;
  });
}

/** 混响：合成脉冲响应做卷积，干湿混合 */
export function reverb(buf: AudioBuffer, seconds = 1.6, wet = 0.3): Promise<AudioBuffer> {
  return renderOffline(buf, seconds, (ctx, src) => {
    const ir = ctx.createBuffer(2, Math.max(1, Math.floor(seconds * buf.sampleRate)), buf.sampleRate);
    for (let c = 0; c < ir.numberOfChannels; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        // 衰减白噪声做近似脉冲响应（用 i 派生伪随机，避免 Math.random 不确定性）
        const rnd = pseudo(i * (c + 1) + 1) * 2 - 1;
        d[i] = rnd * Math.pow(1 - i / d.length, 2.2);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const dry = ctx.createGain();
    dry.gain.value = 1 - wet;
    const wetG = ctx.createGain();
    wetG.gain.value = wet;
    const mix = ctx.createGain();
    src.connect(dry).connect(mix);
    src.connect(conv).connect(wetG).connect(mix);
    return mix;
  });
}

/** 回声/延迟：反馈延迟线，干湿混合 */
export function echo(buf: AudioBuffer, delaySec = 0.3, feedback = 0.4, wet = 0.4): Promise<AudioBuffer> {
  const tail = delaySec * 8;
  return renderOffline(buf, tail, (ctx, src) => {
    const delay = ctx.createDelay(Math.max(1, delaySec + 0.1));
    delay.delayTime.value = delaySec;
    const fb = ctx.createGain();
    fb.gain.value = Math.min(0.95, feedback);
    const dry = ctx.createGain();
    dry.gain.value = 1;
    const wetG = ctx.createGain();
    wetG.gain.value = wet;
    const mix = ctx.createGain();
    src.connect(dry).connect(mix);
    src.connect(delay);
    delay.connect(fb).connect(delay); // 反馈环
    delay.connect(wetG).connect(mix);
    return mix;
  });
}

// ===== 生成 =====

/** 生成静音（秒） */
export function genSilence(seconds: number, sampleRate: number, channels = 2): AudioBuffer {
  return makeBuffer(channels, Math.max(1, Math.floor(seconds * sampleRate)), sampleRate);
}
/** 生成正弦音（频率 Hz、秒、音量 0~1） */
export function genTone(freq: number, seconds: number, sampleRate: number, vol = 0.4): AudioBuffer {
  const len = Math.max(1, Math.floor(seconds * sampleRate));
  const out = makeBuffer(1, len, sampleRate);
  const d = out.getChannelData(0);
  const w = (2 * Math.PI * freq) / sampleRate;
  for (let i = 0; i < len; i++) d[i] = Math.sin(w * i) * vol;
  return out;
}

// ===== 编码 =====

/** AudioBuffer → 16bit PCM WAV 字节 */
export function encodeWav(buf: AudioBuffer): Uint8Array {
  const numCh = buf.numberOfChannels;
  const sr = buf.sampleRate;
  const len = buf.length;
  const blockAlign = numCh * 2;
  const dataSize = len * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const v = new DataView(ab);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, numCh, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, 16, true);
  wstr(36, "data");
  v.setUint32(40, dataSize, true);
  const chans = mapChannels(buf, (d) => d);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < numCh; c++) {
      const s = clampSample(chans[c][i]);
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Uint8Array(ab);
}

/** AudioBuffer → MP3 字节（lamejs，最多双声道） */
export function encodeMp3(buf: AudioBuffer, kbps = 192): Uint8Array {
  const ch = Math.min(2, buf.numberOfChannels);
  const enc = new Mp3Encoder(ch, buf.sampleRate, kbps);
  const left = floatToInt16(buf.getChannelData(0));
  const right = ch > 1 ? floatToInt16(buf.getChannelData(1)) : left;
  const block = 1152;
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < left.length; i += block) {
    const l = left.subarray(i, i + block);
    const r = right.subarray(i, i + block);
    const mp3 = ch > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (mp3.length > 0) chunks.push(new Uint8Array(mp3));
  }
  const end = enc.flush();
  if (end.length > 0) chunks.push(new Uint8Array(end));
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// ===== 波形 / 频谱（可视化） =====

/** 计算波形峰值（min/max 对，长度 = buckets），用于画波形 */
export function peaks(buf: AudioBuffer, buckets: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(buckets);
  const max = new Float32Array(buckets);
  const d = buf.getChannelData(0);
  const per = d.length / buckets;
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per);
    const e = Math.min(d.length, Math.floor((b + 1) * per));
    let lo = 1;
    let hi = -1;
    for (let i = s; i < e; i++) {
      if (d[i] < lo) lo = d[i];
      if (d[i] > hi) hi = d[i];
    }
    if (e <= s) lo = hi = 0;
    min[b] = lo;
    max[b] = hi;
  }
  return { min, max };
}

/** 把单声道一帧做 FFT（原地，输入实部 re、虚部 im，长度须为 2 的幂） */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ===== 小工具 =====

function clampIdx(i: number, len: number): number {
  return Math.max(0, Math.min(len, Math.round(i)));
}
function clampSample(s: number): number {
  return s > 1 ? 1 : s < -1 ? -1 : s;
}
function floatToInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const s = clampSample(f[i]);
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
/** 确定性伪随机（混响脉冲用，避免 Math.random 的不确定性） */
function pseudo(n: number): number {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
