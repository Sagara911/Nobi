// 数据层 —— 连 Nobi 本地 WebSocket，维护「当前频段 / 峰值 / 曲目封面」供可视化消费。
//
// 与视觉解耦：本模块只管拿数据、做轻度平滑、暴露稳定接口；具体画什么由 visualizer 决定。
// 全局对象 window.WallpaperAudio。

(function () {
  const PORT = 17653;
  const NUM_BANDS = 48;

  const state = {
    bands: new Float32Array(NUM_BANDS),   // 平滑后的频段（约 0..1.5）
    raw: new Float32Array(NUM_BANDS),     // 最新原始帧
    peak: 0,                              // 平滑后的峰值（0..1）
    energy: 0,                            // 频段均值（整体律动强度，0..~1）
    connected: false,
    lastAudioTs: 0,
    track: { title: '', artist: '', album: '', cover: '' },
  };

  const trackCbs = [];
  /** 注册切歌回调：cb({title, artist, album, cover})。cover 为 base64 data URL 或空串。 */
  function onTrack(cb) { trackCbs.push(cb); }

  // 时间平滑：上行快（跟得上鼓点）、下行慢（不闪烁）。
  const ATTACK = 0.6;
  const RELEASE = 0.12;
  function smooth(prev, next) {
    const k = next > prev ? ATTACK : RELEASE;
    return prev + (next - prev) * k;
  }

  function applyAudio(bands, peak) {
    let sum = 0;
    for (let i = 0; i < NUM_BANDS; i++) {
      const v = bands[i] || 0;
      state.raw[i] = v;
      state.bands[i] = smooth(state.bands[i], v);
      sum += state.bands[i];
    }
    state.energy = sum / NUM_BANDS;
    state.peak = smooth(state.peak, peak || 0);
    state.lastAudioTs = performance.now();
  }

  /** 距上一帧音频超过 ms 毫秒视为无信号（用于待机动画切换）。 */
  function hasSignal(ms) {
    return performance.now() - state.lastAudioTs < (ms || 400);
  }

  function connect() {
    const ws = new WebSocket('ws://127.0.0.1:' + PORT);
    ws.onopen = () => { state.connected = true; };
    ws.onclose = () => { state.connected = false; setTimeout(connect, 1000); };
    ws.onerror = () => ws.close();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'audio') {
        applyAudio(msg.bands || [], msg.peak);
      } else if (msg.type === 'track') {
        state.track = {
          title: msg.title || '',
          artist: msg.artist || '',
          album: msg.album || '',
          cover: msg.cover || '',
        };
        trackCbs.forEach((cb) => { try { cb(state.track); } catch (e) { console.error(e); } });
      }
    };
  }

  window.WallpaperAudio = {
    NUM_BANDS,
    state,
    onTrack,
    hasSignal,
    start: connect,
  };
})();
