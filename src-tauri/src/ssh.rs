//! SSH 连接管理模块
//!
//! 使用 russh 库实现 SSH 连接，支持密码和密钥认证
//! 通过 PTY 伪终端提供交互式 shell 体验
//!
//! ## 架构设计（简化版）
//! - 后端缓冲任务以固定间隔（50ms）发射数据
//! - 写入操作通过 MPSC Channel 解耦，避免锁竞争

use russh::client::{self, AuthResult};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{ChannelId, ChannelMsg, ChannelWriteHalf};
use russh::keys::ssh_key::PrivateKey;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::models::{AuthType, Server};

/// SSH 客户端处理器
/// 注意：数据接收现在通过 channel.wait() 实现，而不是 Handler 回调
struct SshClientHandler {
    /// 会话 ID
    #[allow(dead_code)]
    session_id: String,
}

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    /// 检查服务器公钥（生产环境应该验证指纹）
    fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        async { Ok(true) }
    }

    /// 处理从服务器接收的数据
    /// 注意：实际数据通过 channel.wait() 接收，此回调不再使用
    fn data(
        &mut self,
        _channel: ChannelId,
        _data: &[u8],
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async { Ok(()) }
    }

    /// 处理 stderr 数据
    /// 注意：实际数据通过 channel.wait() 接收，此回调不再使用
    fn extended_data(
        &mut self,
        _channel: ChannelId,
        _ext: u32,
        _data: &[u8],
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        async { Ok(()) }
    }
}

/// SSH 会话数据（用于 resize 和 disconnect）
struct SshSessionData {
    /// 写端 channel，用于发送 resize 和 eof 命令
    write_half: Arc<Mutex<ChannelWriteHalf<client::Msg>>>,
    running: Arc<RwLock<bool>>,
    // 保存 session 句柄，防止被 drop 导致事件循环停止
    session_handle: Arc<Mutex<client::Handle<SshClientHandler>>>,
}

/// SSH 会话元数据（简化版，无回压）
struct SshSessionMeta {
    #[allow(dead_code)]
    server_name: String,
    session_data: Arc<Mutex<Option<SshSessionData>>>,
    write_tx: mpsc::UnboundedSender<String>,
}

/// SSH 会话管理器
pub struct SshManager {
    sessions: Mutex<HashMap<String, SshSessionMeta>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 加载私钥文件
    fn load_private_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
        let path = Path::new(path);
        let key_data = std::fs::read_to_string(path)
            .map_err(|e| format!("读取私钥文件失败: {:?}", e))?;
        
        if let Some(_pass) = passphrase {
            PrivateKey::from_openssh(key_data.as_bytes())
                .map_err(|e| format!("解析私钥失败: {:?}", e))
                .and_then(|k| {
                    if k.is_encrypted() {
                        PrivateKey::from_openssh(key_data.as_bytes())
                            .map_err(|e| format!("解密私钥失败: {:?}", e))
                    } else {
                        Ok(k)
                    }
                })
        } else {
            PrivateKey::from_openssh(key_data.as_bytes())
                .map_err(|e| format!("加载私钥失败: {:?}", e))
        }
    }

    /// 建立 SSH 连接
    pub async fn connect_async(
        &self,
        session_id: &str,
        server: &Server,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        println!("[SSH] 开始连接 session_id={}, server={}", session_id, server.name);

        let config = client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
            ..Default::default()
        };
        let config = Arc::new(config);

        // 创建数据缓冲通道
        let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Vec<u8>>();
        
        // 启动后台缓冲任务（极简版：50ms 间隔发射）
        let app_handle_clone = app_handle.clone();
        let session_id_clone = session_id.to_string();
        
        tokio::spawn(async move {
            let mut buffer: Vec<u8> = Vec::with_capacity(64 * 1024);
            // 50ms 间隔，每秒约 20 次，足够流畅且减少 IPC 开销
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(50));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            
            loop {
                tokio::select! {
                    _ = interval.tick() => {
                        if !buffer.is_empty() {
                            let text = String::from_utf8_lossy(&buffer).to_string();
                            if app_handle_clone.emit(&format!("ssh-output-{}", session_id_clone), text).is_err() {
                                break;
                            }
                            buffer.clear();
                        }
                    }
                    recv_result = data_rx.recv() => {
                        match recv_result {
                            Some(data) => {
                                buffer.extend_from_slice(&data);
                                
                                // 缓冲超过 64KB 时立即发送
                                if buffer.len() > 64 * 1024 {
                                    let text = String::from_utf8_lossy(&buffer).to_string();
                                    if app_handle_clone.emit(&format!("ssh-output-{}", session_id_clone), text).is_err() {
                                        break;
                                    }
                                    buffer.clear();
                                }
                            }
                            None => {
                                // 通道关闭，发送剩余数据
                                if !buffer.is_empty() {
                                    let text = String::from_utf8_lossy(&buffer).to_string();
                                    let _ = app_handle_clone.emit(&format!("ssh-output-{}", session_id_clone), text);
                                }
                                break;
                            }
                        }
                    }
                }
            }
        });


        // 创建客户端处理器
        let handler = SshClientHandler {
            session_id: session_id.to_string(),
        };

        // 建立连接
        let addr = format!("{}:{}", server.host, server.port);
        println!("[SSH] 正在连接到 {}...", addr);

        let mut session = client::connect(config, addr.clone(), handler)
            .await
            .map_err(|e| format!("SSH 连接失败 ({}): {:?}", addr, e))?;

        println!("[SSH] SSH 连接成功，正在认证...");

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
                
                let private_key = Self::load_private_key(key_path, server.password.as_deref())?;
                
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

        match auth_result {
            AuthResult::Success => {
                println!("[SSH] 认证成功，正在打开通道...");
            }
            AuthResult::Failure { remaining_methods, .. } => {
                return Err(format!("认证失败，可用方法: {:?}", remaining_methods));
            }
        }

        let session_handle = Arc::new(Mutex::new(session));
        let channel = {
            let handle = session_handle.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|e| format!("打开通道失败: {:?}", e))?
        };

        println!("[SSH] 通道已打开，正在请求 PTY...");

        channel
            .request_pty(
                false,
                "xterm-256color",
                80,
                24,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| format!("请求 PTY 失败: {:?}", e))?;

        println!("[SSH] PTY 请求成功，正在启动 shell...");

        channel
            .request_shell(false)
            .await
            .map_err(|e| format!("启动 shell 失败: {:?}", e))?;

        println!("[SSH] Shell 启动成功");

        let running = Arc::new(RwLock::new(true));
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<String>();

        // 使用 split() 分离 channel 的读写端，允许并发操作
        let (mut read_half, write_half) = channel.split();
        let shared_write_half = Arc::new(Mutex::new(write_half));

        // === 读取任务：驱动 SSH 事件循环并接收数据 ===
        let read_data_tx = data_tx.clone();
        let read_running = running.clone();
        let read_session_id = session_id.to_string();
        let app_handle_for_disconnect = app_handle.clone();

        tokio::spawn(async move {
            loop {
                // 检查是否应该停止
                if !*read_running.read().await {
                    break;
                }
                
                // 等待 channel 消息 - 这是驱动 SSH 事件循环的关键！
                match read_half.wait().await {
                    Some(msg) => {
                        match msg {
                            ChannelMsg::Data { data } => {
                                // 将接收到的数据发送到缓冲通道
                                if read_data_tx.send(data.to_vec()).is_err() {
                                    break;
                                }
                            }
                            ChannelMsg::ExtendedData { data, .. } => {
                                // stderr 数据也发送到同一通道
                                let _ = read_data_tx.send(data.to_vec());
                            }
                            ChannelMsg::Eof | ChannelMsg::Close => {
                                break;
                            }
                            _ => {
                                // 其他消息类型（如 WindowAdjust, ExitStatus）可以忽略
                            }
                        }
                    }
                    None => {
                        // channel 关闭
                        break;
                    }
                }
            }
            
            // 通知前端连接已断开
            let _ = app_handle_for_disconnect.emit(&format!("ssh-disconnected-{}", read_session_id), "连接已关闭");
        });


        // === 写入任务：处理用户输入 ===
        let write_channel = shared_write_half.clone();
        let session_id_clone = session_id.to_string();
        let running_clone = running.clone();

        tokio::spawn(async move {
            println!("[SSH] 写入任务启动 session={}", session_id_clone);
            while let Some(data) = write_rx.recv().await {
                if !*running_clone.read().await {
                    break;
                }
                let write_half = write_channel.lock().await;
                if let Err(_e) = write_half.data(data.as_bytes()).await {
                    break;
                }
            }
        });

        let session_data = Arc::new(Mutex::new(Some(SshSessionData {
            write_half: shared_write_half,
            running: running.clone(),
            session_handle: session_handle.clone(),  // 保存 session，防止被 drop
        })));

        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(session_id.to_string(), SshSessionMeta {
                server_name: server.name.clone(),
                session_data,
                write_tx,
            });
        }

        Ok(())
    }


    /// 发送数据到 SSH 会话
    pub async fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        
        let session_meta = sessions.get(session_id)
            .ok_or("会话不存在")?;
        
        session_meta.write_tx
            .send(data.to_string())
            .map_err(|e| format!("发送数据失败: {:?}", e))?;
        
        println!("[SSH] write 完成 session={}", session_id);
        Ok(())
    }

    /// 在现有 SSH 会话里执行一次性命令并返回输出
    pub async fn execute_command(&self, session_id: &str, command: &str) -> Result<String, String> {
        let session_handle = {
            let sessions = self.sessions.lock().await;
            let session_meta = sessions.get(session_id).ok_or("会话不存在")?;
            let session_data = session_meta.session_data.lock().await;
            let data = session_data.as_ref().ok_or("会话已关闭")?;
            data.session_handle.clone()
        };

        let mut channel = {
            let handle = session_handle.lock().await;
            handle
                .channel_open_session()
                .await
                .map_err(|e| format!("打开命令通道失败: {:?}", e))?
        };

        channel
            .exec(true, command)
            .await
            .map_err(|e| format!("执行命令失败: {:?}", e))?;

        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut exit_status: Option<u32> = None;

        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status: status } => exit_status = Some(status),
                ChannelMsg::Eof | ChannelMsg::Close => {}
                _ => {}
            }
        }

        let stdout_text = String::from_utf8_lossy(&stdout).trim().to_string();
        let stderr_text = String::from_utf8_lossy(&stderr).trim().to_string();
        if let Some(status) = exit_status {
            if status != 0 {
                let detail = if !stderr_text.is_empty() { stderr_text } else { stdout_text };
                return Err(format!("命令执行失败 (退出码 {}): {}", status, detail));
            }
        }

        Ok(stdout_text)
    }

    /// 调整终端大小
    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        
        let session_meta = sessions.get(session_id)
            .ok_or("会话不存在")?;
        
        let session_data = session_meta.session_data.lock().await;
        if let Some(ref data) = *session_data {
            let write_half = data.write_half.lock().await;
            write_half
                .window_change(cols, rows, 0, 0)
                .await
                .map_err(|e| format!("调整终端大小失败: {:?}", e))?;
        }
        
        Ok(())
    }

    /// 断开 SSH 连接
    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        
        if let Some(session_meta) = sessions.remove(session_id) {
            let mut session_data = session_meta.session_data.lock().await;
            if let Some(ref mut data) = *session_data {
                *data.running.write().await = false;
                let write_half = data.write_half.lock().await;
                let _ = write_half.eof().await;
            }
        }
        
        Ok(())
    }
}

impl Default for SshManager {
    fn default() -> Self {
        Self::new()
    }
}
