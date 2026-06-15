//! System selection translation trigger.
//!
//! Windows gives every app its own context menu, so Nobi cannot inject a native
//! menu item into all programs. Instead we listen for global right-clicks, read
//! the current text selection through UI Automation, and ask the frontend to
//! show a small Nobi-owned popover near the cursor.

#[cfg(windows)]
use serde::Serialize;

#[cfg(windows)]
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    OnceLock,
};

#[cfg(windows)]
use tauri::Emitter;

use tauri::Manager;

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionTranslatePayload {
    text: String,
    x: i32,
    y: i32,
    source_app: String,
}

#[cfg(windows)]
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SelectionTranslateClickPayload {
    x: i32,
    y: i32,
}

#[cfg(windows)]
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();
#[cfg(windows)]
static STARTED: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static LAST_RIGHT_CLICK_MS: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
const RIGHT_CLICK_DEBOUNCE_MS: u64 = 160;
#[cfg(windows)]
const CLIP_SENTINEL: &str = "__NOBI_SELECTION_TRANSLATE_SENTINEL__";

pub fn start(app: tauri::AppHandle) {
    #[cfg(windows)]
    start_windows(app);

    #[cfg(not(windows))]
    let _ = app;
}

#[tauri::command]
pub fn close_selection_translate_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("selection-translate") {
        let _ = w.hide();
    }
    Ok(())
}

#[cfg(windows)]
fn start_windows(app: tauri::AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = APP.set(app);

    std::thread::spawn(move || unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{
            DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage,
            UnhookWindowsHookEx, MSG, WH_MOUSE_LL,
        };

        let Ok(hook) = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_hook), None, 0) else {
            STARTED.store(false, Ordering::SeqCst);
            return;
        };

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        let _ = UnhookWindowsHookEx(hook);
        STARTED.store(false, Ordering::SeqCst);
    });
}

#[cfg(windows)]
unsafe extern "system" fn mouse_hook(
    ncode: i32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::UI::WindowsAndMessaging::{
        CallNextHookEx, MSLLHOOKSTRUCT, WM_LBUTTONDOWN, WM_RBUTTONDOWN,
    };

    if ncode >= 0 && (wparam.0 as u32 == WM_RBUTTONDOWN || wparam.0 as u32 == WM_LBUTTONDOWN) {
        let info = *(lparam.0 as *const MSLLHOOKSTRUCT);
        if wparam.0 as u32 == WM_RBUTTONDOWN {
            handle_right_click(info.pt.x, info.pt.y, info.time as u64);
        } else {
            handle_left_click(info.pt.x, info.pt.y);
        }
    }

    CallNextHookEx(None, ncode, wparam, lparam)
}

#[cfg(windows)]
fn handle_left_click(x: i32, y: i32) {
    let Some(app) = APP.get() else {
        return;
    };
    let Some(w) = app.get_webview_window("selection-translate") else {
        return;
    };
    if !w.is_visible().unwrap_or(false) {
        return;
    }
    if is_own_process_point(x, y) || is_point_in_translate_window(&w, x, y) {
        return;
    }
    let _ = app.emit_to(
        "selection-translate",
        "selection-translate-left-clicked",
        SelectionTranslateClickPayload { x, y },
    );
}

#[cfg(windows)]
fn is_point_in_translate_window(w: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let (Ok(pos), Ok(size)) = (w.outer_position(), w.outer_size()) else {
        return false;
    };
    let right = pos.x.saturating_add(size.width as i32);
    let bottom = pos.y.saturating_add(size.height as i32);
    x >= pos.x && x <= right && y >= pos.y && y <= bottom
}

#[cfg(windows)]
fn handle_right_click(x: i32, y: i32, event_ms: u64) {
    let last = LAST_RIGHT_CLICK_MS.load(Ordering::Relaxed);
    if event_ms.saturating_sub(last) < RIGHT_CLICK_DEBOUNCE_MS {
        return;
    }
    LAST_RIGHT_CLICK_MS.store(event_ms, Ordering::Relaxed);

    if is_own_process_point(x, y) {
        return;
    }

    std::thread::spawn(move || {
        let Some((text, source_app)) = read_selected_text(x, y) else {
            return;
        };
        if text.chars().count() < 2 {
            return;
        }
        if !looks_translatable(&text) {
            return;
        }

        let text = clamp_text(text, 2_000);
        if let Some(app) = APP.get() {
            let _ = app.emit(
                "selection-translate-requested",
                SelectionTranslatePayload {
                    text,
                    x,
                    y,
                    source_app,
                },
            );
        }
    });
}

#[cfg(windows)]
fn is_own_process_point(x: i32, y: i32) -> bool {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Threading::GetCurrentProcessId;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, WindowFromPoint};

    unsafe {
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.0.is_null() {
            return false;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        pid != 0 && pid == GetCurrentProcessId()
    }
}

#[cfg(windows)]
fn read_selected_text(x: i32, y: i32) -> Option<(String, String)> {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
    use windows::Win32::System::Ole::{OleInitialize, OleUninitialize};
    use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation};

    unsafe {
        if OleInitialize(None).is_err() {
            return None;
        }

        let out = (|| {
            let automation: IUIAutomation =
                CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;

            if let Ok(el) = automation.GetFocusedElement() {
                if let Some(text) = selected_text_from_element(el) {
                    return Some((text, "windows-uia".into()));
                }
            }

            if let Ok(el) = automation.ElementFromPoint(POINT { x, y }) {
                if let Some(text) = selected_text_from_element(el) {
                    return Some((text, "windows-uia".into()));
                }
            }

            if should_try_clipboard_fallback(x, y) {
                if let Some(text) = read_selected_text_from_clipboard_copy() {
                    return Some((text, "windows-clipboard".into()));
                }
            }

            None
        })();

        OleUninitialize();
        out
    }
}

#[cfg(windows)]
fn should_try_clipboard_fallback(x: i32, y: i32) -> bool {
    let class_name = window_class_at_point(x, y).to_ascii_lowercase();
    if class_name.contains("consolewindowclass")
        || class_name.contains("cascadia")
        || class_name.contains("mintty")
        || class_name.contains("wezterm")
    {
        return false;
    }
    true
}

#[cfg(windows)]
fn window_class_at_point(x: i32, y: i32) -> String {
    use windows::Win32::Foundation::POINT;
    use windows::Win32::UI::WindowsAndMessaging::{GetClassNameW, WindowFromPoint};

    unsafe {
        let hwnd = WindowFromPoint(POINT { x, y });
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut buf = [0u16; 256];
        let len = GetClassNameW(hwnd, &mut buf);
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..len as usize])
    }
}

#[cfg(windows)]
fn read_selected_text_from_clipboard_copy() -> Option<String> {
    use windows::Win32::System::Ole::{OleGetClipboard, OleSetClipboard};

    unsafe {
        let old_clipboard = OleGetClipboard().ok();
        let old_text = read_clipboard_text();
        if !set_clipboard_text(CLIP_SENTINEL) {
            return None;
        }

        send_ctrl_c();
        let copied = wait_for_copied_clipboard_text();

        if let Some(old) = old_clipboard {
            let _ = OleSetClipboard(&old);
        }
        if let Some(old_text) = old_text {
            let _ = set_clipboard_text(&old_text);
        } else {
            clear_clipboard();
        }

        let text = copied?.trim().to_string();
        if text.is_empty() || text == CLIP_SENTINEL {
            return None;
        }
        Some(text)
    }
}

#[cfg(windows)]
fn wait_for_copied_clipboard_text() -> Option<String> {
    let start = std::time::Instant::now();
    loop {
        if let Some(text) = read_clipboard_text() {
            let text = text.trim().to_string();
            if !text.is_empty() && text != CLIP_SENTINEL {
                return Some(text);
            }
        }

        if start.elapsed() >= std::time::Duration::from_millis(150) {
            return read_clipboard_text();
        }
        std::thread::sleep(std::time::Duration::from_millis(16));
    }
}

#[cfg(windows)]
fn send_ctrl_c() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_C, VK_CONTROL,
    };

    fn key(vk: windows::Win32::UI::Input::KeyboardAndMouse::VIRTUAL_KEY, up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: vk,
                    wScan: 0,
                    dwFlags: if up {
                        KEYEVENTF_KEYUP
                    } else {
                        Default::default()
                    },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    let inputs = [
        key(VK_CONTROL, false),
        key(VK_C, false),
        key(VK_C, true),
        key(VK_CONTROL, true),
    ];
    unsafe {
        let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(windows)]
fn read_clipboard_text() -> Option<String> {
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        OpenClipboard(None).ok()?;
        let out = (|| {
            IsClipboardFormatAvailable(CF_UNICODETEXT.0 as u32).ok()?;
            let handle = GetClipboardData(CF_UNICODETEXT.0 as u32).ok()?;
            let hglobal = HGLOBAL(handle.0);
            let ptr = GlobalLock(hglobal) as *const u16;
            if ptr.is_null() {
                return None;
            }
            let units = GlobalSize(hglobal) / std::mem::size_of::<u16>();
            let slice = std::slice::from_raw_parts(ptr, units);
            let len = slice.iter().position(|c| *c == 0).unwrap_or(slice.len());
            let text = String::from_utf16_lossy(&slice[..len]);
            let _ = GlobalUnlock(hglobal);
            Some(text)
        })();
        let _ = CloseClipboard();
        out
    }
}

#[cfg(windows)]
fn set_clipboard_text(text: &str) -> bool {
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;

    unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let ok = (|| {
            EmptyClipboard().ok()?;
            let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
            let bytes = wide.len() * std::mem::size_of::<u16>();
            let hglobal = GlobalAlloc(GMEM_MOVEABLE, bytes).ok()?;
            let ptr = GlobalLock(hglobal) as *mut u16;
            if ptr.is_null() {
                return None;
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
            let _ = GlobalUnlock(hglobal);
            SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(hglobal.0))).ok()?;
            Some(())
        })()
        .is_some();
        let _ = CloseClipboard();
        ok
    }
}

#[cfg(windows)]
fn clear_clipboard() {
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard};

    unsafe {
        if OpenClipboard(None).is_ok() {
            let _ = EmptyClipboard();
            let _ = CloseClipboard();
        }
    }
}

#[cfg(windows)]
fn selected_text_from_element(
    element: windows::Win32::UI::Accessibility::IUIAutomationElement,
) -> Option<String> {
    use windows::core::Interface;
    use windows::Win32::UI::Accessibility::{IUIAutomationTextPattern, UIA_TextPatternId};

    unsafe {
        let pattern = element.GetCurrentPattern(UIA_TextPatternId).ok()?;
        let text_pattern: IUIAutomationTextPattern = pattern.cast().ok()?;
        let ranges = text_pattern.GetSelection().ok()?;
        let count = ranges.Length().ok()?;
        if count <= 0 {
            return None;
        }

        let mut out = String::new();
        for i in 0..count.min(8) {
            let range = ranges.GetElement(i).ok()?;
            let text = range.GetText(2_000).ok()?.to_string();
            let text = text.trim();
            if !text.is_empty() {
                if !out.is_empty() {
                    out.push('\n');
                }
                out.push_str(text);
            }
        }

        let normalized = out.trim().to_string();
        (!normalized.is_empty()).then_some(normalized)
    }
}

#[cfg(windows)]
fn looks_translatable(text: &str) -> bool {
    // Pop the popover for any real-language selection (Latin, CJK, Cyrillic,
    // Hangul, …). We only suppress selections that are essentially pure
    // numbers, punctuation, or symbols, where translation is meaningless.
    let mut letters = 0usize;
    for ch in text.chars() {
        if ch.is_alphabetic() || is_cjk_char(ch) {
            letters += 1;
        }
    }
    letters >= 2
}

#[cfg(windows)]
fn is_cjk_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3040..=0x30ff
            | 0x3400..=0x4dbf
            | 0x4e00..=0x9fff
            | 0xac00..=0xd7af
            | 0xf900..=0xfaff
            | 0x20000..=0x2a6df
            | 0x2a700..=0x2b73f
            | 0x2b740..=0x2b81f
            | 0x2b820..=0x2ceaf
    )
}

#[cfg(all(test, windows))]
mod selection_translate_tests {
    use super::looks_translatable;

    #[test]
    fn pops_for_any_language() {
        assert!(looks_translatable(
            "This sentence should be detected as text."
        ));
        assert!(looks_translatable("ambient_occlusion"));
        assert!(looks_translatable("UV"));
        assert!(looks_translatable("这是一段中文"));
        assert!(looks_translatable("翻译 translate"));
        assert!(looks_translatable("これは日本語"));
    }

    #[test]
    fn ignores_pure_symbols_and_numbers() {
        assert!(!looks_translatable("12345 / 67890"));
        assert!(!looks_translatable("--- *** ==="));
        assert!(!looks_translatable("a"));
    }
}

#[cfg(windows)]
fn clamp_text(text: String, max_chars: usize) -> String {
    let mut out = String::with_capacity(text.len().min(max_chars));
    for (i, ch) in text.chars().enumerate() {
        if i >= max_chars {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}
