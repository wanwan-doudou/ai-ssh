//! SFTP 相关 Tauri 命令
//!
//! 提供文件浏览、上传、下载等 SFTP 功能的前端接口

use crate::models::{AuthType, Server};
use crate::sftp::{FileEntry, SftpManager};
use crate::AppState;
use rusqlite::params;
use russh::client::{self, AuthResult};
use russh::keys::PrivateKeyWithHashAlg;
use russh::keys::ssh_key::PrivateKey;
use std::path::Path;
use std::sync::Arc;

use tauri::State;
use tokio::sync::{Mutex, MutexGuard};

/// SFTP 状态
pub struct SftpState {
    pub manager: Arc<SftpManager>,
}

use crate::sftp::SftpClientHandler;

// SftpClientHandler 已移动到 crate::sftp


/// 加载私钥文件
fn load_private_key(path: &str, _passphrase: Option<&str>) -> Result<PrivateKey, String> {
    let path = Path::new(path);
    let key_data = std::fs::read_to_string(path)
        .map_err(|e| format!("读取私钥文件失败: {:?}", e))?;
    
    PrivateKey::from_openssh(key_data.as_bytes())
        .map_err(|e| format!("加载私钥失败: {:?}", e))
}

/// 建立 SFTP 连接
#[tauri::command]
pub async fn sftp_connect(
    state: State<'_, SftpState>,
    app_state: State<'_, AppState>,
    session_id: String,
    server_id: String,
) -> Result<String, String> {
    println!("[SFTP] 建立 SFTP 连接: session_id={}, server_id={}", session_id, server_id);
    
    // 从数据库获取服务器信息
    let server = {
        let conn = app_state.db.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = conn
            .prepare("SELECT id, name, host, port, username, auth_type, password, private_key_path, group_name, created_at, updated_at FROM servers WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        
        stmt.query_row(params![server_id], |row| {
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
        .map_err(|e| format!("服务器不存在: {}", e))?
    };
    
    // 创建 SSH 配置
    let config = client::Config {
        inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
        ..Default::default()
    };
    let config = Arc::new(config);
    
    // 建立 SSH 连接
    let addr = format!("{}:{}", server.host, server.port);
    let mut session = client::connect(config, addr.clone(), SftpClientHandler)
        .await
        .map_err(|e| format!("SSH 连接失败: {:?}", e))?;
    
    // 认证
    let auth_result = match &server.auth_type {
        AuthType::Password => {
            let password = server.password.as_ref()
                .ok_or("密码认证需要提供密码")?;
            session
                .authenticate_password(&server.username, password)
                .await
                .map_err(|e| format!("密码认证失败: {:?}", e))?
        }
        AuthType::PrivateKey => {
            let key_path = server.private_key_path.as_ref()
                .ok_or("密钥认证需要提供私钥路径")?;
            
            let private_key = load_private_key(key_path, server.password.as_deref())?;
            
            let hash_alg = session.best_supported_rsa_hash().await
                .map_err(|e| format!("获取 RSA 哈希算法失败: {:?}", e))?
                .flatten();
            
            let key_with_hash = PrivateKeyWithHashAlg::new(
                Arc::new(private_key),
                hash_alg
            );

            session
                .authenticate_publickey(&server.username, key_with_hash)
                .await
                .map_err(|e| format!("密钥认证失败: {:?}", e))?
        }
    };
    
    // 检查认证结果
    match auth_result {
        AuthResult::Success => {
            println!("[SFTP] 认证成功");
        }
        AuthResult::Failure { remaining_methods, .. } => {
            return Err(format!("认证失败，可用方法: {:?}", remaining_methods));
        }
    }
    
    // 打开 SFTP 通道
    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("打开通道失败: {:?}", e))?;
    
    // 连接到 SFTP
    let manager = &state.manager;
    // 连接到 SFTP
    let manager = &state.manager;
    manager.connect(&session_id, channel, session).await?;
    
    // 获取当前目录
    let current_dir = manager.get_current_dir(&session_id).await?;
    
    println!("[SFTP] SFTP 连接成功，当前目录: {}", current_dir);
    Ok(current_dir)
}

/// 列出目录内容
#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let manager = &state.manager;
    manager.list_dir(&session_id, &path).await
}

/// 更改当前目录
#[tauri::command]
pub async fn sftp_change_dir(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let manager = &state.manager;
    manager.change_dir(&session_id, &path).await
}

/// 获取当前工作目录
#[tauri::command]
pub async fn sftp_get_current_dir(
    state: State<'_, SftpState>,
    session_id: String,
) -> Result<String, String> {
    let manager = &state.manager;
    manager.get_current_dir(&session_id).await
}

/// 创建目录
#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.mkdir(&session_id, &path).await
}

/// 创建空文件
#[tauri::command]
pub async fn sftp_create_file(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.create_file(&session_id, &path).await
}

/// 删除文件或目录
#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.remove(&session_id, &path, is_dir).await
}

/// 重命名文件或目录
#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SftpState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.rename(&session_id, &old_path, &new_path).await
}

/// 修改文件或目录权限
#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.chmod(&session_id, &path, mode).await
}

/// 取消上传 - 高性能上传（taskId）
#[tauri::command]
pub async fn sftp_cancel_upload(
    state: State<'_, SftpState>,
    session_id: String,
    token: String,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.cancel_upload(&session_id, &token).await
}

/// 下载文件直接保存到本地路径（高性能，避免 Base64 开销）
#[tauri::command]
pub async fn sftp_download_to_file(
    state: State<'_, SftpState>,
    app: tauri::AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
    task_id: Option<String>,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.download_to_file(
        &session_id,
        &remote_path,
        &local_path,
        task_id.as_deref(),
        Some(app),
    ).await
}

/// 从本地文件高性能上传到远程（直接读取本地文件，使用 8MB 分块）
/// 取消机制：通过 cancelled_tasks 标志实现，在每个分块写入后检查
#[tauri::command]
pub async fn sftp_upload_from_file(
    state: State<'_, SftpState>,
    app: tauri::AppHandle,
    session_id: String,
    local_path: String,
    remote_path: String,
    task_id: Option<String>,
) -> Result<(), String> {
    // 直接调用上传方法，取消通过 is_task_cancelled 检查实现
    let manager = &state.manager;
    manager.upload_from_file(
        &session_id,
        &local_path,
        &remote_path,
        task_id.as_deref(),
        Some(app),
    ).await
}


/// 读取文件内容
#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
) -> Result<String, String> {
    let manager = &state.manager;
    let content = manager.read_file(&session_id, &path).await?;
    
    // 尝试转为 UTF-8 String
    String::from_utf8(content)
        .map_err(|e| format!("文件不是有效的文本文件 (UTF-8 解析失败): {:?}", e))
}

/// 写入文件内容
#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, SftpState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.write_file(&session_id, &path, content.as_bytes()).await
}

/// 断开 SFTP 会话
#[tauri::command]
pub async fn sftp_disconnect(
    state: State<'_, SftpState>,
    session_id: String,
) -> Result<(), String> {
    let manager = &state.manager;
    manager.disconnect(&session_id).await
}

