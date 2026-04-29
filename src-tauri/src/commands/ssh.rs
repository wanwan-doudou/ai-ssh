//! SSH 命令接口
//!
//! 提供 Tauri 命令接口，连接前端和 SSH 管理器

use crate::models::{AuthType, DeviceType, Server};
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

const SERVER_INFO_COMMAND_LINUX: &str = r#"sh -lc '
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

const SERVER_INFO_COMMAND_LINUX_MINIMAL: &str = r#"sh -lc '
HOST=$(hostname 2>/dev/null || uname -n 2>/dev/null || echo unknown)
OS=$(uname -sr 2>/dev/null || echo unknown)
KERNEL_NAME=$(uname -s 2>/dev/null || echo unknown)
KERNEL_VERSION=$(uname -r 2>/dev/null || echo unknown)
ARCH=$(uname -m 2>/dev/null || echo unknown)
KERNEL=$(uname -a 2>/dev/null || echo unknown)
UPTIME=$(uptime 2>/dev/null | sed -n "s/.*up \([^,]*\).*/\1/p")
if [ -z "$UPTIME" ]; then UPTIME=unknown; fi
CPU_MODEL=$(uname -p 2>/dev/null || echo unknown)
IP_ADDR=$(hostname -I 2>/dev/null | awk "{print \$1}")
if [ -z "$IP_ADDR" ]; then IP_ADDR=$(ip route get 1 2>/dev/null | awk "{for(i=1;i<=NF;i++) if(\$i==\"src\"){print \$(i+1); exit}}"); fi
if [ -z "$IP_ADDR" ]; then IP_ADDR=unknown; fi
printf "HOST=%s\nOS=%s\nKERNEL=%s\nKERNEL_NAME=%s\nKERNEL_VERSION=%s\nARCH=%s\nUPTIME=%s\nCPU_MODEL=%s\nCPU_CORES=0\nLOAD_AVG=unknown\nMEM_TOTAL_KB=0\nMEM_USED_KB=0\nMEM_AVAIL_KB=0\nSWAP_TOTAL_KB=0\nSWAP_USED_KB=0\nCPU_USER_PCT=0.0\nCPU_NICE_PCT=0.0\nCPU_SYSTEM_PCT=0.0\nCPU_IDLE_PCT=0.0\nCPU_IOWAIT_PCT=0.0\nCPU_IRQ_PCT=0.0\nCPU_SOFTIRQ_PCT=0.0\nCPU_STEAL_PCT=0.0\nDISK_TOTAL_KB=0\nDISK_USED_KB=0\nDISK_USE_PCT=0\nIP_ADDR=%s\nNET_RX_BYTES=0\nNET_TX_BYTES=0\n" \
  "$HOST" "$OS" "$KERNEL" "$KERNEL_NAME" "$KERNEL_VERSION" "$ARCH" "$UPTIME" "$CPU_MODEL" "$IP_ADDR"
'"#;

const NETWORK_RUNTIME_INFO_CANDIDATE_COMMANDS: [&str; 6] = [
    "show version",
    "display version",
    "get system status",
    "show system information",
    "show system info",
    "show inventory",
];

fn clamp_limit(limit: Option<u32>, default_value: usize, max_value: usize) -> usize {
    let value = limit.unwrap_or(default_value as u32) as usize;
    value.clamp(1, max_value)
}

fn empty_runtime_info(host: String, os: String) -> ServerRuntimeInfo {
    ServerRuntimeInfo {
        host,
        os,
        kernel: "unknown".to_string(),
        kernel_name: "unknown".to_string(),
        kernel_version: "unknown".to_string(),
        architecture: "unknown".to_string(),
        uptime: "unknown".to_string(),
        cpu_model: "unknown".to_string(),
        cpu_cores: 0,
        load_avg: "unknown".to_string(),
        memory_total_kb: 0,
        memory_used_kb: 0,
        memory_available_kb: 0,
        swap_total_kb: 0,
        swap_used_kb: 0,
        cpu_user_percent: 0.0,
        cpu_nice_percent: 0.0,
        cpu_system_percent: 0.0,
        cpu_idle_percent: 0.0,
        cpu_iowait_percent: 0.0,
        cpu_irq_percent: 0.0,
        cpu_softirq_percent: 0.0,
        cpu_steal_percent: 0.0,
        disk_total_kb: 0,
        disk_used_kb: 0,
        disk_use_percent: 0.0,
        ip_address: "unknown".to_string(),
        net_rx_bytes: 0,
        net_tx_bytes: 0,
        collected_at: chrono::Utc::now().timestamp_millis(),
    }
}

fn looks_like_structured_runtime_output(output: &str) -> bool {
    output.contains("HOST=") && output.contains("OS=")
}

fn first_non_empty_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("--More--"))
        .map(ToString::to_string)
}

fn extract_line_value(line: &str) -> Option<String> {
    if let Some((_, value)) = line.split_once(':') {
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    if let Some((_, value)) = line.split_once('=') {
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    if let Some((_, value)) = line.split_once(" is ") {
        let value = value.trim();
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    None
}

fn find_value_by_keywords(output: &str, keywords: &[&str]) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }

        let lower = trimmed.to_lowercase();
        if lower.starts_with("show ") || lower.starts_with("display ") || lower.starts_with("get ")
        {
            return None;
        }

        if keywords.iter().any(|keyword| lower.contains(keyword)) {
            return extract_line_value(trimmed).or_else(|| Some(trimmed.to_string()));
        }

        None
    })
}

fn parse_network_runtime_info(output: &str) -> ServerRuntimeInfo {
    let mut info = empty_runtime_info("unknown".to_string(), "网络设备".to_string());

    if output.trim().is_empty() {
        return info;
    }

    if let Some(host) = find_value_by_keywords(
        output,
        &["hostname", "host name", "device name", "sysname", "system name"],
    ) {
        info.host = host;
    }

    if let Some(uptime) = find_value_by_keywords(output, &["uptime", "up time", "运行时间"]) {
        info.uptime = uptime;
    }

    if let Some(os_line) = find_value_by_keywords(
        output,
        &[
            "software",
            "version",
            "ios",
            "nx-os",
            "fortios",
            "junos",
            "huawei",
        ],
    ) {
        info.os = os_line;
    } else if let Some(first_line) = first_non_empty_line(output) {
        info.os = first_line;
    }

    info.kernel_name = "network-os".to_string();
    info.kernel = info.os.clone();
    info
}

async fn execute_first_non_empty_command(
    manager: &SshManager,
    session_id: &str,
    commands: &[&str],
) -> Result<String, String> {
    let mut last_error: Option<String> = None;

    for command in commands {
        match manager.execute_command(session_id, command).await {
            Ok(output) if !output.trim().is_empty() => return Ok(output),
            Ok(_) => {
                last_error = Some(format!("命令无输出: {}", command));
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "没有可用的命令".to_string()))
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
        r#"sh -lc 'set -f; if ps -eo pid=,user=,rss=,pcpu=,comm=,args= --sort=-pcpu >/dev/null 2>&1; then ps -eo pid=,user=,rss=,pcpu=,comm=,args= --sort=-pcpu 2>/dev/null | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 5 ] && continue; pid=$1; user=$2; rss=$3; cpu=$4; name=$5; shift 5; cmd="$*"; printf "PID=%s\tUSER=%s\tRSS_KB=%s\tCPU=%s\tNAME=%s\tCMD=%s\n" "$pid" "$user" "$rss" "$cpu" "$name" "$cmd"; done; elif ps >/dev/null 2>&1; then ps 2>/dev/null | tail -n +2 | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 1 ] && continue; pid=$1; user=${{2:-unknown}}; name=${{5:-unknown}}; printf "PID=%s\tUSER=%s\tRSS_KB=0\tCPU=0\tNAME=%s\tCMD=%s\n" "$pid" "$user" "$name" "$line"; done; fi'"#
    )
}

fn build_network_connection_command(limit: usize) -> String {
    format!(
        r#"sh -lc 'set -f; if command -v ss >/dev/null 2>&1; then ss -tunapH 2>/dev/null | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 6 ] && continue; proto=$1; state=$2; recvq=$3; sendq=$4; local=$5; peer=$6; shift 6; proc="$*"; printf "PROTO=%s\tSTATE=%s\tRECV_Q=%s\tSEND_Q=%s\tLOCAL=%s\tPEER=%s\tPROC=%s\n" "$proto" "$state" "$recvq" "$sendq" "$local" "$peer" "$proc"; done; elif command -v netstat >/dev/null 2>&1; then netstat -tunap 2>/dev/null | tail -n +3 | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 5 ] && continue; proto=$1; recvq=$2; sendq=$3; local=$4; peer=$5; state=UNKNOWN; proc="-"; if [ "$proto" = "tcp" ] || [ "$proto" = "tcp6" ]; then state=${{6:-UNKNOWN}}; shift 6; proc="$*"; else shift 5; proc="$*"; fi; [ -z "$proc" ] && proc="-"; printf "PROTO=%s\tSTATE=%s\tRECV_Q=%s\tSEND_Q=%s\tLOCAL=%s\tPEER=%s\tPROC=%s\n" "$proto" "$state" "$recvq" "$sendq" "$local" "$peer" "$proc"; done; fi'"#
    )
}

fn build_filesystem_list_command(limit: usize) -> String {
    format!(
        r#"sh -lc 'if df -kPT >/dev/null 2>&1; then df -kPT 2>/dev/null | tail -n +2 | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 7 ] && continue; fs=$1; fstype=$2; size=$3; used=$4; avail=$5; usep=$6; mount=$7; pct=$(printf "%s" "$usep" | tr -d "%"); printf "FS=%s\tTYPE=%s\tSIZE_KB=%s\tUSED_KB=%s\tAVAIL_KB=%s\tUSE_PCT=%s\tMOUNT=%s\n" "$fs" "$fstype" "$size" "$used" "$avail" "$pct" "$mount"; done; else df -kP 2>/dev/null | tail -n +2 | head -n {limit} | while IFS= read -r line; do set -- $line; [ $# -lt 6 ] && continue; fs=$1; size=$2; used=$3; avail=$4; usep=$5; mount=$6; pct=$(printf "%s" "$usep" | tr -d "%"); printf "FS=%s\tTYPE=unknown\tSIZE_KB=%s\tUSED_KB=%s\tAVAIL_KB=%s\tUSE_PCT=%s\tMOUNT=%s\n" "$fs" "$size" "$used" "$avail" "$pct" "$mount"; done; fi'"#
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
            .prepare("SELECT id, name, host, port, username, auth_type, password, private_key_path, group_name, device_type, created_at, updated_at FROM servers WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        
        let server = stmt
            .query_row(params![server_id], |row| {
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
                    device_type: row
                        .get::<_, String>(9)?
                        .parse()
                        .unwrap_or(DeviceType::Linux),
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
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
    let device_type = manager
        .session_device_type(&session_id)
        .await
        .unwrap_or(DeviceType::Linux);

    if device_type == DeviceType::Network {
        match execute_first_non_empty_command(
            &manager,
            &session_id,
            &NETWORK_RUNTIME_INFO_CANDIDATE_COMMANDS,
        )
        .await
        {
            Ok(output) => return Ok(parse_network_runtime_info(&output)),
            Err(_) => return Ok(empty_runtime_info("unknown".to_string(), "网络设备".to_string())),
        }
    }

    let output = execute_first_non_empty_command(
        &manager,
        &session_id,
        &[SERVER_INFO_COMMAND_LINUX, SERVER_INFO_COMMAND_LINUX_MINIMAL],
    )
    .await?;

    if looks_like_structured_runtime_output(&output) {
        Ok(parse_runtime_info(&output))
    } else {
        Ok(parse_network_runtime_info(&output))
    }
}

/// 获取进程列表（按 CPU 使用率降序）
#[tauri::command]
pub async fn get_server_process_list(
    session_id: String,
    limit: Option<u32>,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<ServerProcessInfo>, String> {
    let manager = ssh_state.manager.lock().await;
    let device_type = manager
        .session_device_type(&session_id)
        .await
        .unwrap_or(DeviceType::Linux);
    if device_type == DeviceType::Network {
        return Ok(Vec::new());
    }

    let command = build_process_list_command(clamp_limit(limit, 60, 300));
    match manager.execute_command(&session_id, &command).await {
        Ok(output) => Ok(parse_process_list(&output)),
        Err(_) => Ok(Vec::new()),
    }
}

/// 获取网络连接列表
#[tauri::command]
pub async fn get_server_network_connections(
    session_id: String,
    limit: Option<u32>,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<ServerNetworkConnection>, String> {
    let manager = ssh_state.manager.lock().await;
    let device_type = manager
        .session_device_type(&session_id)
        .await
        .unwrap_or(DeviceType::Linux);
    if device_type == DeviceType::Network {
        return Ok(Vec::new());
    }

    let command = build_network_connection_command(clamp_limit(limit, 120, 500));
    match manager.execute_command(&session_id, &command).await {
        Ok(output) => Ok(parse_network_connections(&output)),
        Err(_) => Ok(Vec::new()),
    }
}

/// 获取文件系统使用情况
#[tauri::command]
pub async fn get_server_filesystems(
    session_id: String,
    limit: Option<u32>,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<ServerFilesystemInfo>, String> {
    let manager = ssh_state.manager.lock().await;
    let device_type = manager
        .session_device_type(&session_id)
        .await
        .unwrap_or(DeviceType::Linux);
    if device_type == DeviceType::Network {
        return Ok(Vec::new());
    }

    let command = build_filesystem_list_command(clamp_limit(limit, 80, 300));
    match manager.execute_command(&session_id, &command).await {
        Ok(output) => Ok(parse_filesystems(&output)),
        Err(_) => Ok(Vec::new()),
    }
}
