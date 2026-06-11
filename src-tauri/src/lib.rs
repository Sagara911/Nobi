//! Nobi 后端入口：只做模块声明与命令注册。
//!
//! 模块分层（详见 docs/ARCHITECTURE.md）：
//! - db        数据层（连接/迁移/公共查询）—— 表结构变更只能发生在这里
//! - library   素材库管理（导入/标签/收藏/导出）
//! - thumbs    缩略图与主色调
//! - ai        视觉 AI（打标/提示词/分析/自定义指令/Ollama 管理）
//! - search    检索（CLIP 存取与相似度 / 文本嵌入备用链路）
//! - settings  Provider 配置（用户设置 > 环境变量 > 默认值）
//! - collect   浏览器采集（本地 HTTP 服务 + 扩展导出）

mod ai;
mod board;
mod collect;
mod db;
mod library;
mod mcp_api;
mod search;
mod settings;
mod thumbs;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            collect::start_collect_server(app.handle().clone());
            Ok(())
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
            // collect
            collect::export_extension,
            collect::export_mcp_script
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
