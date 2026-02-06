//! SSH 命令接口
//!
//! 提供 Tauri 命令接口，连接前端和 SSH 管理器

use crate::models::Server;
use crate::ssh::SshManager;
use crate::AppState;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

/// SSH 管理器状态
pub struct SshState {
    pub manager: Arc<Mutex<SshManager>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRuntimeInfo {
    pub host: String,
    pub os: String,
    pub kernel: String,
    pub kernel_name: String,
    pub kernel_version: String,
    pub architecture: String,
    pub uptime: String,
    pub cpu_model: String,
    pub cpu_cores: u32,
    pub load_avg: String,
    pub memory_total_kb: u64,
    pub memory_used_kb: u64,
    pub memory_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_used_kb: u64,
    pub cpu_user_percent: f64,
    pub cpu_nice_percent: f64,
    pub cpu_system_percent: f64,
    pub cpu_idle_percent: f64,
    pub cpu_iowait_percent: f64,
    pub cpu_irq_percent: f64,
    pub cpu_softirq_percent: f64,
    pub cpu_steal_percent: f64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub disk_use_percent: f64,
    pub ip_address: String,
    pub net_rx_bytes: u64,
    pub net_tx_bytes: u64,
    pub collected_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProcessInfo {
    pub pid: u32,
    pub user: String,
    pub memory_kb: u64,
    pub cpu_percent: f64,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerNetworkConnection {
    pub protocol: String,
    pub state: String,
    pub recv_q: u64,
    pub send_q: u64,
    pub local_address: String,
    pub peer_address: String,
    pub process: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerFilesystemInfo {
    pub file_system: String,
    pub fs_type: String,
    pub size_kb: u64,
    pub used_kb: u64,
    pub avail_kb: u64,
    pub use_percent: f64,
    pub mount_point: String,
}

const SERVER_INFO_COMMAND: &str = r#"sh -lc '
HOST=$(hostname 2>/dev/null || uname -n 2>/dev/null || echo unknown)
OS=$( ( [ -r /etc/os-release ] && . /etc/os-release && echo "$PRETTY_NAME" ) || uname -sr 2>/dev/null || echo unknown )
KERNEL_NAME=$(uname -s 2>/dev/null || echo unknown)
KERNEL_VERSION=$(uname -r 2>/dev/null || echo unknown)
ARCH=$(uname -m 2>/dev/null || echo unknown)
KERNEL=$(uname -srmo 2>/dev/null || uname -a 2>/dev/null || echo unknown)
UPTIME=$(uptime -p 2>/dev/null || awk "{print int(\$1) \"s\"}" /proc/uptime 2>/dev/null || echo unknown)
CPU_MODEL=$(awk -F: "/model name/{gsub(/^ +/,\"\",\$2); print \$2; exit}" /proc/cpuinfo 2>/dev/null)
if [ -z "$CPU_MODEL" ]; then CPU_MODEL=unknown; fi
CPU_CORES=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
LOAD_AVG=$(awk "{print \$1 \" \" \$2 \" \" \$3}" /proc/loadavg 2>/dev/null)
if [ -z "$LOAD_AVG" ]; then LOAD_AVG=unknown; fi
MEM_TOTAL_KB=$(awk "/MemTotal:/{print \$2}" /proc/meminfo 2>/dev/null)
MEM_AVAIL_KB=$(awk "/MemAvailable:/{print \$2}" /proc/meminfo 2>/dev/null)
if [ -n "$MEM_TOTAL_KB" ] && [ -n "$MEM_AVAIL_KB" ]; then MEM_USED_KB=$((MEM_TOTAL_KB-MEM_AVAIL_KB)); else MEM_TOTAL_KB=0; MEM_AVAIL_KB=0; MEM_USED_KB=0; fi
SWAP_TOTAL_KB=$(awk "/SwapTotal:/{print \$2}" /proc/meminfo 2>/dev/null)
SWAP_FREE_KB=$(awk "/SwapFree:/{print \$2}" /proc/meminfo 2>/dev/null)
if [ -n "$SWAP_TOTAL_KB" ] && [ -n "$SWAP_FREE_KB" ]; then SWAP_USED_KB=$((SWAP_TOTAL_KB-SWAP_FREE_KB)); else SWAP_TOTAL_KB=0; SWAP_USED_KB=0; fi
CPU_LINE_1=$(awk "/^cpu /{print; exit}" /proc/stat 2>/dev/null)
if [ -n "$CPU_LINE_1" ]; then
  set -- $CPU_LINE_1
  CPU_USER_1=${2:-0}
  CPU_NICE_1=${3:-0}
  CPU_SYSTEM_1=${4:-0}
  CPU_IDLE_1=${5:-0}
  CPU_IOWAIT_1=${6:-0}
  CPU_IRQ_1=${7:-0}
  CPU_SOFTIRQ_1=${8:-0}
  CPU_STEAL_1=${9:-0}
else
  CPU_USER_1=0
  CPU_NICE_1=0
  CPU_SYSTEM_1=0
  CPU_IDLE_1=0
  CPU_IOWAIT_1=0
  CPU_IRQ_1=0
  CPU_SOFTIRQ_1=0
  CPU_STEAL_1=0
fi
sleep 0.2
CPU_LINE_2=$(awk "/^cpu /{print; exit}" /proc/stat 2>/dev/null)
if [ -n "$CPU_LINE_2" ]; then
  set -- $CPU_LINE_2
  CPU_USER_2=${2:-0}
  CPU_NICE_2=${3:-0}
  CPU_SYSTEM_2=${4:-0}
  CPU_IDLE_2=${5:-0}
  CPU_IOWAIT_2=${6:-0}
  CPU_IRQ_2=${7:-0}
  CPU_SOFTIRQ_2=${8:-0}
  CPU_STEAL_2=${9:-0}
else
  CPU_USER_2=$CPU_USER_1
  CPU_NICE_2=$CPU_NICE_1
  CPU_SYSTEM_2=$CPU_SYSTEM_1
  CPU_IDLE_2=$CPU_IDLE_1
  CPU_IOWAIT_2=$CPU_IOWAIT_1
  CPU_IRQ_2=$CPU_IRQ_1
  CPU_SOFTIRQ_2=$CPU_SOFTIRQ_1
  CPU_STEAL_2=$CPU_STEAL_1
fi
TOTAL_1=$((CPU_USER_1+CPU_NICE_1+CPU_SYSTEM_1+CPU_IDLE_1+CPU_IOWAIT_1+CPU_IRQ_1+CPU_SOFTIRQ_1+CPU_STEAL_1))
TOTAL_2=$((CPU_USER_2+CPU_NICE_2+CPU_SYSTEM_2+CPU_IDLE_2+CPU_IOWAIT_2+CPU_IRQ_2+CPU_SOFTIRQ_2+CPU_STEAL_2))
DIFF_TOTAL=$((TOTAL_2-TOTAL_1))
if [ "$DIFF_TOTAL" -gt 0 ]; then
  DIFF_USER=$((CPU_USER_2-CPU_USER_1))
  DIFF_NICE=$((CPU_NICE_2-CPU_NICE_1))
  DIFF_SYSTEM=$((CPU_SYSTEM_2-CPU_SYSTEM_1))
  DIFF_IDLE=$((CPU_IDLE_2-CPU_IDLE_1))
  DIFF_IOWAIT=$((CPU_IOWAIT_2-CPU_IOWAIT_1))
  DIFF_IRQ=$((CPU_IRQ_2-CPU_IRQ_1))
  DIFF_SOFTIRQ=$((CPU_SOFTIRQ_2-CPU_SOFTIRQ_1))
  DIFF_STEAL=$((CPU_STEAL_2-CPU_STEAL_1))
  CPU_USER_PCT=$(awk -v n="$DIFF_USER" -v t="$DIFF_TOTAL" "BEGIN{v=(t>0?(n*100)/t:0); if(v<0) v=0; printf \"%.1f\", v}")
  CPU_NICE_PCT=$(awk -v n="$DIFF_NICE" -v t="$DIFF_TOTAL" "BEGIN{v=(t>0?(n*100)/t:0); if(v<0) v=0; printf \"%.1f\", v}")
  CPU_SYSTEM_PCT=$(awk -v n="$DIFF_SYSTEM" -v t="$DIFF_TOTAL" "BEGIN{v=(t>0?(n*100)/t:0); if(v<0) v=0; printf \"%.1f\", v}")
  CPU_IDLE_PCT=$(awk -v n="$DIFF_IDLE" -v t="$DIFF_TOTAL" "BEGIN{v=(t>0?(n*100)/t:0); if(v<0) v=0; printf \"%.1f\", v}")
  CPU_IOWAIT_PCT=$(awk -v n="$DIFF_IOWAIT" -v t="$DIFF_TOTAL" "BEGIN{v=(t>0?(n*100)/t:0); if(v<0) v=0; printf \"%.1f\", v}")
  CPU_IRQ_PCT=$(awk -v n="$DIFF_IRQ" -v t="$DIFF_TOTAL" "BEGIN{v=(t>0?(n*100)/t:0); if(v<0) v=0; printf \"%.1f\", v}")
  CPU_SOFTIRQ_PCT=$(awk -v n="$DIFF_SOFTIRQ" -v t="$DIFF_TOTAL" "BEGIN{v=(t>0?(n*100)/t:0); if(v<0) v=0; printf \"%.1f\", v}")
  CPU_STEAL_PCT=$(awk -v n="$DIFF_STEAL" -v t="$DIFF_TOTAL" "BEGIN{v=(t>0?(n*100)/t:0); if(v<0) v=0; printf \"%.1f\", v}")
else
  CPU_USER_PCT=0.0
  CPU_NICE_PCT=0.0
  CPU_SYSTEM_PCT=0.0
  CPU_IDLE_PCT=0.0
  CPU_IOWAIT_PCT=0.0
  CPU_IRQ_PCT=0.0
  CPU_SOFTIRQ_PCT=0.0
  CPU_STEAL_PCT=0.0
fi
DISK_LINE=$(df -kP / 2>/dev/null | tail -n 1)
DISK_TOTAL_KB=$(echo "$DISK_LINE" | awk "{print \$2}")
DISK_USED_KB=$(echo "$DISK_LINE" | awk "{print \$3}")
DISK_USE_PCT=$(echo "$DISK_LINE" | awk "{print \$5}" | tr -d "%")
if [ -z "$DISK_TOTAL_KB" ]; then DISK_TOTAL_KB=0; fi
if [ -z "$DISK_USED_KB" ]; then DISK_USED_KB=0; fi
if [ -z "$DISK_USE_PCT" ]; then DISK_USE_PCT=0; fi
IP_ADDR=$(hostname -I 2>/dev/null | awk "{print \$1}")
if [ -z "$IP_ADDR" ]; then IP_ADDR=$(ip route get 1 2>/dev/null | awk "{for(i=1;i<=NF;i++) if(\$i==\"src\"){print \$(i+1); exit}}"); fi
if [ -z "$IP_ADDR" ]; then IP_ADDR=unknown; fi
NET_RX_BYTES=$(cat /sys/class/net/*/statistics/rx_bytes 2>/dev/null | awk "{s+=\$1} END{print s+0}")
NET_TX_BYTES=$(cat /sys/class/net/*/statistics/tx_bytes 2>/dev/null | awk "{s+=\$1} END{print s+0}")
if [ -z "$NET_RX_BYTES" ]; then NET_RX_BYTES=0; fi
if [ -z "$NET_TX_BYTES" ]; then NET_TX_BYTES=0; fi
printf "HOST=%s\nOS=%s\nKERNEL=%s\nKERNEL_NAME=%s\nKERNEL_VERSION=%s\nARCH=%s\nUPTIME=%s\nCPU_MODEL=%s\nCPU_CORES=%s\nLOAD_AVG=%s\nMEM_TOTAL_KB=%s\nMEM_USED_KB=%s\nMEM_AVAIL_KB=%s\nSWAP_TOTAL_KB=%s\nSWAP_USED_KB=%s\nCPU_USER_PCT=%s\nCPU_NICE_PCT=%s\nCPU_SYSTEM_PCT=%s\nCPU_IDLE_PCT=%s\nCPU_IOWAIT_PCT=%s\nCPU_IRQ_PCT=%s\nCPU_SOFTIRQ_PCT=%s\nCPU_STEAL_PCT=%s\nDISK_TOTAL_KB=%s\nDISK_USED_KB=%s\nDISK_USE_PCT=%s\nIP_ADDR=%s\nNET_RX_BYTES=%s\nNET_TX_BYTES=%s\n" \
  "$HOST" "$OS" "$KERNEL" "$KERNEL_NAME" "$KERNEL_VERSION" "$ARCH" "$UPTIME" "$CPU_MODEL" "$CPU_CORES" "$LOAD_AVG" "$MEM_TOTAL_KB" "$MEM_USED_KB" "$MEM_AVAIL_KB" "$SWAP_TOTAL_KB" "$SWAP_USED_KB" "$CPU_USER_PCT" "$CPU_NICE_PCT" "$CPU_SYSTEM_PCT" "$CPU_IDLE_PCT" "$CPU_IOWAIT_PCT" "$CPU_IRQ_PCT" "$CPU_SOFTIRQ_PCT" "$CPU_STEAL_PCT" "$DISK_TOTAL_KB" "$DISK_USED_KB" "$DISK_USE_PCT" "$IP_ADDR" "$NET_RX_BYTES" "$NET_TX_BYTES"
'"#;

fn clamp_limit(limit: Option<u32>, default_value: usize, max_value: usize) -> usize {
    let value = limit.unwrap_or(default_value as u32) as usize;
    value.clamp(1, max_value)
}

fn parse_key_value_fields(line: &str) -> HashMap<String, String> {
    let mut values = HashMap::new();
    for field in line.split('\t') {
        if let Some((key, value)) = field.split_once('=') {
            values.insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    values
}

fn build_process_list_command(limit: usize) -> String {
    format!(
        r#"sh -lc 'set -f; ps -eo pid=,user=,rss=,pcpu=,comm=,args= --sort=-pcpu 2>/dev/null | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 5 ] && continue; pid=$1; user=$2; rss=$3; cpu=$4; name=$5; shift 5; cmd="$*"; printf "PID=%s\tUSER=%s\tRSS_KB=%s\tCPU=%s\tNAME=%s\tCMD=%s\n" "$pid" "$user" "$rss" "$cpu" "$name" "$cmd"; done'"#
    )
}

fn build_network_connection_command(limit: usize) -> String {
    format!(
        r#"sh -lc 'set -f; command -v ss >/dev/null 2>&1 || exit 0; ss -tunapH 2>/dev/null | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 6 ] && continue; proto=$1; state=$2; recvq=$3; sendq=$4; local=$5; peer=$6; shift 6; proc="$*"; printf "PROTO=%s\tSTATE=%s\tRECV_Q=%s\tSEND_Q=%s\tLOCAL=%s\tPEER=%s\tPROC=%s\n" "$proto" "$state" "$recvq" "$sendq" "$local" "$peer" "$proc"; done'"#
    )
}

fn build_filesystem_list_command(limit: usize) -> String {
    format!(
        r#"sh -lc 'df -kPT 2>/dev/null | tail -n +2 | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 7 ] && continue; fs=$1; fstype=$2; size=$3; used=$4; avail=$5; usep=$6; mount=$7; pct=$(printf "%s" "$usep" | tr -d "%"); printf "FS=%s\tTYPE=%s\tSIZE_KB=%s\tUSED_KB=%s\tAVAIL_KB=%s\tUSE_PCT=%s\tMOUNT=%s\n" "$fs" "$fstype" "$size" "$used" "$avail" "$pct" "$mount"; done'"#
    )
}

fn parse_u32(map: &HashMap<String, String>, key: &str) -> u32 {
    map.get(key)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0)
}

fn parse_u64(map: &HashMap<String, String>, key: &str) -> u64 {
    map.get(key)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0)
}

fn parse_f64(map: &HashMap<String, String>, key: &str) -> f64 {
    map.get(key)
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0)
}

fn parse_runtime_info(output: &str) -> ServerRuntimeInfo {
    let mut values = HashMap::new();
    for line in output.lines() {
        if let Some((key, value)) = line.split_once('=') {
            values.insert(key.trim().to_string(), value.trim().to_string());
        }
    }

    let disk_total_kb = parse_u64(&values, "DISK_TOTAL_KB");
    let disk_used_kb = parse_u64(&values, "DISK_USED_KB");
    let disk_use_percent = {
        let parsed = parse_f64(&values, "DISK_USE_PCT");
        if parsed > 0.0 || disk_total_kb == 0 {
            parsed
        } else {
            ((disk_used_kb as f64) / (disk_total_kb as f64) * 100.0 * 10.0).round() / 10.0
        }
    };

    ServerRuntimeInfo {
        host: values.get("HOST").cloned().unwrap_or_else(|| "unknown".to_string()),
        os: values.get("OS").cloned().unwrap_or_else(|| "unknown".to_string()),
        kernel: values
            .get("KERNEL")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        kernel_name: values
            .get("KERNEL_NAME")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        kernel_version: values
            .get("KERNEL_VERSION")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        architecture: values
            .get("ARCH")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        uptime: values
            .get("UPTIME")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        cpu_model: values
            .get("CPU_MODEL")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        cpu_cores: parse_u32(&values, "CPU_CORES"),
        load_avg: values
            .get("LOAD_AVG")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        memory_total_kb: parse_u64(&values, "MEM_TOTAL_KB"),
        memory_used_kb: parse_u64(&values, "MEM_USED_KB"),
        memory_available_kb: parse_u64(&values, "MEM_AVAIL_KB"),
        swap_total_kb: parse_u64(&values, "SWAP_TOTAL_KB"),
        swap_used_kb: parse_u64(&values, "SWAP_USED_KB"),
        cpu_user_percent: parse_f64(&values, "CPU_USER_PCT"),
        cpu_nice_percent: parse_f64(&values, "CPU_NICE_PCT"),
        cpu_system_percent: parse_f64(&values, "CPU_SYSTEM_PCT"),
        cpu_idle_percent: parse_f64(&values, "CPU_IDLE_PCT"),
        cpu_iowait_percent: parse_f64(&values, "CPU_IOWAIT_PCT"),
        cpu_irq_percent: parse_f64(&values, "CPU_IRQ_PCT"),
        cpu_softirq_percent: parse_f64(&values, "CPU_SOFTIRQ_PCT"),
        cpu_steal_percent: parse_f64(&values, "CPU_STEAL_PCT"),
        disk_total_kb,
        disk_used_kb,
        disk_use_percent,
        ip_address: values
            .get("IP_ADDR")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        net_rx_bytes: parse_u64(&values, "NET_RX_BYTES"),
        net_tx_bytes: parse_u64(&values, "NET_TX_BYTES"),
        collected_at: chrono::Utc::now().timestamp_millis(),
    }
}

fn parse_process_list(output: &str) -> Vec<ServerProcessInfo> {
    output
        .lines()
        .filter_map(|line| {
            let values = parse_key_value_fields(line);
            if values.is_empty() {
                return None;
            }

            Some(ServerProcessInfo {
                pid: parse_u32(&values, "PID"),
                user: values.get("USER").cloned().unwrap_or_default(),
                memory_kb: parse_u64(&values, "RSS_KB"),
                cpu_percent: parse_f64(&values, "CPU"),
                name: values.get("NAME").cloned().unwrap_or_default(),
                command: values.get("CMD").cloned().unwrap_or_default(),
            })
        })
        .collect()
}

fn parse_network_connections(output: &str) -> Vec<ServerNetworkConnection> {
    output
        .lines()
        .filter_map(|line| {
            let values = parse_key_value_fields(line);
            if values.is_empty() {
                return None;
            }

            Some(ServerNetworkConnection {
                protocol: values.get("PROTO").cloned().unwrap_or_default(),
                state: values.get("STATE").cloned().unwrap_or_default(),
                recv_q: parse_u64(&values, "RECV_Q"),
                send_q: parse_u64(&values, "SEND_Q"),
                local_address: values.get("LOCAL").cloned().unwrap_or_default(),
                peer_address: values.get("PEER").cloned().unwrap_or_default(),
                process: values.get("PROC").cloned().unwrap_or_default(),
            })
        })
        .collect()
}

fn parse_filesystems(output: &str) -> Vec<ServerFilesystemInfo> {
    output
        .lines()
        .filter_map(|line| {
            let values = parse_key_value_fields(line);
            if values.is_empty() {
                return None;
            }

            Some(ServerFilesystemInfo {
                file_system: values.get("FS").cloned().unwrap_or_default(),
                fs_type: values.get("TYPE").cloned().unwrap_or_default(),
                size_kb: parse_u64(&values, "SIZE_KB"),
                used_kb: parse_u64(&values, "USED_KB"),
                avail_kb: parse_u64(&values, "AVAIL_KB"),
                use_percent: parse_f64(&values, "USE_PCT"),
                mount_point: values.get("MOUNT").cloned().unwrap_or_default(),
            })
        })
        .collect()
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
    manager.write(&session_id, &data).await
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
    manager.resize(&session_id, cols, rows).await
}

/// 发送 SSH 命令 (保留兼容性)
#[tauri::command]
pub async fn send_ssh_command(
    session_id: String,
    command: String,
    ssh_state: State<'_, SshState>,
) -> Result<String, String> {
    let manager = ssh_state.manager.lock().await;
    manager.write(&session_id, &format!("{}\n", command)).await?;
    Ok("命令已发送".to_string())
}

/// 获取服务器运行时信息（主机、系统、CPU、内存、磁盘、网络）
#[tauri::command]
pub async fn get_server_runtime_info(
    session_id: String,
    ssh_state: State<'_, SshState>,
) -> Result<ServerRuntimeInfo, String> {
    let manager = ssh_state.manager.lock().await;
    let output = manager.execute_command(&session_id, SERVER_INFO_COMMAND).await?;
    Ok(parse_runtime_info(&output))
}

/// 获取进程列表（按 CPU 使用率降序）
#[tauri::command]
pub async fn get_server_process_list(
    session_id: String,
    limit: Option<u32>,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<ServerProcessInfo>, String> {
    let manager = ssh_state.manager.lock().await;
    let command = build_process_list_command(clamp_limit(limit, 60, 300));
    let output = manager.execute_command(&session_id, &command).await?;
    Ok(parse_process_list(&output))
}

/// 获取网络连接列表
#[tauri::command]
pub async fn get_server_network_connections(
    session_id: String,
    limit: Option<u32>,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<ServerNetworkConnection>, String> {
    let manager = ssh_state.manager.lock().await;
    let command = build_network_connection_command(clamp_limit(limit, 120, 500));
    let output = manager.execute_command(&session_id, &command).await?;
    Ok(parse_network_connections(&output))
}

/// 获取文件系统使用情况
#[tauri::command]
pub async fn get_server_filesystems(
    session_id: String,
    limit: Option<u32>,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<ServerFilesystemInfo>, String> {
    let manager = ssh_state.manager.lock().await;
    let command = build_filesystem_list_command(clamp_limit(limit, 80, 300));
    let output = manager.execute_command(&session_id, &command).await?;
    Ok(parse_filesystems(&output))
}
