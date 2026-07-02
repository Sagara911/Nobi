// 粒子系统 —— 用 Mineradio 的着色器(shaders.js)搭主粒子 + bloom 两层，
// 但音频接线换成 Nobi 的 bands/peak(见 update)、封面来自 SMTC data URL(见 setCover)。
// 几何是规则网格：每个粒子对应封面上一个 texel，着色器按 uPreset 决定其空间形态。
// 全局工厂 window.createWallpaperParticles(THREE, renderer) → { group, update, setCover, setPreset, getPreset }。

window.createWallpaperParticles = function (THREE, renderer) {
  const GRID = 200;                 // GRID×GRID 个粒子（4 万）
  const PCOUNT = GRID * GRID;
  const PLANE_SIZE = 4.8;
  const S = window.WallpaperShaders;

  // ---- 干净圆点纹理（Mineradio makeDotTexture） ----
  function makeDotTexture() {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const ctx = cv.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 31);
    g.addColorStop(0.0, 'rgba(255,255,255,0.96)');
    g.addColorStop(0.42, 'rgba(255,255,255,0.78)');
    g.addColorStop(0.72, 'rgba(255,255,255,0.22)');
    g.addColorStop(1.0, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    return tex;
  }

  // ---- 封面纹理（当前 + 上一首，用于切歌 crossfade） ----
  const coverCanvas = document.createElement('canvas');
  coverCanvas.width = coverCanvas.height = 256;
  const prevCanvas = document.createElement('canvas');
  prevCanvas.width = prevCanvas.height = 256;
  function fillNeutral(cv) {
    const c = cv.getContext('2d');
    c.fillStyle = '#242a33';
    c.fillRect(0, 0, cv.width, cv.height);
  }
  fillNeutral(coverCanvas);
  fillNeutral(prevCanvas);
  function makeCoverTex(cv) {
    const t = new THREE.CanvasTexture(cv);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }
  const coverTex = makeCoverTex(coverCanvas);
  const prevCoverTex = makeCoverTex(prevCanvas);

  // ---- 常量占位纹理：边缘/深度(不做) + 涟漪(不做) ----
  // 边缘纹理 RGBA = R=depth0.5, G=edge0, B=fgmask1, A=lum1；配合 uHasDepth=0/uEdgeEnabled=0 视觉无影响。
  const edgeTex = new THREE.DataTexture(
    new Uint8Array([128, 0, 255, 255]), 1, 1, THREE.RGBAFormat
  );
  edgeTex.needsUpdate = true;
  const rippleTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1, THREE.RGBAFormat);
  rippleTex.needsUpdate = true;

  const dotTexture = makeDotTexture();

  // ---- uniforms（默认值取自 Mineradio；交互/涟漪/边缘相关项留静默默认） ----
  const uniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 }, uMid: { value: 0 }, uTreble: { value: 0 },
    uBeat: { value: 0 }, uEnergy: { value: 0 }, uBurstAmt: { value: 0 },
    uVinylSpin: { value: 0 },
    uPreset: { value: 0 },
    uIntensity: { value: 1.0 },
    uDepth: { value: 1.0 }, uPointScale: { value: 1.0 }, uSpeed: { value: 1.0 },
    uTwist: { value: 0 }, uColorBoost: { value: 1.1 }, uScatter: { value: 0 },
    uCoverRes: { value: 1.0 }, uBgFade: { value: 0.2 },
    uBloomStrength: { value: 0.62 }, uBloomSize: { value: 2.65 },
    uTintColor: { value: new THREE.Color('#9db8cf') }, uTintStrength: { value: 0 },
    uCoverTex: { value: coverTex }, uPrevCoverTex: { value: prevCoverTex },
    uColorMixT: { value: 1.0 },
    uEdgeTex: { value: edgeTex }, uRippleTex: { value: rippleTex }, uRippleCount: { value: 0 },
    uDotTex: { value: dotTexture },
    uHasCover: { value: 0 }, uHasDepth: { value: 0 }, uEdgeEnabled: { value: 0 }, uAiBoost: { value: 0 },
    uMouseXY: { value: new THREE.Vector2(-999, -999) }, uMouseActive: { value: 0 },
    uHandXY: { value: new THREE.Vector2(-999, -999) }, uHandActive: { value: 0 }, uGestureGrip: { value: 0 },
    uPixel: { value: renderer.getPixelRatio() },
    uAlpha: { value: 1 }, uParticleDim: { value: 1 }, uFloatAlpha: { value: 0 }, uLoading: { value: 0 },
  };

  // ---- 几何：规则网格 ----
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(PCOUNT * 3);
  const uvs = new Float32Array(PCOUNT * 2);
  const rands = new Float32Array(PCOUNT);
  let idx = 0;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const px = (gx + 0.5) / GRID;
      const py = (gy + 0.5) / GRID;
      positions[idx * 3] = (px - 0.5) * PLANE_SIZE;
      positions[idx * 3 + 1] = (py - 0.5) * PLANE_SIZE;
      positions[idx * 3 + 2] = 0;
      uvs[idx * 2] = px;
      uvs[idx * 2 + 1] = py;
      rands[idx] = Math.random();
      idx++;
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));
  geometry.setAttribute('aRand', new THREE.BufferAttribute(rands, 1));

  // ---- 主材质 + bloom 材质，两层 Points ----
  const material = new THREE.ShaderMaterial({
    uniforms, vertexShader: S.vs, fragmentShader: S.fs,
    transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  });
  const bloomMaterial = new THREE.ShaderMaterial({
    uniforms, vertexShader: S.bloomVs, fragmentShader: S.bloomFs,
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });

  const particles = new THREE.Points(geometry, material);
  const bloomParticles = new THREE.Points(geometry, bloomMaterial);
  particles.frustumCulled = false;
  bloomParticles.frustumCulled = false;
  bloomParticles.renderOrder = 0;
  particles.renderOrder = 1;

  const group = new THREE.Group();
  group.add(bloomParticles);
  group.add(particles);

  // ---- 换封面：旧图存进 prev，新图画进 cover，启动 crossfade ----
  function setCover(dataUrl) {
    if (!dataUrl) { uniforms.uHasCover.value = 0; return; }
    const img = new Image();
    img.onload = () => {
      // 当前封面挪到 prev（做淡出的旧图）
      const pc = prevCanvas.getContext('2d');
      pc.clearRect(0, 0, 256, 256);
      pc.drawImage(coverCanvas, 0, 0, 256, 256);
      prevCoverTex.needsUpdate = true;
      // 新封面画进 cover
      const cc = coverCanvas.getContext('2d');
      cc.clearRect(0, 0, 256, 256);
      cc.drawImage(img, 0, 0, 256, 256);
      coverTex.needsUpdate = true;
      uniforms.uHasCover.value = 1;
      uniforms.uColorMixT.value = 0; // 0=旧 → 1=新，update() 里补间
    };
    img.src = dataUrl;
  }

  function setPreset(n) {
    uniforms.uPreset.value = n;
    uniforms.uBurstAmt.value = 1; // 切换脉冲
  }
  function getPreset() { return uniforms.uPreset.value; }

  // ---- 每帧：把 audio.js 的 bands/peak 映射进 5 个音频 uniform ----
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  function bandAvg(bands, lo, hi) {
    let s = 0;
    for (let i = lo; i < hi; i++) s += bands[i] || 0;
    return hi > lo ? s / (hi - lo) : 0;
  }

  function update(audio, dt) {
    const b = audio.bands;
    const N = b.length;
    const bass = bandAvg(b, 0, Math.round(N * 0.12));
    const mid = bandAvg(b, Math.round(N * 0.12), Math.round(N * 0.5));
    const treble = bandAvg(b, Math.round(N * 0.5), N);
    const energy = bandAvg(b, 0, N);

    uniforms.uBass.value = clamp01(bass / 1.5) * 0.9;
    uniforms.uMid.value = clamp01(mid / 1.5) * 0.72;
    uniforms.uTreble.value = clamp01(treble / 1.5) * 0.62;
    uniforms.uEnergy.value = clamp01(energy / 1.5) * 0.72;
    uniforms.uBeat.value = clamp01(audio.peak);

    uniforms.uTime.value += dt;
    // 黑胶自旋随 bass 略快
    uniforms.uVinylSpin.value =
      (uniforms.uVinylSpin.value + dt * (0.4 + uniforms.uBass.value * 0.2)) % (Math.PI * 2);
    // 切换脉冲衰减
    uniforms.uBurstAmt.value *= Math.pow(0.9, dt * 60);
    // 切歌颜色补间（0.8s）
    if (uniforms.uColorMixT.value < 1) {
      uniforms.uColorMixT.value = Math.min(1, uniforms.uColorMixT.value + dt / 0.8);
    }
  }

  return { group, update, setCover, setPreset, getPreset };
};
