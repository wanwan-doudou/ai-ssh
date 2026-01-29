//! SFTP 文件管理模块
//!
//! 使用 russh-sftp 库实现 SFTP 文件操作
//! 支持目录浏览、文件上传/下载等功能

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use tauri::Emitter;
use tokio::sync::Mutex;

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
    /// SFTP 会话
    session: SftpSession,
    /// 当前工作目录
    current_dir: String,
}

/// SFTP 会话管理器
pub struct SftpManager {
    /// 活跃的 SFTP 会话映射: session_id -> SftpSession
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
    pub async fn connect(
        &self,
        session_id: &str,
        channel: russh::Channel<russh::client::Msg>,
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
        let mut sessions = self.sessions.lock().await;
        
        let meta = sessions.get_mut(session_id)
            .ok_or("SFTP 会话不存在")?;

        // 获取远程文件大小
        let attrs = meta.session.metadata(remote_path)
            .await
            .map_err(|e| format!("获取文件信息失败: {:?}", e))?;

        let file_size = attrs.size.unwrap_or(0) as u64;

        // 打开远程文件
        let mut remote_file = meta.session.open(remote_path)
            .await
            .map_err(|e| format!("打开远程文件失败: {:?}", e))?;

        // 创建本地文件
        let mut local_file = tokio::fs::File::create(local_path)
            .await
            .map_err(|e| format!("创建本地文件失败: {:?}", e))?;

        // 分块读写（8MB/块 - 适合万兆网络）
        const CHUNK_SIZE: usize = 8 * 1024 * 1024;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        
        let mut chunk_buf = vec![0u8; CHUNK_SIZE];
        let mut transferred: u64 = 0;
        let start_time = std::time::Instant::now();

        loop {
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

        // 刷新并关闭文件
        local_file.flush()
            .await
            .map_err(|e| format!("刷新文件失败: {:?}", e))?;

        Ok(())
    }

    /// 从本地文件高性能上传到远程（直接读取本地文件，使用 8MB 分块）
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

        println!("[SFTP] 开始高性能上传: {} -> {}, 大小: {} 字节", local_path, remote_path, file_size);

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
        // sessions 锁已释放

        // 分块读写（8MB/块 - 适合万兆网络）
        const CHUNK_SIZE: usize = 8 * 1024 * 1024;
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

        let elapsed = start_time.elapsed().as_secs_f64();
        let speed_mb = if elapsed > 0.0 { (file_size as f64 / 1024.0 / 1024.0) / elapsed } else { 0.0 };
        println!("[SFTP] 上传完成: {} 字节, 耗时: {:.2}s, 速度: {:.2} MB/s", file_size, elapsed, speed_mb);

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
