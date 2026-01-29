//! SSH 命令接口
//!
//! 提供 Tauri 命令接口，连接前端和 SSH 管理器

use crate::models::Server;
use crate::ssh::SshManager;
use crate::AppState;
use rusqlite::params;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

/// SSH 管理器状态
pub struct SshState {
    pub manager: Arc<Mutex<SshManager>>,
}

/// 建立 SSH 连接
#[tauri::command]
pub async fn connect_ssh(
    session_id: String,
    server_id: String,
    app_state: State<'_, AppState>,
    ssh_state: State<'_, SshState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    println!("[CMD] connect_ssh 命令被调用: session_id={}, server_id={}", session_id, server_id);
    
    // 从数据库获取服务器信息
    let server = {
        let conn = app_state.db.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = conn
            .prepare("SELECT id, name, host, port, username, auth_type, password, private_key_path, group_name, created_at, updated_at FROM servers WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        
        let server = stmt
            .query_row(params![server_id], |row| {
                use crate::models::AuthType;
                Ok(Server {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get::<_, i64>(3)? as u16,
                    username: row.get(4)?,
                    auth_type: row.get::<_, String>(5)?.parse().unwrap_or(AuthType::Password),
                    password: row.get(6)?,
                    private_key_path: row.get(7)?,
                    group: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(|e| format!("服务器不存在: {}", e))?;
        
        server
    };

    // 建立 SSH 连接
    let manager = ssh_state.manager.lock().await;
    manager.connect_async(&session_id, &server, app_handle).await?;
    
    Ok(())
}

/// 断开 SSH 连接
#[tauri::command]
pub async fn disconnect_ssh(
    session_id: String,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    let manager = ssh_state.manager.lock().await;
    manager.disconnect(&session_id).await?;
    Ok(())
}

/// 发送数据到 SSH 会话
#[tauri::command]
pub async fn write_ssh(
    session_id: String,
    data: String,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    let manager = ssh_state.manager.lock().await;
    manager.write(&session_id, &data).await?;
    Ok(())
}

/// 调整终端窗口大小
#[tauri::command]
pub async fn resize_ssh(
    session_id: String,
    cols: u32,
    rows: u32,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    let manager = ssh_state.manager.lock().await;
    manager.resize(&session_id, cols, rows).await?;
    Ok(())
}

/// 发送 SSH 命令 (保留兼容性)
#[tauri::command]
pub async fn send_ssh_command(
    session_id: String,
    command: String,
    ssh_state: State<'_, SshState>,
) -> Result<String, String> {
    let manager = ssh_state.manager.lock().await;
    // 发送命令并添加换行符
    manager.write(&session_id, &format!("{}\n", command)).await?;
    Ok("命令已发送".to_string())
}
