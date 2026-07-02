// Nobi 音频可视化壁纸渲染器 —— Electron 主进程（Phase 2 原型）。
//
// 独立 Chromium 进程：走 Chromium 内核实时渲染 WebGL，绕开本机 WebView2 画不了实时画布的坑。
// Phase 2 只求验证「本机 Chromium 能实时渲染 WebGL」+ 打通 Nobi 本地 WS 数据链路。
// WorkerW 桌面贴层、点击穿透、多屏、按需下载留到 Phase 4。
//
// 视觉层后续将改编自 Mineradio (GPL-3.0)，本模块整体按 GPL-3.0-or-later 分发。

const { app, BrowserWindow } = require('electron');
const path = require('path');

// 让透明窗 + GPU 合成更稳（部分机器默认禁用透明窗合成）。
app.commandLine.appendSwitch('enable-transparent-visuals');
app.disableHardwareAcceleration = false;

// Phase 3 调试开关：true=实心背景+任务栏+自动 DevTools（方便看窗口和报错）；
// false=透明置顶的壁纸形态。已验证通过，改回 false。
const DEBUG = false;

function createWindow() {
  const win = new BrowserWindow({
    width: DEBUG ? 1000 : 960,
    height: DEBUG ? 600 : 380,
    frame: DEBUG,
    transparent: !DEBUG,
    backgroundColor: DEBUG ? '#0a0d12' : '#00000000',
    alwaysOnTop: !DEBUG,
    skipTaskbar: !DEBUG,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      // 纯前端页面（WebGL + WebSocket 都是浏览器 API），不需要 node。
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  if (DEBUG) win.webContents.openDevTools({ mode: 'detach' });
  // 渲染进程崩溃/加载失败时打到主进程 stdout，便于排查。
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    console.log('[renderer] did-fail-load', code, desc);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    console.log('[renderer] render-process-gone', JSON.stringify(d));
  });

  // Esc 关闭（原型期方便）。
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape') {
      win.close();
    }
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => app.quit());
