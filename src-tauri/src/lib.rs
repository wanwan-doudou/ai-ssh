//! AI-SSH Terminal - Rust 后端入口
//!
//! 提供 SSH 连接管理、数据持久化、加密等核心功能

mod commands;
mod db;
mod models;
mod provider_utils;
mod services;
mod sftp;
mod ssh;

use commands::sftp::SftpState;
use commands::ssh::SshState;
use sftp::SftpManager;
use ssh::SshManager;
use std::sync::{Arc, Mutex};
use tauri::Manager;

/// 应用状态
pub struct AppState {
    /// 数据库连接
    pub db: Mutex<rusqlite::Connection>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            // 初始化数据库
            let app_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            std::fs::create_dir_all(&app_dir).expect("无法创建应用数据目录");

            let db_path = app_dir.join("ai-ssh.db");
            let conn = db::init_database(&db_path).expect("数据库初始化失败");

            // 管理应用状态
            app.manage(AppState {
                db: Mutex::new(conn),
            });

            // 管理 SSH 状态 (SshManager 内部按会话细粒度加锁)
            app.manage(SshState {
                manager: Arc::new(SshManager::new()),
            });

            // 管理 SFTP 状态
            app.manage(SftpState {
                manager: Arc::new(SftpManager::new()),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 服务器管理命令
            commands::server::get_servers,
            commands::server::add_server,
            commands::server::update_server,
            commands::server::delete_server,
            // Provider 管理命令
            commands::provider::get_providers,
            commands::provider::add_provider,
            commands::provider::update_provider,
            commands::provider::delete_provider,
            commands::provider::set_active_provider,
            commands::provider::test_provider_connection,
            // SSH 命令
            commands::ssh::connect_ssh,
            commands::ssh::disconnect_ssh,
            commands::ssh::write_ssh,
            commands::ssh::resize_ssh,
            commands::ssh::send_ssh_command,
            commands::ssh::get_server_runtime_info,
            commands::ssh::get_server_process_list,
            commands::ssh::get_server_network_connections,
            commands::ssh::get_server_filesystems,
            // AI Chat 命令
            commands::ai_chat::ai_chat,
            commands::ai_chat::ai_chat_stream,
            commands::ai_chat::execute_command_via_ai,
            // SFTP 命令
            commands::sftp::sftp_connect,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_change_dir,
            commands::sftp::sftp_get_current_dir,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_create_file,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_chmod,
            commands::sftp::sftp_download_to_file,
            commands::sftp::sftp_upload_from_file,
            commands::sftp::sftp_read_file,
            commands::sftp::sftp_write_file,
            commands::sftp::sftp_cancel_upload,
            commands::sftp::sftp_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("运行 Tauri 应用时出错");
}
