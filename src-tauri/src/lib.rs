//! Nobi 后端入口：只做模块声明与命令注册。
//!
//! 模块分层（详见 docs/ARCHITECTURE.md）：
//! - db        数据层（连接/迁移/公共查询）—— 表结构变更只能发生在这里
//! - library   素材库管理（导入/标签/收藏/导出）
//! - thumbs    缩略图与主色调
//! - ai        视觉 AI（打标/提示词/分析/自定义指令/Ollama 管理）
//! - search    检索（CLIP 存取与相似度 / 文本嵌入备用链路）
//! - settings  Provider 配置（用户设置 > 环境变量 > 默认值）
//! - collections 合集（手攒的具名素材集合；画板可存回库）
//! - collect   浏览器采集（本地 HTTP 服务 + 扩展导出）

mod ai;
mod board;
mod collect;
mod collections;
mod db;
mod library;
mod mcp_api;
mod search;
mod settings;
mod thumbs;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// 显示并聚焦主窗（从托盘/还原时统一走这里：可能处于隐藏或最小化）
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 看球小窗老板键：按一下把所有 web-* 窗藏起来，再按一下全部恢复。
/// 任一窗当前可见即视为「显示中」→ 全藏；否则 → 全显。
#[cfg(desktop)]
fn toggle_web_windows(app: &tauri::AppHandle) {
    let wins: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with("web-"))
        .map(|(_, w)| w)
        .collect();
    if wins.is_empty() {
        return;
    }
    let any_visible = wins.iter().any(|w| w.is_visible().unwrap_or(false));
    for w in wins {
        let _ = if any_visible { w.hide() } else { w.show() };
    }
    #[cfg(windows)]
    {
        // 藏 = 强制静音（光藏画面声音还响会露馅）；显回 = 恢复用户的静音状态（Alt+R 的选择），
        // 并重应用透明度（hide/show 会丢掉 layered alpha）
        let user_muted = WEB_MUTED.load(std::sync::atomic::Ordering::Relaxed);
        mute_web_windows(app, if any_visible { true } else { user_muted });
        if !any_visible {
            reapply_web_opacity_soon(app);
        }
    }
    // 键随可见性走：藏起→归还六个控制键给系统（老板键保留，不然唤不回）；显回→重新占用
    //（async：本函数从快捷键回调进来，主线程上同步注册会自锁）
    set_web_hotkeys_async(app, true, !any_visible);
    WEB_CTRLS_ON.store(!any_visible, std::sync::atomic::Ordering::Relaxed);
}

/// 给所有直开窗（web-d*）静音/取消静音——调 WebView2 原生 IsMuted（第一方页面 JS 够不着）。
#[cfg(windows)]
fn mute_web_windows(app: &tauri::AppHandle, mute: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
    use windows::core::Interface;
    for (label, w) in app.webview_windows() {
        if !label.starts_with("web-d") {
            continue;
        }
        let _ = w.with_webview(move |pw| unsafe {
            if let Ok(core) = pw.controller().CoreWebView2() {
                if let Ok(w8) = core.cast::<ICoreWebView2_8>() {
                    let _ = w8.SetIsMuted(mute);
                }
            }
        });
    }
}

/// 看球「直开」窗的不透明度（0–255），全局快捷键 Alt+1 / Alt+2 调，初始全实。
/// 全局保存——隐藏再显示 / 切标题栏后都按这个值重应用，不丢。
#[cfg(desktop)]
static WEB_OPACITY: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(255);

/// 直开窗当前是否显示标题栏（Alt+3 切）。初始 false＝无边框，跟建窗时 decorations:false 一致。
#[cfg(desktop)]
static WEB_DECOR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 直开窗是否点击穿透（Alt+4 切）：开启后鼠标穿过去点下面的软件，关掉才能再操作本窗。
#[cfg(desktop)]
static WEB_THROUGH: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 六个控制键当前是否占用中。键随看球窗走：有可见窗才占、藏起/全关归还（冲突自然解）。
#[cfg(desktop)]
static WEB_CTRLS_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(desktop)]
fn boss_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    Shortcut::new(Some(Modifiers::ALT), Code::Backquote)
}

#[cfg(desktop)]
fn ctrl_shortcuts() -> [tauri_plugin_global_shortcut::Shortcut; 12] {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
    [
        Shortcut::new(Some(Modifiers::ALT), Code::Digit1),
        Shortcut::new(Some(Modifiers::ALT), Code::Digit2),
        Shortcut::new(Some(Modifiers::ALT), Code::Digit3),
        Shortcut::new(Some(Modifiers::ALT), Code::Digit4),
        Shortcut::new(Some(Modifiers::ALT), Code::KeyQ),
        Shortcut::new(Some(Modifiers::ALT), Code::KeyW),
        Shortcut::new(Some(Modifiers::ALT), Code::KeyE),
        Shortcut::new(Some(Modifiers::ALT), Code::KeyR),
        Shortcut::new(Some(Modifiers::ALT), Code::KeyS),
        Shortcut::new(Some(Modifiers::ALT), Code::KeyD),
        Shortcut::new(Some(Modifiers::ALT), Code::KeyZ),
        Shortcut::new(Some(Modifiers::ALT), Code::KeyX),
    ]
}

/// 占用/归还看球快捷键。boss=老板键 Alt+`；ctrls=六个控制键（1/2/3/4/Q/W）。
/// 重复注册/注销都吞错（幂等）；注册失败（键被他程序占）也不致命。
///
/// ⚠️ 不要在快捷键回调/窗口事件回调里直接调（它们跑在主线程，而注册/注销内部要等
/// 主线程处理→自锁卡死整个 app）——回调里一律用 set_web_hotkeys_async。
#[cfg(desktop)]
fn set_web_hotkeys(app: &tauri::AppHandle, boss: bool, ctrls: bool) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let b = boss_shortcut();
    let _ = if boss { gs.register(b) } else { gs.unregister(b) };
    for s in ctrl_shortcuts() {
        let _ = if ctrls { gs.register(s) } else { gs.unregister(s) };
    }
}

/// set_web_hotkeys 的回调安全版：甩到工作线程执行（等主线程空出来再注册，不互等）。
#[cfg(desktop)]
fn set_web_hotkeys_async(app: &tauri::AppHandle, boss: bool, ctrls: bool) {
    let app = app.clone();
    std::thread::spawn(move || set_web_hotkeys(&app, boss, ctrls));
}

/// 重应用透明度：立即一次 + 延迟一拍(120ms)再补一次。
/// set_decorations / set_ignore_cursor_events / show / set_zoom 这类样式·渲染重写是
/// 异步落地的——紧跟的重应用会被它反超抹掉（表现为透明度闪一下变实），延迟补刀兜底。
/// 全实(255)时无事可做。补刀经 run_on_main_thread 回主线程执行（Win32 跨线程改窗口样式不稳）。
#[cfg(windows)]
fn reapply_web_opacity_soon(app: &tauri::AppHandle) {
    let level = WEB_OPACITY.load(std::sync::atomic::Ordering::Relaxed);
    if level >= 255 {
        return;
    }
    apply_web_opacity(app, level);
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        let level = WEB_OPACITY.load(std::sync::atomic::Ordering::Relaxed);
        if level < 255 {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || apply_web_opacity(&app2, level));
        }
    });
}

#[cfg(desktop)]
fn web_prefs_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("webdirect_prefs.json"))
}

/// 看球搜索引擎 key（google/bing/baidu，空=google）。菜单「工具→看球搜索引擎」选，
/// 前端 localStorage 与本静态量经 web_set_search_engine 命令保持同步。
#[cfg(desktop)]
static WEB_ENGINE: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 当前搜索引擎的查询前缀（与前端 WebTVModal 的 ENGINE_PREFIX 一致）。
#[cfg(desktop)]
fn web_engine_prefix() -> &'static str {
    let key = WEB_ENGINE.lock().map(|s| s.clone()).unwrap_or_default();
    match key.as_str() {
        "bing" => "https://www.bing.com/search?q=",
        "baidu" => "https://www.baidu.com/s?wd=",
        _ => "https://www.google.com/search?q=",
    }
}

#[cfg(desktop)]
#[tauri::command]
fn web_set_search_engine(app: tauri::AppHandle, engine: String) {
    if let Ok(mut e) = WEB_ENGINE.lock() {
        *e = engine;
    }
    save_web_prefs(&app);
}

/// 存看球窗偏好（透明度/缩放/缩放是否手动/搜索引擎），跨重启记忆——别下次开窗又全亮。
/// JSON 对象存（字段宽容读取），以后加字段不破老档。
#[cfg(desktop)]
fn save_web_prefs(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let engine = WEB_ENGINE.lock().map(|s| s.clone()).unwrap_or_default();
    let prefs = serde_json::json!({
        "opacity": WEB_OPACITY.load(Ordering::Relaxed),
        "zoom": WEB_ZOOM.load(Ordering::Relaxed),
        "zoom_manual": WEB_ZOOM_MANUAL.load(Ordering::Relaxed),
        "engine": engine,
    });
    if let Some(p) = web_prefs_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, prefs.to_string());
    }
}

/// 启动时读回看球窗偏好（兼容旧的元组格式：读不出对象就当默认值）。
#[cfg(desktop)]
fn load_web_prefs(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let Some(p) = web_prefs_path(app) else { return };
    let Ok(s) = std::fs::read_to_string(p) else { return };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) else {
        return;
    };
    if let Some(op) = v.get("opacity").and_then(|x| x.as_u64()) {
        WEB_OPACITY.store((op as u8).max(51), Ordering::Relaxed);
    }
    if let Some(z) = v.get("zoom").and_then(|x| x.as_u64()) {
        WEB_ZOOM.store((z as u32).clamp(40, 200), Ordering::Relaxed);
    }
    if let Some(m) = v.get("zoom_manual").and_then(|x| x.as_bool()) {
        WEB_ZOOM_MANUAL.store(m, Ordering::Relaxed);
    }
    if let Some(e) = v.get("engine").and_then(|x| x.as_str()) {
        if let Ok(mut slot) = WEB_ENGINE.lock() {
            *slot = e.to_string();
        }
    }
}

/// 直开窗页面缩放 ×100（存最近一次实际应用值，自动/手动共用）。小窗看球时站点控件是按
/// 大窗设计的固定像素、显得巨大——页面 zoom 调小让页面"以为窗很大"，控件/弹幕跟着小，
/// 视频清晰度不受影响。
#[cfg(desktop)]
static WEB_ZOOM: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(100);

/// 缩放模式：默认自动（随窗宽缩，窗宽/1280，下限 40%、上限 100%）；按过 Alt+Q/W 即切
/// 手动接管（从当前档位步进），重启回自动。
#[cfg(desktop)]
static WEB_ZOOM_MANUAL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 按窗逻辑宽算自动缩放档：页面始终以为自己在 ~1280px 宽的正常浏览器里。
#[cfg(desktop)]
fn auto_zoom_for_width(logical_w: f64) -> u32 {
    ((logical_w / 1280.0 * 100.0) as u32).clamp(40, 100)
}

/// 把页面缩放应用到所有直开窗。
#[cfg(desktop)]
fn apply_web_zoom(app: &tauri::AppHandle, percent: u32) {
    for (label, w) in app.webview_windows() {
        if label.starts_with("web-d") {
            let _ = w.set_zoom(percent as f64 / 100.0);
        }
    }
    // set_zoom 触发 WebView2 重建渲染，本机会把 layered alpha 冲掉——立即+延迟双重应用
    //（同 hide/show、切标题栏、切穿透的老毛病，一族病一种修法）
    #[cfg(windows)]
    reapply_web_opacity_soon(app);
}

/// 直开窗启动脚本：把「开新窗」改写成本窗内跳转——直播站的「进入直播间」等按钮多走
/// window.open / target=_blank，webview 里新窗请求默认被吞，点了像没点。
#[cfg(desktop)]
const NEWWIN_FIX_JS: &str = r#"(function(){
  window.open=function(u){ if(u){ try{ location.href=u; }catch(e){} } return null; };
  document.addEventListener('click',function(e){
    var t=e.target; var a=t&&t.closest?t.closest('a[target="_blank"]'):null;
    if(a&&a.href){ e.preventDefault(); location.href=a.href; }
  },true);
})();"#;

/// 直开窗 label 序号（每开一个 +1，保证唯一）。
static DIRECT_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 直开窗静音状态（Alt+R 切，独立于老板键）：人要说话时画面留着、声音掐掉。
/// 老板键藏=强制静音；显回=恢复到这个用户状态（而不是一律取消静音）。
#[cfg(desktop)]
static WEB_MUTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Alt+D 贴角循环计数：右下→右上→左上→左下。
#[cfg(desktop)]
static WEB_CORNER: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// 按住连调：当前按住的可连调键（0=无 1=淡 2=浓 3=页面缩小 4=页面放大）。
/// 全局热键没有系统自带的按住重复——靠插件的按下/松开事件自己驱动重复线程。
#[cfg(desktop)]
static HOLD_KEY: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

/// 连调代数：每次新按下 +1，旧的重复线程发现代数变了立即退出（防两次快按串成双倍速）。
#[cfg(desktop)]
static HOLD_GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 连调单步：1=变淡 2=变浓 3=页面缩小 4=页面放大。单击走一步；按住由重复线程反复调。
#[cfg(desktop)]
fn web_step(app: &tauri::AppHandle, id: u8) {
    use std::sync::atomic::Ordering;
    match id {
        1 | 2 => {
            // 步进 ~10%，下限 51（~20%）别让窗彻底消失
            let cur = WEB_OPACITY.load(Ordering::Relaxed);
            let next = if id == 1 {
                cur.saturating_sub(26).max(51)
            } else {
                cur.saturating_add(26)
            };
            WEB_OPACITY.store(next, Ordering::Relaxed);
            #[cfg(windows)]
            apply_web_opacity(app, next);
            save_web_prefs(app);
        }
        _ => {
            // 一按即切手动接管（自动缩放不再插手）；从当前实际档位步进
            WEB_ZOOM_MANUAL.store(true, Ordering::Relaxed);
            let cur = WEB_ZOOM.load(Ordering::Relaxed);
            let next = if id == 3 {
                cur.saturating_sub(10).max(40)
            } else {
                (cur + 10).min(200)
            };
            WEB_ZOOM.store(next, Ordering::Relaxed);
            apply_web_zoom(app, next);
            save_web_prefs(app);
        }
    }
}

/// 直开窗上次的大小/位置（逻辑像素 x,y,w,h），下次开在原地。内存 + 落盘双存。
static DIRECT_GEOM: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);

/// 把当前不透明度应用到所有直开窗（label 以 web-d 开头）。用 Win32 原生窗口 alpha
/// （SetLayeredWindowAttributes）——直开窗装的是第一方远端页面，DOM 够不着，只能走原生层。
/// 只动直开窗：透明的 iframe 启动窗走逐像素 alpha，再叠 SLWA 会打架，故跳过。
#[cfg(windows)]
fn apply_web_opacity(app: &tauri::AppHandle, level: u8) {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };
    for (label, w) in app.webview_windows() {
        if !label.starts_with("web-d") {
            continue;
        }
        if let Ok(hwnd) = w.hwnd() {
            unsafe {
                let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
                SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED.0 as isize);
                let _ = SetLayeredWindowAttributes(hwnd, COLORREF(0), level, LWA_ALPHA);
            }
        }
    }
}

fn direct_geom_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("webdirect_geom.json"))
}

/// 记下直开窗当前几何（逻辑像素），内存 + 落盘。
fn save_direct_geom(app: &tauri::AppHandle, g: (f64, f64, f64, f64)) {
    if let Ok(mut slot) = DIRECT_GEOM.lock() {
        *slot = Some(g);
    }
    if let Some(p) = direct_geom_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(s) = serde_json::to_string(&g) {
            let _ = std::fs::write(p, s);
        }
    }
}

/// 取直开窗几何：先内存、再读盘。
fn load_direct_geom(app: &tauri::AppHandle) -> Option<(f64, f64, f64, f64)> {
    if let Ok(slot) = DIRECT_GEOM.lock() {
        if let Some(g) = *slot {
            return Some(g);
        }
    }
    let s = std::fs::read_to_string(direct_geom_path(app)?).ok()?;
    let g: (f64, f64, f64, f64) = serde_json::from_str(&s).ok()?;
    if let Ok(mut slot) = DIRECT_GEOM.lock() {
        *slot = Some(g);
    }
    Some(g)
}

fn last_url_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("webdirect_lasturl.txt"))
}

/// 看球「直开」窗的实际建窗逻辑：独立顶层窗整窗加载外链（第一方，登录正常）。
/// 无边框、置顶、可缩放，还原上次的大小/位置；建成后把网址记成"上次看的台"（托盘直达用）。
fn open_direct_window(app: &tauri::AppHandle, url: String) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let parsed: tauri::Url = url.parse().map_err(|e| format!("网址无效：{e}"))?;
    let label = format!("web-d{}", DIRECT_SEQ.fetch_add(1, Ordering::Relaxed));
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(parsed))
        .title("看球（直开外链）")
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .initialization_script(NEWWIN_FIX_JS)
        .inner_size(480.0, 320.0);
    if let Some((x, y, w, h)) = load_direct_geom(app) {
        builder = builder.inner_size(w, h).position(x, y);
    }
    builder.build().map_err(|e| e.to_string())?;
    if let Some(p) = last_url_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, url);
    }
    Ok(())
}

/// IPC 入口。必须是 async：Windows 上同步命令占着主线程，WebView2 初始化等不到
/// 主线程→窗壳白屏（官方文档明示）。
#[tauri::command]
async fn web_open_direct(app: tauri::AppHandle, url: String) -> Result<(), String> {
    open_direct_window(&app, url)
}

/// Alt+D 贴角：把所有直开窗甩到屏幕角落，循环 右下→右上→左上→左下。
#[cfg(desktop)]
fn snap_web_corner(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let corner = WEB_CORNER.fetch_add(1, Ordering::Relaxed) % 4;
    for (label, w) in app.webview_windows() {
        if !label.starts_with("web-d") {
            continue;
        }
        let (Ok(Some(mon)), Ok(sz)) = (w.current_monitor(), w.outer_size()) else {
            continue;
        };
        let wa = mon.work_area();
        let m = (12.0 * mon.scale_factor()) as i32;
        let right = wa.position.x + wa.size.width as i32 - sz.width as i32 - m;
        let bottom = wa.position.y + wa.size.height as i32 - sz.height as i32 - m;
        let left = wa.position.x + m;
        let top = wa.position.y + m;
        let (x, y) = match corner {
            0 => (right, bottom),
            1 => (right, top),
            2 => (left, top),
            _ => (left, bottom),
        };
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// Alt+S 截图入库：用 WebView2 原生 CapturePreview 截直开窗当前画面（PNG），
/// 走 import_blob 进素材库，完事广播 library-changed 让网格刷新。
/// 异步 COM：截图完成回调在主线程触发，不阻塞。
#[cfg(windows)]
fn capture_web_to_library(app: &tauri::AppHandle) {
    use tauri::Emitter;
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_8, COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::core::Interface;
    use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;
    use windows::Win32::System::Com::STREAM_SEEK_SET;
    for (label, w) in app.webview_windows() {
        if !label.starts_with("web-d") {
            continue;
        }
        if !w.is_visible().unwrap_or(false) {
            continue;
        }
        let app2 = app.clone();
        let _ = w.with_webview(move |pw| unsafe {
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            // ICoreWebView2 即有 CapturePreview；cast 仅为统一接口版本
            let Ok(core) = core.cast::<ICoreWebView2_8>() else { return };
            let Ok(stream) = CreateStreamOnHGlobal(windows::Win32::Foundation::HGLOBAL(std::ptr::null_mut()), true)
            else {
                return;
            };
            let stream2 = stream.clone();
            let handler = CapturePreviewCompletedHandler::create(Box::new(move |res| {
                if res.is_err() {
                    return Ok(());
                }
                let _ = stream2.Seek(0, STREAM_SEEK_SET, None);
                let mut data = Vec::new();
                let mut buf = [0u8; 65536];
                loop {
                    let mut read = 0u32;
                    let _ = stream2.Read(
                        buf.as_mut_ptr() as *mut _,
                        buf.len() as u32,
                        Some(&mut read as *mut u32),
                    );
                    if read == 0 {
                        break;
                    }
                    data.extend_from_slice(&buf[..read as usize]);
                }
                if data.is_empty() {
                    return Ok(());
                }
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let b64 = {
                    use base64::Engine;
                    base64::engine::general_purpose::STANDARD.encode(&data)
                };
                if library::import_blob(app2.clone(), format!("球赛截图_{ts}.png"), b64).is_ok() {
                    let _ = app2.emit("library-changed", ());
                }
                Ok(())
            }));
            let _ = core.CapturePreview(
                COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                &stream,
                &handler,
            );
        });
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            collect::start_collect_server(app.handle().clone());

            // 看球窗偏好（透明度/缩放）跨重启记忆
            #[cfg(desktop)]
            load_web_prefs(app.handle());

            // 看球小窗全局快捷键（Rust 侧注册——不经 IPC，故无需 capabilities 授权）：
            //   Alt+`  老板键：切所有 web-* 窗显隐
            //   Alt+1  直开窗变淡（更透）   Alt+2  直开窗变浓（更实）
            //   Alt+3  召出/收回直开窗标题栏（无边框时临时切回好移动/缩放/关闭）
            //   Alt+4  直开窗点击穿透 开/关（调淡后鼠标穿过去点下面的画画软件）
            //   Alt+Q  页面缩小 / Alt+W 页面放大（默认随窗宽自动缩；一按这俩即切手动接管）
            //   Alt+E  换台：弹原生输入框，输网址直跳、输搜索词走 Bing（浏览器地址栏逻辑）
            //   Alt+R  快速静音切换（画面留着声音掐掉）  Alt+S  截当前画面进素材库
            //   Alt+D  贴角循环（右下→右上→左上→左下）
            //   Alt+Z  网页后退 / Alt+X 网页前进（无边框没浏览器后退键，进了详情页靠这俩退）
            //   （注：Alt+W 会抢中文版 PS 的「窗口(W)」菜单热键、Alt+Q 抢 Office 搜索——实用影响小，
            //     且键只在看球窗可见时占用，藏起/全关即归还，冲突自然解）
            #[cfg(desktop)]
            {
                use std::sync::atomic::Ordering;
                use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};
                let boss = Shortcut::new(Some(Modifiers::ALT), Code::Backquote);
                let dimmer = Shortcut::new(Some(Modifiers::ALT), Code::Digit1);
                let brighter = Shortcut::new(Some(Modifiers::ALT), Code::Digit2);
                let chrome = Shortcut::new(Some(Modifiers::ALT), Code::Digit3);
                let through = Shortcut::new(Some(Modifiers::ALT), Code::Digit4);
                let zoomout = Shortcut::new(Some(Modifiers::ALT), Code::KeyQ);
                let zoomin = Shortcut::new(Some(Modifiers::ALT), Code::KeyW);
                let navurl = Shortcut::new(Some(Modifiers::ALT), Code::KeyE);
                let mute = Shortcut::new(Some(Modifiers::ALT), Code::KeyR);
                let shot = Shortcut::new(Some(Modifiers::ALT), Code::KeyS);
                let dock = Shortcut::new(Some(Modifiers::ALT), Code::KeyD);
                let back = Shortcut::new(Some(Modifiers::ALT), Code::KeyZ);
                let fwd = Shortcut::new(Some(Modifiers::ALT), Code::KeyX);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            // 可连调键（透明度/缩放）：按下立即走一步并起重复线程（330ms 后
                            // 每 110ms 一步，松开即停）；步进函数自带上下限，按到头自动不动。
                            let repeat_id = if shortcut == &dimmer {
                                1u8
                            } else if shortcut == &brighter {
                                2
                            } else if shortcut == &zoomout {
                                3
                            } else if shortcut == &zoomin {
                                4
                            } else {
                                0
                            };
                            if repeat_id != 0 {
                                if event.state() == ShortcutState::Pressed {
                                    web_step(app, repeat_id);
                                    let my =
                                        HOLD_GEN.fetch_add(1, Ordering::Relaxed).wrapping_add(1);
                                    HOLD_KEY.store(repeat_id, Ordering::Relaxed);
                                    let app2 = app.clone();
                                    std::thread::spawn(move || {
                                        std::thread::sleep(std::time::Duration::from_millis(330));
                                        // 上限 ~12s 兜底：万一平台丢了「松开」事件也不会永转
                                        for _ in 0..110 {
                                            if HOLD_KEY.load(Ordering::Relaxed) != repeat_id
                                                || HOLD_GEN.load(Ordering::Relaxed) != my
                                            {
                                                break;
                                            }
                                            let a = app2.clone();
                                            let _ = app2.run_on_main_thread(move || {
                                                web_step(&a, repeat_id);
                                            });
                                            std::thread::sleep(std::time::Duration::from_millis(
                                                110,
                                            ));
                                        }
                                    });
                                } else {
                                    HOLD_KEY.store(0, Ordering::Relaxed);
                                }
                                return;
                            }
                            if event.state() != ShortcutState::Pressed {
                                return;
                            }
                            if shortcut == &boss {
                                toggle_web_windows(app);
                            } else if shortcut == &chrome {
                                let on = !WEB_DECOR.load(Ordering::Relaxed);
                                WEB_DECOR.store(on, Ordering::Relaxed);
                                for (label, w) in app.webview_windows() {
                                    if label.starts_with("web-d") {
                                        let _ = w.set_decorations(on);
                                    }
                                }
                                // set_decorations 会重写窗口样式、抹掉 layered alpha——
                                // 且异步落地，立即重应用会被反超，延迟补刀（见 reapply 函数 doc）
                                #[cfg(windows)]
                                reapply_web_opacity_soon(app);
                            } else if shortcut == &through {
                                let on = !WEB_THROUGH.load(Ordering::Relaxed);
                                WEB_THROUGH.store(on, Ordering::Relaxed);
                                for (label, w) in app.webview_windows() {
                                    if label.starts_with("web-d") {
                                        let _ = w.set_ignore_cursor_events(on);
                                    }
                                }
                                // 切穿透会增删 WS_EX_LAYERED（Tauri 内部实现），把透明度抹掉——
                                // 同样异步落地，立即+延迟双重应用
                                #[cfg(windows)]
                                reapply_web_opacity_soon(app);
                            } else if shortcut == &navurl {
                                // 换台：优先弹在有焦点的直开窗；都没焦点就全弹（通常只开一个窗）
                                let wins: Vec<_> = app
                                    .webview_windows()
                                    .into_iter()
                                    .filter(|(l, _)| l.starts_with("web-d"))
                                    .map(|(_, w)| w)
                                    .collect();
                                let focused: Vec<_> = wins
                                    .iter()
                                    .filter(|w| w.is_focused().unwrap_or(false))
                                    .collect();
                                // 浏览器地址栏逻辑：像网址→直跳；不像（中文/空格/无点号）→当搜索词
                                //（引擎从菜单「工具→看球搜索引擎」选，默认 Google）
                                const NAV_JS_TPL: &str = r#"(function(){
  var u = prompt('换台：输入网址或搜索词（回车）', '');
  if (!u) return;
  u = u.trim();
  if (!u) return;
  var hasProto = /^[a-z]+:\/\//i.test(u);
  var likeUrl = hasProto || (!/\s/.test(u) && /\./.test(u) && !/[一-鿿]/.test(u));
  location.href = likeUrl
    ? (hasProto ? u : 'https://' + u)
    : '__ENGINE__' + encodeURIComponent(u);
})();"#;
                                let nav_js = NAV_JS_TPL.replace("__ENGINE__", web_engine_prefix());
                                if focused.is_empty() {
                                    for w in &wins {
                                        let _ = w.eval(&nav_js);
                                    }
                                } else {
                                    for w in focused {
                                        let _ = w.eval(&nav_js);
                                    }
                                }
                            } else if shortcut == &mute {
                                // 快速静音：画面留着、声音掐掉（人要说话/开会时）
                                let m = !WEB_MUTED.load(Ordering::Relaxed);
                                WEB_MUTED.store(m, Ordering::Relaxed);
                                #[cfg(windows)]
                                mute_web_windows(app, m);
                            } else if shortcut == &shot {
                                // 截当前画面进素材库
                                #[cfg(windows)]
                                capture_web_to_library(app);
                            } else if shortcut == &dock {
                                snap_web_corner(app);
                            } else if shortcut == &back || shortcut == &fwd {
                                // 网页后退/前进：注入 history.back()/forward()
                                let js = if shortcut == &back {
                                    "history.back()"
                                } else {
                                    "history.forward()"
                                };
                                for (label, w) in app.webview_windows() {
                                    if label.starts_with("web-d")
                                        && w.is_focused().unwrap_or(false)
                                    {
                                        let _ = w.eval(js);
                                    }
                                }
                            }
                        })
                        .build(),
                )?;
                // 注意：启动时不注册任何键——看球窗出现才占用、藏起/全关即归还
                //（见 set_web_hotkeys 与 on_window_event 的生命周期管理），平时不抢系统快捷键。
            }

            // 系统托盘：关窗收进托盘（后台采集/MCP 服务不中断），点图标还原
            let show = MenuItem::with_id(app, "show", "显示 Nobi", true, None::<&str>)?;
            let watch = MenuItem::with_id(app, "watch", "📺 看球（上次的台）", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &watch, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Nobi")
                .menu(&menu)
                .show_menu_on_left_click(false) // 左键还原，右键才出菜单
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "watch" => {
                        // 一键开上次的台（主窗都不用露面）。没记录就弹主窗让用户从菜单进。
                        // 甩到异步线程建窗——别占着主线程（同 IPC 命令的 async 道理）。
                        let last = last_url_path(app).and_then(|p| std::fs::read_to_string(p).ok());
                        match last.filter(|s| !s.trim().is_empty()) {
                            Some(url) => {
                                let app = app.clone();
                                tauri::async_runtime::spawn(async move {
                                    let _ = open_direct_window(&app, url.trim().to_string());
                                });
                            }
                            None => show_main(app),
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // 点窗口关闭按钮 = 收进托盘而非退出（真正退出走托盘菜单「退出」）
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
            // 看球快捷键生命周期：任一 web-* 窗有动静（建窗后必有 Focused/Resized）即占键；
            // 最后一个 web-* 窗关掉即全归还（含老板键）。藏起时的归还在老板键处理里。
            #[cfg(desktop)]
            if window.label().starts_with("web-") {
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let gone = window.label().to_string();
                    let left = window
                        .app_handle()
                        .webview_windows()
                        .into_iter()
                        .filter(|(l, _)| l.starts_with("web-") && *l != gone)
                        .count();
                    if left == 0 {
                        set_web_hotkeys_async(window.app_handle(), false, false);
                        WEB_CTRLS_ON.store(false, std::sync::atomic::Ordering::Relaxed);
                    }
                } else if !WEB_CTRLS_ON.swap(true, std::sync::atomic::Ordering::Relaxed) {
                    set_web_hotkeys_async(window.app_handle(), true, true);
                }
            }

            // 直开窗：记几何（下次开在原地）+ 获焦时套用当前透明度（继承、不用每次重调）
            if window.label().starts_with("web-d") {
                match event {
                    tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                        // 全屏/最小化时的尺寸别记，免得下次开成全屏或巴掌大
                        let skip = window.is_fullscreen().unwrap_or(false)
                            || window.is_minimized().unwrap_or(false);
                        if !skip {
                            let scale = window.scale_factor().unwrap_or(1.0);
                            if let (Ok(pos), Ok(size)) =
                                (window.outer_position(), window.inner_size())
                            {
                                if size.width > 100 && size.height > 100 {
                                    let logical_w = size.width as f64 / scale;
                                    save_direct_geom(
                                        window.app_handle(),
                                        (
                                            pos.x as f64 / scale,
                                            pos.y as f64 / scale,
                                            logical_w,
                                            size.height as f64 / scale,
                                        ),
                                    );
                                    // 自动缩放：随窗宽调页面 zoom（手动接管后不再插手）
                                    if !WEB_ZOOM_MANUAL.load(std::sync::atomic::Ordering::Relaxed)
                                    {
                                        let z = auto_zoom_for_width(logical_w);
                                        if z != WEB_ZOOM
                                            .swap(z, std::sync::atomic::Ordering::Relaxed)
                                        {
                                            if let Some(w) = window
                                                .app_handle()
                                                .get_webview_window(window.label())
                                            {
                                                let _ = w.set_zoom(z as f64 / 100.0);
                                            }
                                            // set_zoom 冲掉 layered alpha——立即+延迟双重应用
                                            #[cfg(windows)]
                                            reapply_web_opacity_soon(window.app_handle());
                                        }
                                    }
                                }
                            }
                        }
                    }
                    tauri::WindowEvent::Focused(true) => {
                        // 先 zoom 后透明度——set_zoom 会把 layered alpha 冲掉，顺序不能反。
                        // 页面缩放：手动模式继承存档；自动模式按本窗当前宽算一档
                        let manual =
                            WEB_ZOOM_MANUAL.load(std::sync::atomic::Ordering::Relaxed);
                        let zoom = if manual {
                            WEB_ZOOM.load(std::sync::atomic::Ordering::Relaxed)
                        } else {
                            let scale = window.scale_factor().unwrap_or(1.0);
                            window
                                .inner_size()
                                .map(|s| auto_zoom_for_width(s.width as f64 / scale))
                                .unwrap_or(100)
                        };
                        if zoom != 100 {
                            WEB_ZOOM.store(zoom, std::sync::atomic::Ordering::Relaxed);
                            if let Some(w) = window
                                .app_handle()
                                .get_webview_window(window.label())
                            {
                                let _ = w.set_zoom(zoom as f64 / 100.0);
                            }
                        }
                        // 透明度：全实(255)时函数自己跳过——别在新窗 WebView2 初始化期就打
                        // WS_EX_LAYERED（本机合成层脆，曾疑致整窗白屏）；调淡过才继承。
                        // 前面刚 set_zoom 过，立即+延迟双重应用防被反超。
                        #[cfg(windows)]
                        reapply_web_opacity_soon(window.app_handle());
                    }
                    _ => {}
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // library
            library::import_folder,
            library::import_paths,
            library::import_blob,
            library::list_assets,
            library::clear_assets,
            library::remove_asset,
            library::remove_assets,
            library::remove_folder,
            library::set_favorite,
            library::set_tags,
            library::add_tag_bulk,
            library::export_metadata,
            // thumbs
            thumbs::build_thumbnails,
            thumbs::set_thumb,
            // ai
            ai::ai_run,
            ai::ai_tag_bulk,
            ai::ai_run_custom,
            ai::list_ai_commands,
            ai::save_ai_command,
            ai::delete_ai_command,
            ai::ai_status,
            ai::pull_model,
            // search
            search::build_embeddings,
            search::semantic_search,
            search::similar_to,
            search::clip_targets,
            search::set_clip_embedding,
            search::clip_search,
            search::clip_similar,
            search::find_duplicates,
            // settings
            settings::get_settings,
            settings::set_settings,
            // board
            board::list_boards,
            board::create_board,
            board::rename_board,
            board::delete_board,
            board::save_board,
            board::load_board,
            board::save_file,
            // collections
            collections::list_collections,
            collections::create_collection,
            collections::add_to_collection,
            collections::remove_from_collection,
            collections::delete_collection,
            collections::rename_collection,
            collections::collection_asset_ids,
            // collect
            collect::export_extension,
            collect::export_mcp_script,
            // 看球直开窗（Rust 侧建窗，记住几何）
            web_open_direct,
            web_set_search_engine
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
