// 启动装配 —— three.js 场景/相机/渲染循环，把 audio.js 的数据喂给 particles.js。
// 数字键 0–5 切换预设；透明背景（露出桌面，为 Phase 4 壁纸层铺路）。

(function () {
  const THREE = window.THREE;
  const canvas = document.getElementById('scene');
  const hud = document.getElementById('hud');

  const PRESET_NAMES = ['SILK 丝绸', 'TUNNEL 隧道', 'ORBIT 星球', 'VOID 虚空', 'VINYL 黑胶', 'WALLPAPER 极光'];
  // 每个预设合适的相机距离（粒子空间尺度不同）。
  const CAM_DIST = [6.6, 6.2, 7.0, 6.6, 6.6, 20.0];

  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0); // 透明，露出窗口背后
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 0, CAM_DIST[0]);
  camera.lookAt(0, 0, 0);
  let camTargetZ = CAM_DIST[0];

  const particles = window.createWallpaperParticles(THREE, renderer);
  scene.add(particles.group);

  // ---- 数据接线 ----
  const audio = window.WallpaperAudio;
  let title = '';
  audio.onTrack((tk) => {
    title = tk.title ? '♪ ' + tk.title + (tk.artist ? ' — ' + tk.artist : '') : '';
    particles.setCover(tk.cover);
  });
  audio.start();

  function setPreset(n) {
    n = ((n % 6) + 6) % 6;
    particles.setPreset(n);
    camTargetZ = CAM_DIST[n];
  }
  window.addEventListener('keydown', (e) => {
    if (e.key >= '0' && e.key <= '5') setPreset(parseInt(e.key, 10));
  });

  function hudText() {
    const conn = audio.state.connected ? (audio.hasSignal() ? '♫ 播放中' : '已连接·静音') : '未连接';
    return `${conn}  |  预设 ${audio ? '' : ''}${PRESET_NAMES[particles.getPreset()]}（按 0–5 切换）  ${title}`;
  }

  // ---- 渲染循环 ----
  const clock = new THREE.Clock();
  function frame() {
    const dt = Math.min(0.05, clock.getDelta());
    particles.update(audio.state, dt);
    // 相机距离平滑靠近目标
    camera.position.z += (camTargetZ - camera.position.z) * Math.min(1, dt * 4);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    hud.textContent = hudText();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- 自适应窗口 ----
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();
