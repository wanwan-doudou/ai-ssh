//! SSH 连接管理模块
//!
//! 使用 russh 库实现 SSH 连接，支持密码和密钥认证
//! 通过 PTY 伪终端提供交互式 shell 体验

use russh::client::{self, AuthResult};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{Channel, ChannelId};
// 使用 russh 内部重新导出的 ssh_key 类型
use russh::keys::ssh_key::PrivateKey;
use std::collections::HashMap;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex, RwLock};

use crate::models::{AuthType, Server};

/// SSH 客户端处理器
struct SshClientHandler {
    /// 会话 ID
    session_id: String,
    /// Tauri 应用句柄
    app_handle: AppHandle,
}

impl client::Handler for SshClientHandler {
    type Error = russh::Error;

    /// 检查服务器公钥（生产环境应该验证指纹）
    fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> impl Future<Output = Result<bool, Self::Error>> + Send {
        // 接受所有服务器密钥（生产环境应该验证）
        async { Ok(true) }
    }

    /// 处理从服务器接收的数据
    fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        // 收到数据时发送到前端
        let text = String::from_utf8_lossy(data).to_string();
        let session_id = self.session_id.clone();
        let app_handle = self.app_handle.clone();
        async move {
            let _ = app_handle.emit(&format!("ssh-output-{}", session_id), text);
            Ok(())
        }
    }

    /// 处理 stderr 数据
    fn extended_data(
        &mut self,
        _channel: ChannelId,
        _ext: u32,
        data: &[u8],
        _session: &mut client::Session,
    ) -> impl Future<Output = Result<(), Self::Error>> + Send {
        // stderr 数据也发送到前端
        let text = String::from_utf8_lossy(data).to_string();
        let session_id = self.session_id.clone();
        let app_handle = self.app_handle.clone();
        async move {
            let _ = app_handle.emit(&format!("ssh-output-{}", session_id), text);
            Ok(())
        }
    }
}

/// SSH 会话数据
struct SshSessionData {
    /// 通道句柄
    channel: Channel<client::Msg>,
    /// 是否正在运行
    running: Arc<RwLock<bool>>,
}

/// SSH 会话元数据
struct SshSessionMeta {
    /// 服务器名称
    #[allow(dead_code)]
    server_name: String,
    /// 会话数据
    session_data: Arc<Mutex<Option<SshSessionData>>>,
}

/// SSH 会话管理器
pub struct SshManager {
    /// 活跃会话映射: session_id -> SshSessionMeta
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
        
        // 尝试解析私钥
        if let Some(pass) = passphrase {
            // 尝试用密码解密加密的私钥
            PrivateKey::from_openssh(key_data.as_bytes())
                .map_err(|e| format!("解析私钥失败: {:?}", e))
                .and_then(|k| {
                    if k.is_encrypted() {
                        // 如果密钥已加密，需要解密
                        PrivateKey::from_openssh(key_data.as_bytes())
                            .map_err(|e| format!("解密私钥失败（可能密码错误）: {:?}", e))
                    } else {
                        Ok(k)
                    }
                })
        } else {
            PrivateKey::from_openssh(key_data.as_bytes())
                .map_err(|e| format!("加载私钥失败: {:?}", e))
        }
    }

    /// 建立 SSH 连接（异步版本）
    pub async fn connect_async(
        &self,
        session_id: &str,
        server: &Server,
        app_handle: AppHandle,
    ) -> Result<(), String> {
        println!("[SSH] 开始连接 session_id={}, server={}", session_id, server.name);

        // 创建 SSH 配置
        let config = client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(3600)),
            ..Default::default()
        };
        let config = Arc::new(config);

        // 创建客户端处理器
        let handler = SshClientHandler {
            session_id: session_id.to_string(),
            app_handle: app_handle.clone(),
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
                
                // 加载私钥
                let private_key = Self::load_private_key(
                    key_path, 
                    server.password.as_deref()
                )?;
                
                // 获取最佳支持的 RSA 哈希算法（如果是 RSA 密钥）
                let hash_alg = session.best_supported_rsa_hash().await
                    .map_err(|e| format!("获取 RSA 哈希算法失败: {:?}", e))?
                    .flatten();
                
                // 创建带哈希算法的私钥包装
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
                println!("[SSH] 认证成功，正在打开通道...");
            }
            AuthResult::Failure { remaining_methods, .. } => {
                return Err(format!("认证失败，可用方法: {:?}", remaining_methods));
            }
        }

        // 打开通道
        let channel = session
            .channel_open_session()
            .await
            .map_err(|e| format!("打开通道失败: {:?}", e))?;

        println!("[SSH] 通道已打开，正在请求 PTY...");

        // 请求 PTY
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

        // 启动 shell
        channel
            .request_shell(false)
            .await
            .map_err(|e| format!("启动 shell 失败: {:?}", e))?;

        println!("[SSH] Shell 启动成功");

        let running = Arc::new(RwLock::new(true));

        // 存储会话数据
        let session_data = Arc::new(Mutex::new(Some(SshSessionData {
            channel,
            running: running.clone(),
        })));

        // 存储会话元数据
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(session_id.to_string(), SshSessionMeta {
                server_name: server.name.clone(),
                session_data,
            });
        }

        Ok(())
    }

    /// 发送数据到 SSH 会话
    pub async fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        
        let session_meta = sessions.get(session_id)
            .ok_or("会话不存在")?;
        
        let session_data = session_meta.session_data.lock().await;
        if let Some(ref data_inner) = *session_data {
            data_inner.channel
                .data(data.as_bytes())
                .await
                .map_err(|e| format!("发送数据失败: {:?}", e))?;
        }
        
        Ok(())
    }

    /// 调整终端大小
    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        
        let session_meta = sessions.get(session_id)
            .ok_or("会话不存在")?;
        
        let session_data = session_meta.session_data.lock().await;
        if let Some(ref data) = *session_data {
            data.channel
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
                // 尝试关闭通道
                let _ = data.channel.eof().await;
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
