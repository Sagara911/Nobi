// 3D 模型查看器：全屏浮层，three.js 懒加载（首次打开下载引擎稍慢），
// 支持 glb / gltf(含外链 .bin/贴图) / obj / fbx / stl，轨道控制转圈看。
// 没封面的模型首次成功加载后自动把当前帧存回库缩略图（set_thumb），网格从此有封面。
// 架构注：这是继 CLIP 之后被认可的第二个前端计算例外——3D 渲染只能发生在 webview。
import { useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Asset } from "../types";
import * as api from "../api";
import "./ModelViewer.css";

export default function ModelViewer({
  asset,
  onClose,
  onThumbSaved,
}: {
  asset: Asset;
  onClose: () => void;
  /** 首帧封面写回成功后通知（App 刷新资产列表让网格出图） */
  onThumbSaved?: () => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState("加载 3D 引擎…");
  const [rotate, setRotate] = useState(true);
  const [solid, setSolid] = useState(false);
  const [glInfo, setGlInfo] = useState(""); // 实际在跑的 GPU/渲染器，黑屏排查用
  const [compat, setCompat] = useState(true); // 稳定显示：用 <img> 元素逐帧贴图，和封面截图同一路径
  const compatApiRef = useRef<((on: boolean) => void) | null>(null);
  const ctlRef = useRef<{
    reset?: () => void;
    setRotate?: (v: boolean) => void;
    setSolid?: (v: boolean) => void;
    snapshot?: () => string | null;
  }>({});

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    setSolid(false);
    setCompat(true);
    (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        if (disposed) return;
        const el = mountRef.current;
        if (!el) return;
        setStatus("加载模型…");

        // WebView2 合成坑终极绕法：WebGL 画布【不上屏】（离屏渲染），每帧 drawImage 拷到
        // 一块普通 2D 画布显示。实测该机型 GL 渲染/截帧全好、唯独合成上屏黑屏（GPU 渲染 ×
        // 软件合成的错配）；2D 画布与画板(Konva)同一条合成路径，必通。不直接上屏后
        // MSAA 抗锯齿也能放心开回来。
        // antialias 必须关：MSAA 默认缓冲上裸 readPixels 在 ANGLE 会读出全零
        // （toDataURL 会强制解析所以封面一直正常）——这正是读回路黑屏的最后一环
        const renderer = new THREE.WebGLRenderer({
          antialias: false,
          alpha: false,
          preserveDrawingBuffer: true,
          powerPreference: "high-performance",
        });
        renderer.setPixelRatio(1); // 每帧读回像素，1x 控带宽足够看模型
        renderer.setSize(el.clientWidth, el.clientHeight);
        const glCanvas = renderer.domElement;
        glCanvas.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;display:block;z-index:0";
        el.appendChild(glCanvas);
        const out = document.createElement("canvas"); // 真正可见的 2D 画布
        out.width = renderer.domElement.width;
        out.height = renderer.domElement.height;
        out.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;display:none;z-index:1";
        el.appendChild(out);
        // willReadFrequently：强制 CPU 软件画布——该机型 GPU 画布层在置顶浮层里
        // 合成不出来（画板在普通面板里所以没事），CPU 画布与图片/文字同一条上屏路
        const octx = out.getContext("2d", { willReadFrequently: true });
        if (!octx) throw new Error("2D 画布创建失败");
        // 兼容显示通道：<img> 逐帧贴 toDataURL——图片元素的显示绝无失败可能（封面同路）
        let slowMode = true;
        let zeroFrames = 0;
        let lastSlow = 0;
        const imgOut = document.createElement("img");
        imgOut.draggable = false;
        if (asset.thumb) imgOut.src = convertFileSrc(asset.thumb);
        imgOut.style.cssText =
          "position:absolute;inset:0;width:100%;height:100%;object-fit:contain;display:block;user-select:none;z-index:2";
        el.appendChild(imgOut);
        const setCompatMode = (on: boolean) => {
          out.style.display = on ? "none" : "block";
          imgOut.style.display = on ? "block" : "none";
          slowMode = on;
          setCompat(on);
        };
        compatApiRef.current = setCompatMode;
        setCompatMode(true);

        // 该机型连 drawImage(GL画布) 都走坏掉的 GPU 纹理通道（拷出透明）。
        // 唯一实证可用的是"逐像素读回"（封面 toDataURL 一直正常），所以每帧
        // readPixels → 翻转Y → putImageData。1x 像素比下带宽完全可接受。
        const glc = renderer.getContext();
        let fw = 0;
        let fh = 0;
        let readBuf = new Uint8Array(0);
        let imgData: ImageData | null = null;
        const realloc = () => {
          fw = renderer.domElement.width;
          fh = renderer.domElement.height;
          out.width = fw;
          out.height = fh;
          readBuf = new Uint8Array(fw * fh * 4);
          imgData = new ImageData(fw, fh);
        };
        realloc();
        // 兜底机制：readPixels 若连续读回全零（个别驱动怪癖），自动切到兼容显示
        const blit = (now: number) => {
          if (!imgData || !fw || !fh) return;
          if (slowMode) {
            if (now - lastSlow < 90) return; // ~11fps，PNG 编码代价高，看模型够用
            lastSlow = now;
            imgOut.src = renderer.domElement.toDataURL("image/png");
            return;
          }
          glc.readPixels(0, 0, fw, fh, glc.RGBA, glc.UNSIGNED_BYTE, readBuf);
          // 自检：背景色 #141417 决定了正常帧中心像素必非零；连续全零=读回坏了
          const c = ((fh >> 1) * fw + (fw >> 1)) * 4;
          if (readBuf[c] + readBuf[c + 1] + readBuf[c + 2] === 0) {
            if (++zeroFrames > 12) setCompatMode(true);
            return;
          }
          zeroFrames = 0;
          const row = fw * 4;
          for (let y = 0; y < fh; y++) {
            // readPixels 自下而上，画布自上而下：逐行翻转
            imgData.data.set(readBuf.subarray((fh - 1 - y) * row, (fh - y) * row), y * row);
          }
          octx.putImageData(imgData, 0, 0);
        };
        renderer.domElement.addEventListener("webglcontextlost", (ev) => {
          ev.preventDefault();
          setStatus("WebGL 上下文丢失（显卡资源紧张）——关闭重开即可");
        });
        try {
          const gl = renderer.getContext();
          const dbg = gl.getExtension("WEBGL_debug_renderer_info");
          setGlInfo(
            String(dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
          );
        } catch {
          /* 拿不到就算了 */
        }

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(0x181a20);
        const camera = new THREE.PerspectiveCamera(
          50,
          el.clientWidth / Math.max(1, el.clientHeight),
          0.01,
          1000
        );
        scene.add(new THREE.AmbientLight(0xffffff, 0.45));
        scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a45, 1.7));
        const key = new THREE.DirectionalLight(0xffffff, 2.4);
        key.position.set(3, 6, 4);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x9fb1ff, 0.8);
        rim.position.set(-4, 2, -3);
        scene.add(rim);
        const head = new THREE.PointLight(0xffffff, 1.25);
        camera.add(head);
        scene.add(camera);

        // 事件绑可见的 2D 画布（WebGL 画布已离屏收不到鼠标）
        const controls = new OrbitControls(camera, el);
        controls.enableDamping = true;
        controls.autoRotate = true;
        controls.autoRotateSpeed = 2.2;

        // gltf 的外链 .bin/贴图：convertFileSrc 会整段编码路径，相对 URL 解析会断，
        // 用 URLModifier 把相对引用映射回「模型同目录的兄弟文件」再走 asset 协议
        const dirPath = asset.path.replace(/[\\/][^\\/]*$/, "");
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((u) => {
          if (/^(blob:|data:|https?:)/i.test(u)) return u;
          const rel = decodeURIComponent(u).replace(/^\.\//, "");
          return convertFileSrc(`${dirPath}\\${rel.replace(/\//g, "\\")}`);
        });

        const url = convertFileSrc(asset.path);
        const fmt = asset.format.toLowerCase();
        let obj: import("three").Object3D;
        if (fmt === "glb" || fmt === "gltf") {
          const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
          obj = (await new GLTFLoader(manager).loadAsync(url)).scene;
        } else if (fmt === "obj") {
          const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
          obj = await new OBJLoader(manager).loadAsync(url);
          // obj 常无 mtl：给中性材质免得一片黑
          obj.traverse((c) => {
            const mesh = c as import("three").Mesh;
            if ((mesh as { isMesh?: boolean }).isMesh) {
              mesh.material = new THREE.MeshStandardMaterial({ color: 0xb8bcc6, roughness: 0.8 });
            }
          });
        } else if (fmt === "fbx") {
          const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
          obj = await new FBXLoader(manager).loadAsync(url);
        } else if (fmt === "stl") {
          const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
          const geo = await new STLLoader(manager).loadAsync(url);
          obj = new THREE.Mesh(
            geo,
            new THREE.MeshStandardMaterial({ color: 0xb8bcc6, roughness: 0.7 })
          );
        } else {
          throw new Error(`不支持的 3D 格式：${asset.format}`);
        }
        if (disposed) {
          renderer.dispose();
          return;
        }

        const originalMaterials = new Map<
          import("three").Mesh,
          import("three").Material | import("three").Material[]
        >();
        const clayMaterial = new THREE.MeshBasicMaterial({
          color: 0xe0e6f2,
          side: THREE.DoubleSide,
        });
        const materialList = (m: import("three").Material | import("three").Material[]) =>
          Array.isArray(m) ? m : [m];
        obj.traverse((c) => {
          const mesh = c as import("three").Mesh;
          if (!(mesh as { isMesh?: boolean }).isMesh || !mesh.material) return;
          originalMaterials.set(mesh, mesh.material);
          for (const mat of materialList(mesh.material)) {
            mat.side = THREE.DoubleSide;
            const maybe = mat as import("three").Material & {
              opacity?: number;
              transparent?: boolean;
              color?: import("three").Color;
              map?: unknown;
            };
            if (typeof maybe.opacity === "number" && maybe.opacity < 0.15) {
              maybe.opacity = 1;
              maybe.transparent = false;
            } else if (maybe.opacity === 1 && maybe.transparent) {
              maybe.transparent = false;
            }
            if (
              maybe.color &&
              !maybe.map &&
              maybe.color.r + maybe.color.g + maybe.color.b < 0.18
            ) {
              maybe.color.set(0xb8bcc6);
            }
            mat.needsUpdate = true;
          }
        });
        const applySolid = (on: boolean) => {
          for (const [mesh, original] of originalMaterials) {
            mesh.material = on ? clayMaterial : original;
          }
          setSolid(on);
        };
        if (fmt === "fbx") applySolid(true);

        // 居中 + 按包围球取景
        const box = new THREE.Box3().setFromObject(obj);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        obj.position.sub(center);
        scene.add(obj);
        const radius = Math.max(size.x, size.y, size.z) || 1;
        const reset = () => {
          camera.position.set(radius * 1.1, radius * 0.7, radius * 1.7);
          camera.near = radius / 100;
          camera.far = radius * 60;
          camera.updateProjectionMatrix();
          controls.target.set(0, 0, 0);
          controls.update();
        };
        reset();
        setStatus("");

        let raf = 0;
        const tick = () => {
          try {
            controls.update();
            renderer.render(scene, camera);
            // 同一任务内立刻读回（无 preserveDrawingBuffer 也安全）
            blit(performance.now());
          } catch (err) {
            setStatus(`渲染中断：${err instanceof Error ? err.message : err}`);
            return; // 出错就停循环，把原因亮出来
          }
          raf = requestAnimationFrame(tick);
        };
        tick();

        const onResize = () => {
          if (!el.clientWidth || !el.clientHeight) return;
          camera.aspect = el.clientWidth / el.clientHeight;
          camera.updateProjectionMatrix();
          renderer.setSize(el.clientWidth, el.clientHeight);
          realloc();
        };
        window.addEventListener("resize", onResize);
        // 挂载初期布局可能未稳（dock/浮层动画），下一帧再校正一次尺寸
        requestAnimationFrame(() => {
          if (!disposed) onResize();
        });

        ctlRef.current = {
          reset,
          setRotate: (v) => (controls.autoRotate = v),
          setSolid: applySolid,
          snapshot: () => {
            renderer.render(scene, camera);
            const data = renderer.domElement.toDataURL("image/png");
            return data.split(",")[1] ?? null;
          },
        };

        // 没封面：等一拍画面稳定后自动截首帧存回库
        if (!asset.thumb) {
          setTimeout(async () => {
            if (disposed) return;
            const b64 = ctlRef.current.snapshot?.();
            if (!b64) return;
            try {
              await api.setThumb(asset.id, b64);
              onThumbSaved?.();
            } catch {
              /* 封面写回失败不影响查看 */
            }
          }, 700);
        }

        cleanup = () => {
          cancelAnimationFrame(raf);
          window.removeEventListener("resize", onResize);
          controls.dispose();
          clayMaterial.dispose();
          renderer.dispose();
          renderer.forceContextLoss();
          glCanvas.remove();
          out.remove();
          imgOut.remove();
        };
      } catch (e) {
        if (!disposed) setStatus(`加载失败：${e instanceof Error ? e.message : e}`);
      }
    })();
    return () => {
      disposed = true;
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="mv-overlay" onClick={onClose}>
      <div className="mv-stage" onClick={(e) => e.stopPropagation()}>
        <div className="mv-toolbar">
          <div className="mv-group">
            <button
              className={"mv-tool" + (rotate ? " on" : "")}
              onClick={() => {
                ctlRef.current.setRotate?.(!rotate);
                setRotate(!rotate);
              }}
              title="自动旋转"
            >
              ⟳ 旋转
            </button>
            <button className="mv-tool" onClick={() => ctlRef.current.reset?.()} title="重置视角">
              ⌖ 重置
            </button>
            <button
              className="mv-tool"
              onClick={async () => {
                const b64 = ctlRef.current.snapshot?.();
                if (!b64) return;
                try {
                  await api.setThumb(asset.id, b64);
                  onThumbSaved?.();
                  setStatus("已把当前角度设为封面 ✓");
                  setTimeout(() => setStatus(""), 1500);
                } catch (e) {
                  setStatus(`封面保存失败：${e}`);
                }
              }}
              title="把当前角度存为网格缩略图"
            >
              📷 设为封面
            </button>
            <button
              className={"mv-tool" + (compat ? " on" : "")}
              onClick={() => compatApiRef.current?.(!compat)}
              title="兼容显示：使用和封面生成一致的截图流显示；关闭后切到性能模式"
            >
              🛟 兼容
            </button>
            <button
              className={"mv-tool" + (solid ? " on" : "")}
              onClick={() => ctlRef.current.setSolid?.(!solid)}
              title="实体显示：忽略原贴图/透明材质，用浅色双面材质看清轮廓"
            >
              ◩ 实体
            </button>
          </div>
          <div className="mv-title" title={asset.name}>
            {asset.name}
            <span className="mv-sub">{asset.format}</span>
          </div>
          <button className="mv-close" onClick={onClose} title="关闭（Esc）">
            ✕
          </button>
        </div>
        <div ref={mountRef} className="mv-canvas">
          {status && <div className="mv-status">{status}</div>}
        </div>
        <div className="mv-hint">
          拖动旋转 · 滚轮缩放 · 右键平移
          {glInfo && <span className="mv-gl"> · {glInfo}</span>}
        </div>
      </div>
    </div>
  );
}
