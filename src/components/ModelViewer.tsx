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
  const [glInfo, setGlInfo] = useState(""); // 实际在跑的 GPU/渲染器，黑屏排查用
  const ctlRef = useRef<{
    reset?: () => void;
    setRotate?: (v: boolean) => void;
    snapshot?: () => string | null;
  }>({});

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      try {
        const THREE = await import("three");
        const { OrbitControls } = await import("three/examples/jsm/controls/OrbitControls.js");
        if (disposed) return;
        const el = mountRef.current;
        if (!el) return;
        setStatus("加载模型…");

        // WebView2 黑屏三连坑，全部绕开：
        // - antialias:false —— ANGLE 解析 MSAA 上屏在部分驱动黑屏（截帧正常、屏幕全黑的元凶）
        // - preserveDrawingBuffer:false —— 不需要（截封面前手动 render 一帧即可），开着另有合成坑
        // - alpha:false + 实色背景 —— 透明 canvas 合成坑
        const renderer = new THREE.WebGLRenderer({
          antialias: false,
          alpha: false,
          preserveDrawingBuffer: false,
          powerPreference: "high-performance",
        });
        renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
        renderer.setSize(el.clientWidth, el.clientHeight);
        el.appendChild(renderer.domElement);
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
        scene.background = new THREE.Color(0x141417);
        const camera = new THREE.PerspectiveCamera(
          50,
          el.clientWidth / Math.max(1, el.clientHeight),
          0.01,
          1000
        );
        scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a45, 1.2));
        const key = new THREE.DirectionalLight(0xffffff, 1.6);
        key.position.set(3, 6, 4);
        scene.add(key);
        const rim = new THREE.DirectionalLight(0x88a0ff, 0.5);
        rim.position.set(-4, 2, -3);
        scene.add(rim);

        const controls = new OrbitControls(camera, renderer.domElement);
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
        };
        window.addEventListener("resize", onResize);
        // 挂载初期布局可能未稳（dock/浮层动画），下一帧再校正一次尺寸
        requestAnimationFrame(() => {
          if (!disposed) onResize();
        });

        ctlRef.current = {
          reset,
          setRotate: (v) => (controls.autoRotate = v),
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
          renderer.dispose();
          renderer.forceContextLoss();
          renderer.domElement.remove();
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
