//! SFTP 文件管理模块
//!
//! 使用 russh-sftp 库实现 SFTP 文件操作
//! 支持目录浏览、文件上传/下载等功能

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use tauri::Emitter;
use tokio::sync::Mutex;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, AsyncSeekExt};

/// SFTP 客户端处理器
#[derive(Clone)]
pub struct SftpClientHandler;

impl russh::client::Handler for SftpClientHandler {
    type Error = russh::Error;

    fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> impl std::future::Future<Output = Result<bool, Self::Error>> + Send {
        async { Ok(true) }
    }
}

/// SFTP 文件条目信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// 文件名
    pub name: String,
    /// 完整路径
    pub path: String,
    /// 是否为目录
    pub is_dir: bool,
    /// 文件大小（字节）
    pub size: u64,
    /// 修改时间（Unix 时间戳）
    pub modified: u64,
    /// 权限（如 "drwxr-xr-x"）
    pub permissions: String,
    /// 所有者
    pub owner: String,
    /// 所属组
    pub group: String,
}

/// SFTP 会话元数据
struct SftpSessionMeta {
    /// SFTP 会话 (主会话，用于浏览等)
    session: SftpSession,
    /// SSH 客户端句柄 (用于创建新的并发传输会话)
    ssh_client: Arc<russh::client::Handle<SftpClientHandler>>,
    /// 当前工作目录
    current_dir: String,
}

/// SFTP 会话管理器
pub struct SftpManager {
    /// 活跃的 SFTP 会话映射: session_id -> SftpSessionMeta
    sessions: Mutex<HashMap<String, SftpSessionMeta>>,
    /// 被取消的任务 ID 集合（用于高性能上传的取消检查）
    cancelled_tasks: Mutex<std::collections::HashSet<String>>,
}

impl SftpManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            cancelled_tasks: Mutex::new(std::collections::HashSet::new()),
        }
    }

    /// 将 SSH channel 升级为 SFTP 会话
    /// 将 SSH channel 升级为 SFTP 会话
    pub async fn connect(
        &self,
        session_id: &str,
        channel: russh::Channel<russh::client::Msg>,
        ssh_client: russh::client::Handle<SftpClientHandler>,
    ) -> Result<(), String> {
        println!("[SFTP] 开始建立 SFTP 会话 session_id={}", session_id);

        // 请求 SFTP 子系统
        channel.request_subsystem(false, "sftp").await
            .map_err(|e| format!("请求 SFTP 子系统失败: {:?}", e))?;

        // 创建 SFTP 会话
        let sftp = SftpSession::new(channel.into_stream()).await
            .map_err(|e| format!("创建 SFTP 会话失败: {:?}", e))?;

        // 获取当前工作目录
        let current_dir = sftp.canonicalize(".")
            .await
            .map_err(|e| format!("获取工作目录失败: {:?}", e))?;

        println!("[SFTP] SFTP 会话建立成功，当前目录: {}", current_dir);

        // 存储会话
        let mut sessions = self.sessions.lock().await;
        sessions.insert(session_id.to_string(), SftpSessionMeta {
            session: sftp,
            ssh_client: Arc::new(ssh_client),
            current_dir,
        });

        Ok(())
    }

    /// 列出目录内容
    pub async fn list_dir(&self, session_id: &str, path: &str) -> Result<Vec<FileEntry>, String> {
        let mut sessions = self.sessions.lock().await;
        
        let meta = sessions.get_mut(session_id)
            .ok_or("SFTP 会话不存在")?;

        // 如果路径为空或相对路径，基于当前目录解析
        let full_path = if path.is_empty() || path == "." {
            meta.current_dir.clone()
        } else if path.starts_with('/') {
            path.to_string()
        } else {
            format!("{}/{}", meta.current_dir, path)
        };

        println!("[SFTP] 列出目录: {}", full_path);

        // 读取目录
        let entries = meta.session.read_dir(&full_path)
            .await
            .map_err(|e| format!("读取目录失败: {:?}", e))?;

        // 转换为 FileEntry
        let mut result = Vec::new();
        for entry in entries {
            let file_name = entry.file_name();
            let file_path = format!("{}/{}", full_path, file_name);
            
            // 获取文件属性
            let attrs = entry.metadata();
            
            result.push(FileEntry {
                name: file_name,
                path: file_path,
                is_dir: attrs.is_dir(),
                size: attrs.size.unwrap_or(0),
                modified: attrs.mtime.unwrap_or(0) as u64,
                permissions: format_permissions(attrs.permissions.unwrap_or(0)),
                owner: attrs.uid.map(|u| u.to_string()).unwrap_or_else(|| "-".to_string()),
                group: attrs.gid.map(|g| g.to_string()).unwrap_or_else(|| "-".to_string()),
            });
        }

        // 按类型和名称排序（目录优先）
        result.sort_by(|a, b| {
            match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(result)
    }

    /// 更改当前工作目录
    pub async fn change_dir(&self, session_id: &str, path: &str) -> Result<String, String> {
        let mut sessions = self.sessions.lock().await;
        
        let meta = sessions.get_mut(session_id)
            .ok_or("SFTP 会话不存在")?;

        // 解析路径
        let new_path = meta.session.canonicalize(path)
            .await
            .map_err(|e| format!("路径解析失败: {:?}", e))?;

        // 验证是目录
        let attrs = meta.session.metadata(&new_path)
            .await
            .map_err(|e| format!("获取路径信息失败: {:?}", e))?;

        if !attrs.is_dir() {
            return Err("目标路径不是目录".to_string());
        }

        meta.current_dir = new_path.clone();
        Ok(new_path)
    }

    /// 获取当前工作目录
    pub async fn get_current_dir(&self, session_id: &str) -> Result<String, String> {
        let sessions = self.sessions.lock().await;
        
        let meta = sessions.get(session_id)
            .ok_or("SFTP 会话不存在")?;

        Ok(meta.current_dir.clone())
    }

    /// 创建目录
    pub async fn mkdir(&self, session_id: &str, path: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        
        let meta = sessions.get(session_id)
            .ok_or("SFTP 会话不存在")?;

        meta.session.create_dir(path)
            .await
            .map_err(|e| format!("创建目录失败: {:?}", e))
    }

    /// 创建空文件
    pub async fn create_file(&self, session_id: &str, path: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        
        let meta = sessions.get(session_id)
            .ok_or("SFTP 会话不存在")?;

        // 使用 create 创建文件，如果文件已存在会被截断为空
        meta.session.create(path)
            .await
            .map_err(|e| format!("创建文件失败: {:?}", e))?;
            
        Ok(())
    }

    /// 删除文件或目录
    pub async fn remove(&self, session_id: &str, path: &str, is_dir: bool) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        
        let meta = sessions.get(session_id)
            .ok_or("SFTP 会话不存在")?;

        if is_dir {
            meta.session.remove_dir(path)
                .await
                .map_err(|e| format!("删除目录失败: {:?}", e))
        } else {
            meta.session.remove_file(path)
                .await
                .map_err(|e| format!("删除文件失败: {:?}", e))
        }
    }

    /// 重命名文件或目录
    pub async fn rename(&self, session_id: &str, old_path: &str, new_path: &str) -> Result<(), String> {
        let sessions = self.sessions.lock().await;
        
        let meta = sessions.get(session_id)
            .ok_or("SFTP 会话不存在")?;

        meta.session.rename(old_path, new_path)
            .await
            .map_err(|e| format!("重命名失败: {:?}", e))
    }

    /// 取消上传 - 高性能上传（taskId）
    pub async fn cancel_upload(&self, _session_id: &str, token: &str) -> Result<(), String> {
        let mut cancelled = self.cancelled_tasks.lock().await;
        cancelled.insert(token.to_string());
        
        println!("[SFTP] 任务已标记为取消: {}", token);
        Ok(())
    }
    
    /// 检查任务是否已被取消
    pub async fn is_task_cancelled(&self, task_id: &str) -> bool {
        let cancelled = self.cancelled_tasks.lock().await;
        cancelled.contains(task_id)
    }
    
    /// 清理已取消的任务标记
    pub async fn clear_cancelled_task(&self, task_id: &str) {
        let mut cancelled = self.cancelled_tasks.lock().await;
        cancelled.remove(task_id);
    }

    /// 下载文件直接保存到本地路径（高性能）
    pub async fn download_to_file(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        task_id: Option<&str>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<(), String> {
         // 获取远程文件大小
        let file_size = {
            let mut sessions = self.sessions.lock().await;
            let meta = sessions.get_mut(session_id)
                .ok_or("SFTP 会话不存在")?;
            meta.session.metadata(remote_path)
                .await
                .map_err(|e| format!("获取文件信息失败: {:?}", e))?
                .size.unwrap_or(0) as u64
        };

        // 小文件单流下载
        if file_size < 20 * 1024 * 1024 {
            return self.download_single(session_id, remote_path, local_path, file_size, task_id, app_handle).await;
        }

        self.download_concurrent(session_id, remote_path, local_path, file_size, task_id, app_handle).await
    }

    /// 单流下载逻辑
    async fn download_single(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        file_size: u64,
        task_id: Option<&str>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;

        let meta = sessions.get_mut(session_id)
            .ok_or("SFTP 会话不存在")?;

        // 打开远程文件
        let mut remote_file = meta.session.open(remote_path)
            .await
            .map_err(|e| format!("打开远程文件失败: {:?}", e))?;

        // 创建本地文件
        let mut local_file = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| format!("创建本地文件失败: {:?}", e))?;

        // 分块读写（8MB/块 - 适合万兆网络）
        const CHUNK_SIZE: usize = 4 * 1024 * 1024;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        
        let mut chunk_buf = vec![0u8; CHUNK_SIZE];
        let mut transferred: u64 = 0;
        let start_time = std::time::Instant::now();

        loop {
            // 这里缺少 is_task_cancelled 检查，但为了保持原逻辑先这样，或者加上?
            // 原逻辑没有在 download 循环里检查 cancelled_tasks? 
            // 之前的代码里没有。我们加上吧。
            if let Some(tid) = task_id {
                // 需要解锁 sessions 才能调用 self.is_task_cancelled? 
                // 不，self.is_task_cancelled 锁的是 cancelled_tasks，不冲突。
                if self.is_task_cancelled(tid).await {
                    self.clear_cancelled_task(tid).await;
                    return Err("下载已取消".to_string());
                }
            }

            let n = remote_file.read(&mut chunk_buf)
                .await
                .map_err(|e| format!("读取文件失败: {:?}", e))?;
            
            if n == 0 {
                break;
            }
            
            // 直接写入本地文件
            local_file.write_all(&chunk_buf[..n])
                .await
                .map_err(|e| format!("写入本地文件失败: {:?}", e))?;
            
            transferred += n as u64;

            // 发送进度事件
            if let (Some(tid), Some(app)) = (&task_id, &app_handle) {
                let elapsed = start_time.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 { transferred as f64 / elapsed } else { 0.0 };
                
                let _ = app.emit(&format!("sftp-progress-{}", tid), serde_json::json!({
                    "taskId": tid,
                    "transferred": transferred,
                    "total": file_size,
                    "speed": speed as u64,
                }));
            }
        }

        local_file.flush().await.map_err(|e| format!("刷新文件失败: {:?}", e))?;
        Ok(())
    }

    /// 并发下载实现
    async fn download_concurrent(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        file_size: u64,
        task_id: Option<&str>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<(), String> {
        println!("[SFTP] 开始并发下载 (6线程): {} -> {}", remote_path, local_path);

        let ssh_client = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id)
                .map(|m| m.ssh_client.clone())
                .ok_or("SFTP 会话不存在")?
        };

        let (write_tx, mut write_rx) = tokio::sync::mpsc::channel::<(u64, Vec<u8>)>(4);
        let local_path_owned = local_path.to_string();
        
        // Writer Task
        let writer_handle = tokio::spawn(async move {
            let mut file = tokio::fs::File::create(&local_path_owned).await
                .map_err(|e| format!("创建本地文件失败: {:?}", e))?;
            
            if let Err(e) = file.set_len(file_size).await {
                println!("[SFTP] 警告: set_len 失败: {:?}", e);
            }

            use tokio::io::{AsyncSeekExt, AsyncWriteExt};
            while let Some((offset, data)) = write_rx.recv().await {
                file.seek(std::io::SeekFrom::Start(offset)).await
                    .map_err(|e| format!("Writer Seek 失败: {:?}", e))?;
                file.write_all(&data).await
                    .map_err(|e| format!("Writer Write 失败: {:?}", e))?;
            }
            file.flush().await.map_err(|e| format!("Writer Flush 失败: {:?}", e))?;
            Ok::<(), String>(())
        });

        use std::sync::atomic::{AtomicBool, Ordering};
        let is_cancelled = Arc::new(AtomicBool::new(false));
        // MaxSessions 默认为 10。扣除主会话和控制会话，建议设置为 6 以避免 "ConnectFailed"。
        let worker_count = 6;
        let mut join_set = tokio::task::JoinSet::new();
        let mut senders = Vec::new();

        for _ in 0..worker_count {
            let (tx, mut rx) = tokio::sync::mpsc::channel::<(u64, u64)>(2);
            senders.push(tx);
            
            let client = ssh_client.clone();
            let r_path = remote_path.to_string();
            let c_cancelled = is_cancelled.clone();
            let w_tx = write_tx.clone();

            join_set.spawn(async move {
                let channel = client.channel_open_session().await.map_err(|e: russh::Error| e.to_string())?;
                channel.request_subsystem(false, "sftp").await.map_err(|e: russh::Error| e.to_string())?;
                let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e: russh_sftp::client::error::Error| e.to_string())?;
                let mut file = sftp.open(&r_path).await.map_err(|e: russh_sftp::client::error::Error| e.to_string())?;

                while let Some((offset, len)) = rx.recv().await {
                    if c_cancelled.load(Ordering::SeqCst) { break; }

                    file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e: std::io::Error| e.to_string())?;
                    
                    let mut buf = vec![0u8; len as usize];
                    let mut read_cnt = 0;
                    while read_cnt < len as usize {
                        let n = match file.read(&mut buf[read_cnt..]).await {
                            Ok(0) => break,
                            Ok(n) => n,
                            Err(e) => return Err(e.to_string()),
                        };
                        read_cnt += n;
                    }
                    buf.truncate(read_cnt);

                    if let Err(_) = w_tx.send((offset, buf)).await {
                        break;
                    }
                }
                Ok::<(), String>(())
            });
        }
        drop(write_tx);

        const CHUNK_SIZE: usize = 4 * 1024 * 1024;
        let mut offset: u64 = 0;
        let mut worker_idx = 0;
        let mut transferred: u64 = 0;
        let start_time = std::time::Instant::now();
        let task_id_owned = task_id.map(|s| s.to_string());

        loop {
            if let Some(ref tid) = task_id_owned {
                if self.is_task_cancelled(tid).await {
                    is_cancelled.store(true, Ordering::SeqCst);
                    self.clear_cancelled_task(tid).await;
                    return Err("下载已取消".to_string());
                }
            }
            if is_cancelled.load(Ordering::SeqCst) {
                 return Err("任务已取消/失败".to_string());
            }

            if offset >= file_size { break; }

            let remaining = file_size - offset;
            let len = if remaining > CHUNK_SIZE as u64 { CHUNK_SIZE as u64 } else { remaining };

            if let Err(_) = senders[worker_idx].send((offset, len)).await {
                 is_cancelled.store(true, Ordering::SeqCst);
                 return Err("发送任务失败".to_string());
            }

            offset += len;
            transferred += len;
            worker_idx = (worker_idx + 1) % worker_count;

            if let (Some(ref tid), Some(ref app)) = (&task_id_owned, &app_handle) {
                let elapsed = start_time.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 { transferred as f64 / elapsed } else { 0.0 };
                let _ = app.emit(&format!("sftp-progress-{}", tid), serde_json::json!({
                    "taskId": tid, "transferred": transferred, "total": file_size, "speed": speed as u64 
                }));
            }
        }

        drop(senders);

        while let Some(res) = join_set.join_next().await {
             match res {
                Ok(Ok(())) => {},
                Ok(Err(e)) => { is_cancelled.store(true, Ordering::SeqCst); return Err(format!("Worker 错误: {}", e)); }
                Err(e) => { is_cancelled.store(true, Ordering::SeqCst); return Err(format!("Worker Panic: {:?}", e)); }
            }
        }
        
        let writer_res = writer_handle.await;
        match writer_res {
            Ok(Ok(())) => {},
            Ok(Err(e)) => return Err(format!("写入任务失败: {}", e)),
            Err(e) => return Err(format!("写入任务 Panic: {:?}", e)),
        }
        
        if is_cancelled.load(Ordering::SeqCst) {
             return Err("下载失败".to_string());
        }
        
        println!("[SFTP] 并发下载完成");
        Ok(())
    }

    /// 从本地文件高性能上传到远程
    pub async fn upload_from_file(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        task_id: Option<&str>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<(), String> {
        // 获取本地文件大小
        let file_size = tokio::fs::metadata(local_path)
            .await
            .map_err(|e| format!("获取本地文件信息失败: {:?}", e))?
            .len();

        // 小文件（< 20MB）使用单流上传，大文件使用并发上传
        if file_size < 20 * 1024 * 1024 {
            return self.upload_single(session_id, local_path, remote_path, file_size, task_id, app_handle).await;
        }

        self.upload_concurrent(session_id, local_path, remote_path, file_size, task_id, app_handle).await
    }

    /// 单流上传实现（原逻辑）
    async fn upload_single(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        file_size: u64,
        task_id: Option<&str>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<(), String> {
        println!("[SFTP] 开始单流上传: {} -> {}, 大小: {} 字节", local_path, remote_path, file_size);

        // 打开本地文件
        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .map_err(|e| format!("打开本地文件失败: {:?}", e))?;

        // 创建远程文件（需要获取锁）
        let mut remote_file = {
            let mut sessions = self.sessions.lock().await;
            let meta = sessions.get_mut(session_id)
                .ok_or("SFTP 会话不存在")?;
            meta.session.create(remote_path)
                .await
                .map_err(|e| format!("创建远程文件失败: {:?}", e))?
        };

        // 分块读写
        const CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4MB
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        
        let mut chunk_buf = vec![0u8; CHUNK_SIZE];
        let mut transferred: u64 = 0;
        let start_time = std::time::Instant::now();
        let task_id_owned = task_id.map(|s| s.to_string());

        loop {
            // 检查是否已取消
            if let Some(ref tid) = task_id_owned {
                if self.is_task_cancelled(tid).await {
                    println!("[SFTP] 上传已取消: {}", tid);
                    self.clear_cancelled_task(tid).await;
                    return Err("上传已取消".to_string());
                }
            }
            
            let n = local_file.read(&mut chunk_buf)
                .await
                .map_err(|e| format!("读取本地文件失败: {:?}", e))?;
            
            if n == 0 {
                break;
            }
            
            // 写入远程文件
            remote_file.write_all(&chunk_buf[..n])
                .await
                .map_err(|e| format!("写入远程文件失败: {:?}", e))?;
            
            transferred += n as u64;

            // 发送进度事件
            if let (Some(ref tid), Some(ref app)) = (&task_id_owned, &app_handle) {
                let elapsed = start_time.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 { transferred as f64 / elapsed } else { 0.0 };
                
                let _ = app.emit(&format!("sftp-progress-{}", tid), serde_json::json!({
                    "taskId": tid,
                    "transferred": transferred,
                    "total": file_size,
                    "speed": speed as u64,
                }));
            }
        }

        // 刷新远程文件
        remote_file.flush()
            .await
            .map_err(|e| format!("刷新远程文件失败: {:?}", e))?;

        Ok(())
    }

    /// 并发上传实现
    async fn upload_concurrent(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        file_size: u64,
        task_id: Option<&str>,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<(), String> {
        println!("[SFTP] 开始并发上传 (6线程): {} -> {}", local_path, remote_path);
        
        let ssh_client = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id)
                .map(|m| m.ssh_client.clone())
                .ok_or("SFTP 会话不存在")?
        };

        let worker_count = 6;
        let mut join_set = tokio::task::JoinSet::new();

        use std::sync::atomic::{AtomicBool, Ordering};
        let is_cancelled = Arc::new(AtomicBool::new(false));
        let mut senders = Vec::new();

        for _ in 0..worker_count {
            let (tx, mut rx) = tokio::sync::mpsc::channel::<(u64, Vec<u8>)>(2);
            senders.push(tx);
            
            let client = ssh_client.clone();
            let r_path = remote_path.to_string();
            let c_cancelled = is_cancelled.clone();
            
            join_set.spawn(async move {
                let channel = client.channel_open_session().await.map_err(|e: russh::Error| format!("SessionOpen: {}", e))?;
                channel.request_subsystem(false, "sftp").await.map_err(|e: russh::Error| format!("Subsystem: {}", e))?;
                let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e: russh_sftp::client::error::Error| format!("SftpInit: {}", e))?;
                
                // Use OpenFlags for correct mode (WRITE w/o TRUNCATE)
                // Assuming open_with_flags exists. If not, we might need a different method.
                // Flags: SSH_FXF_WRITE (0x00000002) | SSH_FXF_CREAT (0x00000008)
                // But we don't want TRUNC (0x00000010)
                let flags = russh_sftp::protocol::OpenFlags::WRITE | russh_sftp::protocol::OpenFlags::CREATE;
                let mut file = sftp.open_with_flags(&r_path, flags).await
                    .map_err(|e: russh_sftp::client::error::Error| format!("FileOpen({}): {}", r_path, e))?;
                
                while let Some((offset, data)) = rx.recv().await {
                    if c_cancelled.load(Ordering::SeqCst) { break; }
                    
                    file.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e: std::io::Error| format!("FileSeek: {}", e))?;
                    file.write_all(&data).await.map_err(|e: std::io::Error| format!("FileWrite: {}", e))?;
                }
                file.flush().await.map_err(|e: std::io::Error| format!("FileFlush: {}", e))?;
                Ok::<(), String>(())
            });
        }

        // 初始化远程文件
        {
             let sessions = self.sessions.lock().await;
             if let Some(meta) = sessions.get(session_id) {
                 let _ = meta.session.create(remote_path).await
                     .map_err(|e| format!("初始化远程文件失败: {:?}", e))?;
             }
        }

        let mut local_file = tokio::fs::File::open(local_path).await
            .map_err(|e| format!("打开本地文件失败: {:?}", e))?;

        const CHUNK_SIZE: usize = 4 * 1024 * 1024;
        let mut offset: u64 = 0;
        let mut worker_idx = 0;
        let mut transferred: u64 = 0;
        let start_time = std::time::Instant::now();
        let task_id_owned = task_id.map(|s| s.to_string());

        loop {
            if let Some(ref tid) = task_id_owned {
                if self.is_task_cancelled(tid).await {
                    is_cancelled.store(true, Ordering::SeqCst);
                    self.clear_cancelled_task(tid).await;
                    return Err("上传已取消".to_string());
                }
            }
            if is_cancelled.load(Ordering::SeqCst) {
                 return Err("任务已取消/失败".to_string());
            }

            let mut chunk_buf = vec![0u8; CHUNK_SIZE];
            let n = local_file.read(&mut chunk_buf).await
                .map_err(|e| { is_cancelled.store(true, Ordering::SeqCst); format!("读取本地文件失败: {:?}", e) })?;
            
            if n == 0 { break; }
            
            chunk_buf.truncate(n);
            
            if let Err(_) = senders[worker_idx].send((offset, chunk_buf)).await {
                 is_cancelled.store(true, Ordering::SeqCst);
                 drop(senders); // Close remaining channels to stop other workers
                 
                 let mut err_msg = "发送任务到 Worker 失败 (Worker 通道已关闭)".to_string();
                 // 尝试获取 Worker 的具体错误
                 if let Some(res) = join_set.join_next().await {
                     match res {
                        Ok(Err(e)) => err_msg = format!("Worker 错误: {}", e),
                        Err(e) => err_msg = format!("Worker Panic: {:?}", e),
                        _ => {}
                     }
                 }
                 return Err(err_msg);
            }

            offset += n as u64;
            transferred += n as u64;
            worker_idx = (worker_idx + 1) % worker_count;

            if let (Some(ref tid), Some(ref app)) = (&task_id_owned, &app_handle) {
                let elapsed = start_time.elapsed().as_secs_f64();
                let speed = if elapsed > 0.0 { transferred as f64 / elapsed } else { 0.0 };
                let _ = app.emit(&format!("sftp-progress-{}", tid), serde_json::json!({
                    "taskId": tid, "transferred": transferred, "total": file_size, "speed": speed as u64 
                }));
            }
        }

        drop(senders);

        while let Some(res) = join_set.join_next().await {
            match res {
                Ok(Ok(())) => {},
                Ok(Err(e)) => { is_cancelled.store(true, Ordering::SeqCst); return Err(format!("Worker 错误: {}", e)); }
                Err(e) => { is_cancelled.store(true, Ordering::SeqCst); return Err(format!("Worker Panic: {:?}", e)); }
            }
        }
        
        if is_cancelled.load(Ordering::SeqCst) {
            return Err("上传过程中出现错误".to_string());
        }

        println!("[SFTP] 并发上传完成");
        Ok(())
    }




    /// 读取远程文件内容 (适对于文本文件)
    pub async fn read_file(&self, session_id: &str, path: &str) -> Result<Vec<u8>, String> {
        let mut sessions = self.sessions.lock().await;
        // 注意：这里需要 session 的可变引用因为 open/create 需要 &self (但 session 是 struct 字段)
        // russh-sftp 的 method 需要 &self, meta.session 是 SftpSession
        let meta = sessions.get_mut(session_id).ok_or("SFTP 会话不存在")?;
        
        // 限制最大读取大小 (例如 10MB)，防止前端崩溃
        const MAX_EDIT_SIZE: u64 = 10 * 1024 * 1024;
        
        // 获取文件大小
        let file_size = meta.session.metadata(path).await
            .map_err(|e| format!("获取文件信息失败: {:?}", e))?
            .size.unwrap_or(0);
            
        if file_size > MAX_EDIT_SIZE {
            return Err(format!("文件过大 ({} MB), 不支持在线编辑 (最大 10MB)", file_size / 1024 / 1024));
        }

        let mut file = meta.session.open(path).await
            .map_err(|e| format!("打开文件失败: {:?}", e))?;
            
        let mut content = Vec::new();
        file.read_to_end(&mut content).await
             .map_err(|e| format!("读取文件内容失败: {:?}", e))?;
             
        Ok(content)
    }

    /// 写入内容到远程文件
    pub async fn write_file(&self, session_id: &str, path: &str, content: &[u8]) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        let meta = sessions.get_mut(session_id).ok_or("SFTP 会话不存在")?;
        
        // create 会截断文件
        let mut file = meta.session.create(path).await
            .map_err(|e| format!("创建文件失败: {:?}", e))?;
            
        file.write_all(content).await
             .map_err(|e| format!("写入文件失败: {:?}", e))?;
        
        file.flush().await
            .map_err(|e| format!("刷新文件失败: {:?}", e))?;
             
        Ok(())
    }

    /// 断开 SFTP 会话
    pub async fn disconnect(&self, session_id: &str) -> Result<(), String> {
        let mut sessions = self.sessions.lock().await;
        
        if sessions.remove(session_id).is_some() {
            println!("[SFTP] SFTP 会话已断开: {}", session_id);
        }

        Ok(())
    }
}

impl Default for SftpManager {
    fn default() -> Self {
        Self::new()
    }
}

/// 将数字权限转换为字符串格式（如 "drwxr-xr-x"）
fn format_permissions(mode: u32) -> String {
    let file_type = match mode & 0o170000 {
        0o040000 => 'd',  // 目录
        0o120000 => 'l',  // 符号链接
        _ => '-',         // 普通文件
    };

    let user = format_rwx((mode >> 6) & 0o7);
    let group = format_rwx((mode >> 3) & 0o7);
    let other = format_rwx(mode & 0o7);

    format!("{}{}{}{}", file_type, user, group, other)
}

/// 将 3 位权限转换为 rwx 字符串
fn format_rwx(mode: u32) -> String {
    format!(
        "{}{}{}",
        if mode & 0o4 != 0 { 'r' } else { '-' },
        if mode & 0o2 != 0 { 'w' } else { '-' },
        if mode & 0o1 != 0 { 'x' } else { '-' },
    )
}
