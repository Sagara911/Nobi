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
mod nmt;
mod search;
mod selection_translate;
mod settings;
mod thumbs;
mod translation;

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

/// 打开（或聚焦）聊天启动器窗——托盘「便签」入口，等价前端 openChatWindow。
/// 主窗收在托盘里也能直接开，不用先露面。
fn open_chat_launcher(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("chat") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    // 甩到异步线程建窗——别占主线程（同 open_direct_window：Windows 上同步建窗会白屏）
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::{WebviewUrl, WebviewWindowBuilder};
        let _ = WebviewWindowBuilder::new(&app, "chat", WebviewUrl::App("index.html#chat".into()))
            .title("Nobi 聊天")
            .inner_size(340.0, 420.0)
            .resizable(true)
            .build();
    });
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
    // 藏时暂停在播的视频、显时续播——只恢复「我们暂停的」(标了 data-nobiPaused)，
    // 用户自己手动暂停的不动。视频藏在跨域 iframe 里时够不着（浏览器安全模型）。
    const PAUSE_JS: &str = "document.querySelectorAll('video').forEach(function(v){if(!v.paused){v.dataset.nobiPaused='1';v.pause();}});";
    const PLAY_JS: &str = "document.querySelectorAll('video').forEach(function(v){if(v.dataset.nobiPaused){delete v.dataset.nobiPaused;var p=v.play();if(p&&p.catch)p.catch(function(){});}});";
    let any_visible = wins.iter().any(|w| w.is_visible().unwrap_or(false));
    for w in &wins {
        if any_visible {
            let _ = w.eval(PAUSE_JS); // 先暂停再藏
            let _ = w.hide();
        } else {
            let _ = w.show();
            #[cfg(windows)]
            hide_from_alt_tab(w); // show 可能把窗重新塞回 Alt+Tab，补一刀
            let _ = w.eval(PLAY_JS); // 显出来再续播
        }
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

/// 聊天窗（chat 启动器 + chat-* 房间窗）的标签判定。
fn is_chat_label(l: &str) -> bool {
    l == "chat" || l.starts_with("chat-")
}

/// 聊天老板键的默认加速键（Alt+C，C=Chat，Nobi 里未被看球键占用）。
/// 加速键格式 = 修饰符 + W3C code（"Alt+KeyC"），与前端抓键、Shortcut::from_str 三方一致。
#[cfg(desktop)]
const CHAT_BOSS_ACCEL: &str = "Alt+KeyC";

/// 用户自定义的聊天老板键（空=用默认 CHAT_BOSS_ACCEL）。存 chat_prefs.json，启动时读回。
#[cfg(desktop)]
static CHAT_BOSS_KEY: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// 聊天老板键当前是否占用中（随聊天窗存在占、全关归还，避免长期霸占全局键）。
#[cfg(desktop)]
static CHAT_BOSS_ON: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 当前生效的聊天老板键加速键串（自定义优先，否则默认）。
#[cfg(desktop)]
fn chat_boss_accel() -> String {
    let v = CHAT_BOSS_KEY.lock().map(|s| s.clone()).unwrap_or_default();
    if v.trim().is_empty() {
        CHAT_BOSS_ACCEL.to_string()
    } else {
        v
    }
}

#[cfg(desktop)]
fn chat_boss_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;
    Shortcut::from_str(&chat_boss_accel())
        .or_else(|_| Shortcut::from_str(CHAT_BOSS_ACCEL))
        .expect("默认聊天老板键必须合法")
}

#[cfg(desktop)]
fn chat_prefs_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("chat_prefs.json"))
}

#[cfg(desktop)]
fn save_chat_prefs(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let prefs = serde_json::json!({
        "bossKey": chat_boss_accel(),
        "opacity": CHAT_OPACITY.load(Ordering::Relaxed),
        "opacityDownKey": chat_opacity_down_accel(),
        "opacityUpKey": chat_opacity_up_accel(),
    });
    if let Some(p) = chat_prefs_path(app) {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(p, prefs.to_string());
    }
}

#[cfg(desktop)]
fn load_chat_prefs(app: &tauri::AppHandle) {
    if let Some(p) = chat_prefs_path(app) {
        if let Ok(txt) = std::fs::read_to_string(&p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                if let Some(k) = v.get("bossKey").and_then(|x| x.as_str()) {
                    if let Ok(mut slot) = CHAT_BOSS_KEY.lock() {
                        *slot = k.to_string();
                    }
                }
                if let Some(o) = v.get("opacity").and_then(|x| x.as_u64()) {
                    CHAT_OPACITY.store(o.clamp(80, 255) as u8, std::sync::atomic::Ordering::Relaxed);
                }
                if let Some(k) = v.get("opacityDownKey").and_then(|x| x.as_str()) {
                    if let Ok(mut s) = CHAT_OPACITY_DOWN_KEY.lock() {
                        *s = k.to_string();
                    }
                }
                if let Some(k) = v.get("opacityUpKey").and_then(|x| x.as_str()) {
                    if let Ok(mut s) = CHAT_OPACITY_UP_KEY.lock() {
                        *s = k.to_string();
                    }
                }
            }
        }
    }
}

/// 读当前聊天老板键（前端展示用）。
#[cfg(desktop)]
#[tauri::command]
fn chat_get_boss_key() -> String {
    chat_boss_accel()
}

/// 改聊天老板键：校验→（若正占用）注销旧键→存盘→（若正占用）占用新键。
/// 命令在独立线程执行，同步 register/unregister 不会与主线程 handler 自锁。
#[cfg(desktop)]
#[tauri::command]
fn chat_set_boss_key(app: tauri::AppHandle, accel: String) -> Result<(), String> {
    use std::str::FromStr;
    use std::sync::atomic::Ordering;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let accel = accel.trim().to_string();
    let new_sc = Shortcut::from_str(&accel).map_err(|e| format!("无效的快捷键：{e}"))?;
    let on = CHAT_BOSS_ON.load(Ordering::Relaxed);
    let gs = app.global_shortcut();
    let old_sc = chat_boss_shortcut();
    if on {
        let _ = gs.unregister(old_sc); // 先放开旧键
    }
    // 试注册新键——验证有没有被别的软件全局占用（占用时 register 报错）
    if let Err(e) = gs.register(new_sc) {
        if on {
            let _ = gs.register(old_sc); // 失败则恢复旧键
        }
        return Err(format!("该快捷键可能被其它软件占用，换一个试试（{e}）"));
    }
    if !on {
        let _ = gs.unregister(new_sc); // 当前没有聊天窗，先放开，开窗时再占
    }
    if let Ok(mut slot) = CHAT_BOSS_KEY.lock() {
        *slot = accel;
    }
    save_chat_prefs(&app);
    Ok(())
}

/// 聊天老板键：按一下把所有聊天窗藏起，再按一下全部恢复并聚焦。
#[cfg(desktop)]
fn toggle_chat_windows(app: &tauri::AppHandle) {
    let wins: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(l, _)| is_chat_label(l))
        .map(|(_, w)| w)
        .collect();
    if wins.is_empty() {
        return;
    }
    let any_visible = wins.iter().any(|w| w.is_visible().unwrap_or(false));
    for w in &wins {
        if any_visible {
            let _ = w.hide();
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

/// 占用/归还聊天老板键。注意：从快捷键/窗口事件回调里同步注册会与主线程自锁，
/// 那些地方用 set_chat_boss_async。
#[cfg(desktop)]
fn set_chat_boss(app: &tauri::AppHandle, on: bool) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let sc = chat_boss_shortcut();
    let _ = if on { gs.register(sc) } else { gs.unregister(sc) };
}

#[cfg(desktop)]
fn set_chat_boss_async(app: &tauri::AppHandle, on: bool) {
    let app = app.clone();
    std::thread::spawn(move || set_chat_boss(&app, on));
}

// ===== 聊天窗透明度（Alt+V 调淡 / Alt+B 调浓）=====
// 本机 WebView2 只能走 Win32 原生 alpha（同看球）。键随聊天窗生命周期占用/归还。

#[cfg(desktop)]
static CHAT_OPACITY: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(255);

// 长按连调：当前按住的键(0 无/1 调淡/2 调浓) + 代次(防止旧重复线程乱入)
#[cfg(desktop)]
static CHAT_HOLD: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
#[cfg(desktop)]
static CHAT_HOLD_GEN: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);

#[cfg(desktop)]
const CHAT_OPACITY_DOWN_ACCEL: &str = "Alt+KeyV";
#[cfg(desktop)]
const CHAT_OPACITY_UP_ACCEL: &str = "Alt+KeyB";
// 用户自定义（空=用默认）。存 chat_prefs.json。
#[cfg(desktop)]
static CHAT_OPACITY_DOWN_KEY: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
#[cfg(desktop)]
static CHAT_OPACITY_UP_KEY: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[cfg(desktop)]
fn chat_opacity_down_accel() -> String {
    let v = CHAT_OPACITY_DOWN_KEY.lock().map(|s| s.clone()).unwrap_or_default();
    if v.trim().is_empty() { CHAT_OPACITY_DOWN_ACCEL.to_string() } else { v }
}
#[cfg(desktop)]
fn chat_opacity_up_accel() -> String {
    let v = CHAT_OPACITY_UP_KEY.lock().map(|s| s.clone()).unwrap_or_default();
    if v.trim().is_empty() { CHAT_OPACITY_UP_ACCEL.to_string() } else { v }
}

#[cfg(desktop)]
fn chat_opacity_down_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;
    Shortcut::from_str(&chat_opacity_down_accel())
        .or_else(|_| Shortcut::from_str(CHAT_OPACITY_DOWN_ACCEL))
        .expect("默认合法")
}
#[cfg(desktop)]
fn chat_opacity_up_shortcut() -> tauri_plugin_global_shortcut::Shortcut {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;
    Shortcut::from_str(&chat_opacity_up_accel())
        .or_else(|_| Shortcut::from_str(CHAT_OPACITY_UP_ACCEL))
        .expect("默认合法")
}

#[cfg(desktop)]
fn chat_opacity_shortcuts() -> (
    tauri_plugin_global_shortcut::Shortcut,
    tauri_plugin_global_shortcut::Shortcut,
) {
    (chat_opacity_down_shortcut(), chat_opacity_up_shortcut())
}

/// 读透明度两个键（前端展示）：返回 [调淡键, 调浓键]。
#[cfg(desktop)]
#[tauri::command]
fn chat_get_opacity_keys() -> Vec<String> {
    vec![chat_opacity_down_accel(), chat_opacity_up_accel()]
}

/// 改透明度键：which = "down" | "up"。带冲突检测（被占用则报错并恢复旧键）。
#[cfg(desktop)]
#[tauri::command]
fn chat_set_opacity_key(app: tauri::AppHandle, which: String, accel: String) -> Result<(), String> {
    use std::str::FromStr;
    use std::sync::atomic::Ordering;
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    let accel = accel.trim().to_string();
    let new_sc = Shortcut::from_str(&accel).map_err(|e| format!("无效的快捷键：{e}"))?;
    let is_down = which == "down";
    let old_sc = if is_down { chat_opacity_down_shortcut() } else { chat_opacity_up_shortcut() };
    let on = CHAT_BOSS_ON.load(Ordering::Relaxed); // 透明度键随聊天窗生命周期，与老板键同步
    let gs = app.global_shortcut();
    if on {
        let _ = gs.unregister(old_sc);
    }
    if let Err(e) = gs.register(new_sc) {
        if on {
            let _ = gs.register(old_sc);
        }
        return Err(format!("该快捷键可能被其它软件占用，换一个试试（{e}）"));
    }
    if !on {
        let _ = gs.unregister(new_sc);
    }
    let slot = if is_down { &CHAT_OPACITY_DOWN_KEY } else { &CHAT_OPACITY_UP_KEY };
    if let Ok(mut s) = slot.lock() {
        *s = accel;
    }
    save_chat_prefs(&app);
    Ok(())
}

/// 给所有聊天窗设原生 alpha（SetLayeredWindowAttributes）。
#[cfg(windows)]
fn apply_chat_opacity(app: &tauri::AppHandle, level: u8) {
    use windows::Win32::Foundation::COLORREF;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetLayeredWindowAttributes, SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA,
        WS_EX_LAYERED,
    };
    for (label, w) in app.webview_windows() {
        if !is_chat_label(&label) {
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

/// Alt+V/Alt+B 步进透明度（步 ~10%，下限 80 别让窗彻底没影）。
#[cfg(desktop)]
fn chat_opacity_step(app: &tauri::AppHandle, down: bool) {
    use std::sync::atomic::Ordering;
    let cur = CHAT_OPACITY.load(Ordering::Relaxed);
    let next = if down {
        cur.saturating_sub(26).max(80)
    } else {
        cur.saturating_add(26)
    };
    CHAT_OPACITY.store(next, Ordering::Relaxed);
    #[cfg(windows)]
    apply_chat_opacity(app, next);
    save_chat_prefs(app);
}

/// 占用/归还 Alt+V/Alt+B（随聊天窗生命周期，同老板键）。
#[cfg(desktop)]
fn set_chat_opacity_keys(app: &tauri::AppHandle, on: bool) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let gs = app.global_shortcut();
    let (d, u) = chat_opacity_shortcuts();
    if on {
        let _ = gs.register(d);
        let _ = gs.register(u);
    } else {
        let _ = gs.unregister(d);
        let _ = gs.unregister(u);
    }
}

#[cfg(desktop)]
fn set_chat_opacity_keys_async(app: &tauri::AppHandle, on: bool) {
    let app = app.clone();
    std::thread::spawn(move || set_chat_opacity_keys(&app, on));
}

/// 未读消息数：主窗后台订阅在「用户没看那个群」时累加，打开/聚焦聊天窗清零。
#[cfg(desktop)]
static CHAT_UNREAD: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// 在默认窗口图标右下角叠一个红点，作为"有未读"的托盘图标。
#[cfg(desktop)]
fn badged_tray_icon(app: &tauri::AppHandle) -> Option<tauri::image::Image<'static>> {
    use tauri::Manager;
    let base = app.default_window_icon()?;
    let w = base.width();
    let h = base.height();
    let mut rgba = base.rgba().to_vec();
    let r = (w as f32 * 0.30) as i32;
    let cx = w as i32 - r - 1;
    let cy = h as i32 - r - 1;
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let dx = x - cx;
            let dy = y - cy;
            if dx * dx + dy * dy <= r * r {
                let idx = ((y as u32 * w + x as u32) * 4) as usize;
                if idx + 3 < rgba.len() {
                    rgba[idx] = 235;
                    rgba[idx + 1] = 64;
                    rgba[idx + 2] = 52;
                    rgba[idx + 3] = 255;
                }
            }
        }
    }
    Some(tauri::image::Image::new_owned(rgba, w, h))
}

/// 按当前未读数刷新托盘图标 + tooltip（红点变体 / 还原默认）。
#[cfg(desktop)]
fn update_tray_unread(app: &tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let n = CHAT_UNREAD.load(Ordering::Relaxed);
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    if n > 0 {
        if let Some(icon) = badged_tray_icon(app) {
            let _ = tray.set_icon(Some(icon));
        }
        let _ = tray.set_tooltip(Some(format!("Nobi · {n} 条新消息")));
    } else {
        let _ = tray.set_icon(app.default_window_icon().cloned());
        let _ = tray.set_tooltip(Some("Nobi"));
    }
}

/// 闪烁任务栏按钮(FlashWindowEx)：label 窗存在就闪它，否则闪主窗。一直闪到该窗被带到前台。
#[cfg(windows)]
fn flash_taskbar(app: &tauri::AppHandle, label: &str) {
    use tauri::Manager;
    use windows::Win32::UI::WindowsAndMessaging::{
        FlashWindowEx, FLASHWINFO, FLASHW_ALL, FLASHW_TIMERNOFG,
    };
    // 群窗存在且可见才闪它；关了/藏起(没可见任务栏按钮)就闪主窗
    let win = match app.get_webview_window(label) {
        Some(w) if w.is_visible().unwrap_or(false) => Some(w),
        _ => app.get_webview_window("main"),
    };
    if let Some(w) = win {
        if let Ok(hwnd) = w.hwnd() {
            let mut fi = FLASHWINFO {
                cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                hwnd,
                dwFlags: FLASHW_ALL | FLASHW_TIMERNOFG,
                uCount: 0,
                dwTimeout: 0,
            };
            unsafe {
                let _ = FlashWindowEx(&mut fi);
            }
        }
    }
}

/// 停掉主窗 + 所有聊天窗的任务栏闪烁（已读时调用）。FLASHW_TIMERNOFG 是"闪到前台为止"，
/// 但读消息常发生在聊天窗(主窗没被带到前台)，所以得主动 FLASHW_STOP 停它。
#[cfg(windows)]
fn stop_flash(app: &tauri::AppHandle) {
    use tauri::Manager;
    use windows::Win32::UI::WindowsAndMessaging::{FlashWindowEx, FLASHWINFO, FLASHW_STOP};
    let mut labels: Vec<String> = vec!["main".to_string()];
    for (l, _) in app.webview_windows() {
        if is_chat_label(&l) {
            labels.push(l);
        }
    }
    for l in labels {
        if let Some(w) = app.get_webview_window(&l) {
            if let Ok(hwnd) = w.hwnd() {
                let mut fi = FLASHWINFO {
                    cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                    hwnd,
                    dwFlags: FLASHW_STOP,
                    uCount: 0,
                    dwTimeout: 0,
                };
                unsafe {
                    let _ = FlashWindowEx(&mut fi);
                }
            }
        }
    }
}

/// 收到一条未读（主窗后台订阅调用）：未读 +1、托盘红点 + 任务栏闪烁(label 群窗优先)。
#[cfg(desktop)]
#[tauri::command]
fn chat_bump_unread(app: tauri::AppHandle, label: Option<String>) {
    use std::sync::atomic::Ordering;
    CHAT_UNREAD.fetch_add(1, Ordering::Relaxed);
    update_tray_unread(&app);
    #[cfg(windows)]
    flash_taskbar(&app, label.as_deref().unwrap_or("main"));
}

/// 清零未读（打开/聚焦聊天窗时调用）：托盘恢复正常图标。
#[cfg(desktop)]
#[tauri::command]
fn chat_clear_unread(app: tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    CHAT_UNREAD.store(0, Ordering::Relaxed);
    update_tray_unread(&app);
    #[cfg(windows)]
    stop_flash(&app);
}

/// 把窗口从 Alt+Tab 切换器与任务栏里隐去（加 WS_EX_TOOLWINDOW、去 WS_EX_APPWINDOW）。
/// 用于看球直开窗：藏起来后别再从 Alt+Tab 露馅。代价是任务栏也没有按钮（靠托盘/老板键唤回）。
#[cfg(windows)]
fn hide_from_alt_tab(window: &tauri::WebviewWindow) {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
    };
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            let new = (ex | WS_EX_TOOLWINDOW.0 as isize) & !(WS_EX_APPWINDOW.0 as isize);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, new);
        }
    }
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

/// 看球快捷键的「动作 → 默认加速键」。用户可在看球弹窗里改每一个（解决与其它软件冲突），
/// 改值存进 prefs 的 "keys"。加速键格式 = 修饰符 + W3C code（"Alt+Digit1" "Alt+KeyQ"
/// "Alt+Backquote"），与前端抓键（e.code 拼修饰符）和 Shortcut::from_str 三方一致。
/// 顺序即弹窗里的展示顺序；boss 是老板键（藏起后仍占用，其余归还）。
#[cfg(desktop)]
const KEY_ACTIONS: [(&str, &str); 13] = [
    ("opacityDown", "Alt+Digit1"),
    ("opacityUp", "Alt+Digit2"),
    ("titlebar", "Alt+Digit3"),
    ("through", "Alt+Digit4"),
    ("zoomOut", "Alt+KeyQ"),
    ("zoomIn", "Alt+KeyW"),
    ("nav", "Alt+KeyE"),
    ("back", "Alt+KeyZ"),
    ("forward", "Alt+KeyX"),
    ("mute", "Alt+KeyR"),
    ("shot", "Alt+KeyS"),
    ("dock", "Alt+KeyD"),
    ("boss", "Alt+Backquote"),
];

/// 当前生效的 (动作, 加速键字符串, 解析后的 Shortcut)。启动时 rebuild_web_keys 填充。
#[cfg(desktop)]
static WEB_KEYS: std::sync::Mutex<Vec<(String, String, tauri_plugin_global_shortcut::Shortcut)>> =
    std::sync::Mutex::new(Vec::new());

#[cfg(desktop)]
fn default_accel(action: &str) -> &'static str {
    KEY_ACTIONS
        .iter()
        .find(|(a, _)| *a == action)
        .map(|(_, d)| *d)
        .unwrap_or("")
}

/// 按 默认 + 用户覆盖(overrides) 重建 WEB_KEYS。坏的覆盖（解析失败）退回默认，绝不留空。
#[cfg(desktop)]
fn rebuild_web_keys(overrides: &serde_json::Map<String, serde_json::Value>) {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;
    let mut v = Vec::with_capacity(KEY_ACTIONS.len());
    for (action, def) in KEY_ACTIONS {
        let accel = overrides
            .get(action)
            .and_then(|x| x.as_str())
            .filter(|s| Shortcut::from_str(s).is_ok())
            .unwrap_or(def)
            .to_string();
        if let Ok(sc) = Shortcut::from_str(&accel) {
            v.push((action.to_string(), accel, sc));
        }
    }
    if let Ok(mut slot) = WEB_KEYS.lock() {
        *slot = v;
    }
}

/// 当前相对默认的覆盖项（accel ≠ 默认者），用于存盘与改键时合并。
#[cfg(desktop)]
fn current_key_overrides() -> serde_json::Map<String, serde_json::Value> {
    let mut m = serde_json::Map::new();
    if let Ok(keys) = WEB_KEYS.lock() {
        for (action, accel, _) in keys.iter() {
            if default_accel(action) != accel {
                m.insert(action.clone(), serde_json::Value::String(accel.clone()));
            }
        }
    }
    m
}

/// 占用/归还看球快捷键。boss=老板键（藏起仍占）；ctrls=其余控制键（随可见窗占/还）。
/// 重复注册/注销都吞错（幂等）；注册失败（键被他程序占）也不致命。
///
/// ⚠️ 不要在快捷键回调/窗口事件回调里直接调（它们跑在主线程，而注册/注销内部要等
/// 主线程处理→自锁卡死整个 app）——那些地方一律用 set_web_hotkeys_async。
#[cfg(desktop)]
fn set_web_hotkeys(app: &tauri::AppHandle, boss: bool, ctrls: bool) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
    // 先快照再注册：register 要等主线程，而主线程的快捷键 handler 也要锁 WEB_KEYS——
    // 握着锁去 register 会死锁。snapshot 后立即放锁。
    let snapshot: Vec<(bool, Shortcut)> = match WEB_KEYS.lock() {
        Ok(keys) => keys.iter().map(|(a, _, sc)| (a == "boss", *sc)).collect(),
        Err(_) => return,
    };
    let gs = app.global_shortcut();
    for (is_boss, sc) in snapshot {
        let want = if is_boss { boss } else { ctrls };
        let _ = if want { gs.register(sc) } else { gs.unregister(sc) };
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
        "keys": serde_json::Value::Object(current_key_overrides()), // 只存改过的键
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
    // 无论有没有 prefs 文件，最后都要 rebuild_web_keys（否则 WEB_KEYS 为空、一个键都注册不上）
    let mut key_overrides = serde_json::Map::new();
    if let Some(p) = web_prefs_path(app) {
        if let Ok(s) = std::fs::read_to_string(p) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
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
                if let Some(k) = v.get("keys").and_then(|x| x.as_object()) {
                    key_overrides = k.clone();
                }
            }
        }
    }
    rebuild_web_keys(&key_overrides);
}

/// 看球快捷键命令：取当前绑定（动作, 加速键）给弹窗展示。
#[cfg(desktop)]
#[tauri::command]
fn web_get_keys() -> Vec<(String, String)> {
    WEB_KEYS
        .lock()
        .map(|k| k.iter().map(|(a, ac, _)| (a.clone(), ac.clone())).collect())
        .unwrap_or_default()
}

/// 改一个动作的快捷键。校验可解析 + 不与其它看球动作撞；先注销旧键、重建、按当前窗状态重注册。
/// 命令跑在 worker 线程（非主线程），这里直接 register 不会自锁。
#[cfg(desktop)]
#[tauri::command]
fn web_set_key(app: tauri::AppHandle, action: String, accel: String) -> Result<(), String> {
    use std::str::FromStr;
    use tauri_plugin_global_shortcut::Shortcut;
    if default_accel(&action).is_empty() {
        return Err("未知动作".into());
    }
    let sc = Shortcut::from_str(&accel).map_err(|_| "无法识别的快捷键".to_string())?;
    // 与其它看球动作冲突？
    if let Ok(keys) = WEB_KEYS.lock() {
        if keys.iter().any(|(a, _, s)| *a != action && *s == sc) {
            return Err("和浏览窗里另一个快捷键重复了".into());
        }
    }
    set_web_hotkeys(&app, false, false); // 先把当前全注销（用旧绑定）
    let mut ov = current_key_overrides();
    if accel == default_accel(&action) {
        ov.remove(&action);
    } else {
        ov.insert(action, serde_json::Value::String(accel));
    }
    rebuild_web_keys(&ov);
    save_web_prefs(&app);
    // 按当前窗状态重注册：有任意 web 窗→boss 占；有可见 web 窗→其余也占
    let wins: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(l, _)| l.starts_with("web-"))
        .collect();
    let any = !wins.is_empty();
    let visible = wins.iter().any(|(_, w)| w.is_visible().unwrap_or(false));
    set_web_hotkeys(&app, any, visible);
    Ok(())
}

/// 把看球快捷键全部恢复默认。
#[cfg(desktop)]
#[tauri::command]
fn web_reset_keys(app: tauri::AppHandle) {
    set_web_hotkeys(&app, false, false);
    rebuild_web_keys(&serde_json::Map::new());
    save_web_prefs(&app);
    let wins: Vec<_> = app
        .webview_windows()
        .into_iter()
        .filter(|(l, _)| l.starts_with("web-"))
        .collect();
    let any = !wins.is_empty();
    let visible = wins.iter().any(|(_, w)| w.is_visible().unwrap_or(false));
    set_web_hotkeys(&app, any, visible);
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
        .title("浏览窗（外部网页）")
        .decorations(false)
        .always_on_top(true)
        .resizable(true)
        .initialization_script(NEWWIN_FIX_JS)
        .inner_size(480.0, 320.0);
    if let Some((x, y, w, h)) = load_direct_geom(app) {
        builder = builder.inner_size(w, h).position(x, y);
    }
    let win = builder.build().map_err(|e| e.to_string())?;
    // 从 Alt+Tab / 任务栏隐去（藏起后不从切换器露馅；唤回靠托盘/老板键）
    #[cfg(windows)]
    hide_from_alt_tab(&win);
    let _ = &win;
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
            selection_translate::start(app.handle().clone());

            // 看球窗偏好（透明度/缩放）跨重启记忆
            #[cfg(desktop)]
            load_web_prefs(app.handle());

            // 聊天老板键自定义键跨重启记忆
            #[cfg(desktop)]
            load_chat_prefs(app.handle());

            // 开机自启插件（Windows 走 HKCU Run 项，无需管理员）
            #[cfg(desktop)]
            {
                let _ = app.handle().plugin(tauri_plugin_autostart::init(
                    tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                    None,
                ));
            }

            // 看球小窗全局快捷键。动作→键的映射是可配置的（KEY_ACTIONS 默认值 + 用户在弹窗里改，
            // 存 prefs；启动时 load_web_prefs→rebuild_web_keys 填 WEB_KEYS）。这里只按「按下的键
            // 属于哪个动作」分发；注册/注销见 set_web_hotkeys（只在看球窗可见时占用、藏起/全关归还）。
            // 默认：1/2 透明度·Q/W 页面缩放（均可按住连调）·3 标题栏·4 穿透·E 换台搜索·
            //       Z/X 网页后退前进·R 静音·S 截图入库·D 贴角·` 老板键。
            #[cfg(desktop)]
            {
                use std::sync::atomic::Ordering;
                use tauri_plugin_global_shortcut::ShortcutState;
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, shortcut, event| {
                            // 聊天窗透明度：Alt+V 调淡 / Alt+B 调浓（支持长按连调，同看球）
                            {
                                let (od, ou) = chat_opacity_shortcuts();
                                if *shortcut == od || *shortcut == ou {
                                    let down = *shortcut == od;
                                    let id = if down { 1u8 } else { 2u8 };
                                    if event.state() == ShortcutState::Pressed {
                                        chat_opacity_step(app, down); // 按下立即一步
                                        let my = CHAT_HOLD_GEN
                                            .fetch_add(1, Ordering::Relaxed)
                                            .wrapping_add(1);
                                        CHAT_HOLD.store(id, Ordering::Relaxed);
                                        let app2 = app.clone();
                                        std::thread::spawn(move || {
                                            std::thread::sleep(std::time::Duration::from_millis(330));
                                            for _ in 0..200 {
                                                if CHAT_HOLD.load(Ordering::Relaxed) != id
                                                    || CHAT_HOLD_GEN.load(Ordering::Relaxed) != my
                                                {
                                                    break;
                                                }
                                                let a = app2.clone();
                                                let _ = app2.run_on_main_thread(move || {
                                                    chat_opacity_step(&a, down)
                                                });
                                                std::thread::sleep(
                                                    std::time::Duration::from_millis(110),
                                                );
                                            }
                                        });
                                    } else {
                                        CHAT_HOLD.store(0, Ordering::Relaxed);
                                    }
                                    return;
                                }
                            }
                            // 聊天老板键：先于看球键判定（按一下藏所有聊天窗，再按恢复）
                            if *shortcut == chat_boss_shortcut() {
                                if event.state() == ShortcutState::Pressed {
                                    toggle_chat_windows(app);
                                }
                                return;
                            }
                            // 按下的键属于哪个看球动作？（动态查 WEB_KEYS）
                            let action = WEB_KEYS.lock().ok().and_then(|keys| {
                                keys.iter()
                                    .find(|(_, _, sc)| sc == shortcut)
                                    .map(|(a, _, _)| a.clone())
                            });
                            let Some(action) = action else { return };

                            // 可连调键（透明度/缩放）：按下立即走一步 + 起重复线程（330ms 后每
                            // 110ms 一步，松开即停）；步进函数自带上下限，按到头自动不动。
                            let repeat_id = match action.as_str() {
                                "opacityDown" => 1u8,
                                "opacityUp" => 2,
                                "zoomOut" => 3,
                                "zoomIn" => 4,
                                _ => 0,
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
                            match action.as_str() {
                                "boss" => toggle_web_windows(app),
                                "titlebar" => {
                                    let on = !WEB_DECOR.load(Ordering::Relaxed);
                                    WEB_DECOR.store(on, Ordering::Relaxed);
                                    for (label, w) in app.webview_windows() {
                                        if label.starts_with("web-d") {
                                            let _ = w.set_decorations(on);
                                        }
                                    }
                                    // set_decorations 异步重写窗样式、抹掉 layered alpha→立即+延迟补刀
                                    #[cfg(windows)]
                                    reapply_web_opacity_soon(app);
                                }
                                "through" => {
                                    let on = !WEB_THROUGH.load(Ordering::Relaxed);
                                    WEB_THROUGH.store(on, Ordering::Relaxed);
                                    for (label, w) in app.webview_windows() {
                                        if label.starts_with("web-d") {
                                            let _ = w.set_ignore_cursor_events(on);
                                        }
                                    }
                                    #[cfg(windows)]
                                    reapply_web_opacity_soon(app);
                                }
                                "nav" => {
                                    // 换台：优先弹在有焦点的直开窗；都没焦点就全弹（通常只一个窗）
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
                                    // 像网址→直跳；不像（中文/空格/无点号）→走所选引擎搜
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
                                    let nav_js =
                                        NAV_JS_TPL.replace("__ENGINE__", web_engine_prefix());
                                    if focused.is_empty() {
                                        for w in &wins {
                                            let _ = w.eval(&nav_js);
                                        }
                                    } else {
                                        for w in focused {
                                            let _ = w.eval(&nav_js);
                                        }
                                    }
                                }
                                "mute" => {
                                    let m = !WEB_MUTED.load(Ordering::Relaxed);
                                    WEB_MUTED.store(m, Ordering::Relaxed);
                                    #[cfg(windows)]
                                    mute_web_windows(app, m);
                                }
                                "shot" => {
                                    #[cfg(windows)]
                                    capture_web_to_library(app);
                                }
                                "dock" => snap_web_corner(app),
                                "back" | "forward" => {
                                    let js = if action == "back" {
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
                                _ => {}
                            }
                        })
                        .build(),
                )?;
                // 启动时不注册任何键——看球窗出现才占用、藏起/全关即归还（见 set_web_hotkeys
                // 与 on_window_event 的生命周期管理），平时不抢系统快捷键。
            }

            // 系统托盘：关窗收进托盘（后台采集/MCP 服务不中断），点图标还原
            let show = MenuItem::with_id(app, "show", "显示 Nobi", true, None::<&str>)?;
            let watch = MenuItem::with_id(app, "watch", "🌐 浏览窗（上次的页）", true, None::<&str>)?;
            let note = MenuItem::with_id(app, "note", "📝 便签", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &watch, &note, &quit])?;
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
                    "note" => open_chat_launcher(app),
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

            // 聊天老板键生命周期：任一聊天窗有动静即占用 Alt+\\；最后一个聊天窗关掉即归还。
            #[cfg(desktop)]
            if is_chat_label(window.label()) {
                use std::sync::atomic::Ordering;
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    let gone = window.label().to_string();
                    let left = window
                        .app_handle()
                        .webview_windows()
                        .into_iter()
                        .filter(|(l, _)| is_chat_label(l) && *l != gone)
                        .count();
                    if left == 0 {
                        set_chat_boss_async(window.app_handle(), false);
                        set_chat_opacity_keys_async(window.app_handle(), false);
                        CHAT_BOSS_ON.store(false, Ordering::Relaxed);
                    }
                } else {
                    if !CHAT_BOSS_ON.swap(true, Ordering::Relaxed) {
                        set_chat_boss_async(window.app_handle(), true);
                        set_chat_opacity_keys_async(window.app_handle(), true);
                    }
                    // 新窗/获焦继承当前透明度（仅调淡过才打 layered，避免初始化期白屏）
                    #[cfg(windows)]
                    if CHAT_OPACITY.load(Ordering::Relaxed) < 255 {
                        apply_chat_opacity(window.app_handle(), CHAT_OPACITY.load(Ordering::Relaxed));
                    }
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
            // translation
            translation::translate_text,
            translation::list_glossary_terms,
            translation::save_glossary_term,
            translation::delete_glossary_term,
            translation::list_translation_history,
            nmt::nmt_status,
            nmt::download_nmt_models,
            selection_translate::close_selection_translate_window,
            selection_translate::get_selection_translate_enabled,
            selection_translate::set_selection_translate_enabled,
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
            web_set_search_engine,
            web_get_keys,
            web_set_key,
            web_reset_keys,
            // 聊天老板键（Alt+C 默认，可改键）
            chat_get_boss_key,
            chat_set_boss_key,
            chat_get_opacity_keys,
            chat_set_opacity_key,
            chat_bump_unread,
            chat_clear_unread
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
