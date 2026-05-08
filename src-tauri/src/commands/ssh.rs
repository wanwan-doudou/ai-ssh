//! SSH 命令接口
//!
//! 提供 Tauri 命令接口，连接前端和 SSH 管理器

use crate::models::{AuthType, DeviceProfile, DeviceType, Server};
use crate::ssh::SshManager;
use crate::AppState;
use rusqlite::params;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, State};

/// SSH 管理器状态
pub struct SshState {
    pub manager: Arc<SshManager>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<String>,
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

const HUAWEI_VERSION_COMMANDS: &[&str] = &["display version"];
const HUAWEI_CPU_COMMANDS: &[&str] = &["display cpu-usage", "display cpu"];
const HUAWEI_MEMORY_COMMANDS: &[&str] = &["display memory-usage", "display memory"];
const HUAWEI_ENVIRONMENT_COMMANDS: &[&str] = &[
    "display temperature",
    "display environment",
    "display device",
];
const HUAWEI_INTERFACE_COMMANDS: &[&str] = &["display interface", "display counters"];

const H3C_VERSION_COMMANDS: &[&str] = &["display version"];
const H3C_CPU_COMMANDS: &[&str] = &["display cpu-usage", "display cpu"];
const H3C_MEMORY_COMMANDS: &[&str] = &["display memory", "display memory-usage"];
const H3C_ENVIRONMENT_COMMANDS: &[&str] = &[
    "display environment",
    "display device",
    "display temperature",
];
const H3C_INTERFACE_COMMANDS: &[&str] = &["display interface", "display counters"];

const CISCO_VERSION_COMMANDS: &[&str] = &["show version", "show inventory"];
const CISCO_CPU_COMMANDS: &[&str] = &["show processes cpu", "show cpu"];
const CISCO_MEMORY_COMMANDS: &[&str] = &[
    "show memory statistics",
    "show processes memory",
    "show memory",
];
const CISCO_ENVIRONMENT_COMMANDS: &[&str] = &[
    "show environment all",
    "show environment temperature",
    "show environment",
];
const CISCO_INTERFACE_COMMANDS: &[&str] = &["show interfaces counters", "show interfaces"];

const RUIJIE_VERSION_COMMANDS: &[&str] = &["show version", "show system information"];
const RUIJIE_CPU_COMMANDS: &[&str] = &["show cpu", "show cpu usage", "show processes cpu"];
const RUIJIE_MEMORY_COMMANDS: &[&str] = &["show memory", "show memory statistics"];
const RUIJIE_ENVIRONMENT_COMMANDS: &[&str] = &["show environment", "show environment all"];
const RUIJIE_INTERFACE_COMMANDS: &[&str] = &["show interfaces counters", "show interfaces"];

const FORTIGATE_VERSION_COMMANDS: &[&str] = &["get system status"];
const FORTIGATE_CPU_COMMANDS: &[&str] =
    &["get system performance status", "diagnose sys top-summary"];
const FORTIGATE_MEMORY_COMMANDS: &[&str] = &[
    "get system performance status",
    "diagnose hardware sysinfo memory",
];
const FORTIGATE_ENVIRONMENT_COMMANDS: &[&str] = &[
    "execute sensor list",
    "get hardware status",
    "get system status",
];
const FORTIGATE_INTERFACE_COMMANDS: &[&str] = &["get system interface"];

const GENERIC_VERSION_COMMANDS: &[&str] = &[
    "get system status",
    "display version",
    "show version",
    "show system information",
    "show system info",
    "show inventory",
];
const GENERIC_CPU_COMMANDS: &[&str] = &[
    "display cpu-usage",
    "display cpu",
    "show processes cpu",
    "show cpu",
    "show system resources",
    "get system performance status",
];
const GENERIC_MEMORY_COMMANDS: &[&str] = &[
    "display memory-usage",
    "display memory",
    "show memory statistics",
    "show memory",
    "show system resources",
    "get system performance status",
];
const GENERIC_ENVIRONMENT_COMMANDS: &[&str] = &[
    "display environment",
    "display temperature",
    "display device",
    "show environment",
    "show environment all",
    "execute sensor list",
    "get hardware status",
    "get system status",
];
const GENERIC_INTERFACE_COMMANDS: &[&str] = &[
    "display interface",
    "display counters",
    "show interfaces counters",
    "show interfaces",
    "get system interface",
];

#[allow(dead_code)]
struct NetworkCommandProfile {
    profile: DeviceProfile,
    os_label: &'static str,
    version: &'static [&'static str],
    cpu: &'static [&'static str],
    memory: &'static [&'static str],
    environment: &'static [&'static str],
    interfaces: &'static [&'static str],
}

fn network_command_profile(profile: &DeviceProfile) -> NetworkCommandProfile {
    match profile {
        DeviceProfile::Huawei => NetworkCommandProfile {
            profile: DeviceProfile::Huawei,
            os_label: "Huawei VRP",
            version: HUAWEI_VERSION_COMMANDS,
            cpu: HUAWEI_CPU_COMMANDS,
            memory: HUAWEI_MEMORY_COMMANDS,
            environment: HUAWEI_ENVIRONMENT_COMMANDS,
            interfaces: HUAWEI_INTERFACE_COMMANDS,
        },
        DeviceProfile::H3c => NetworkCommandProfile {
            profile: DeviceProfile::H3c,
            os_label: "H3C Comware",
            version: H3C_VERSION_COMMANDS,
            cpu: H3C_CPU_COMMANDS,
            memory: H3C_MEMORY_COMMANDS,
            environment: H3C_ENVIRONMENT_COMMANDS,
            interfaces: H3C_INTERFACE_COMMANDS,
        },
        DeviceProfile::Cisco => NetworkCommandProfile {
            profile: DeviceProfile::Cisco,
            os_label: "Cisco IOS",
            version: CISCO_VERSION_COMMANDS,
            cpu: CISCO_CPU_COMMANDS,
            memory: CISCO_MEMORY_COMMANDS,
            environment: CISCO_ENVIRONMENT_COMMANDS,
            interfaces: CISCO_INTERFACE_COMMANDS,
        },
        DeviceProfile::Ruijie => NetworkCommandProfile {
            profile: DeviceProfile::Ruijie,
            os_label: "Ruijie RGOS",
            version: RUIJIE_VERSION_COMMANDS,
            cpu: RUIJIE_CPU_COMMANDS,
            memory: RUIJIE_MEMORY_COMMANDS,
            environment: RUIJIE_ENVIRONMENT_COMMANDS,
            interfaces: RUIJIE_INTERFACE_COMMANDS,
        },
        DeviceProfile::Fortigate => NetworkCommandProfile {
            profile: DeviceProfile::Fortigate,
            os_label: "FortiGate FortiOS",
            version: FORTIGATE_VERSION_COMMANDS,
            cpu: FORTIGATE_CPU_COMMANDS,
            memory: FORTIGATE_MEMORY_COMMANDS,
            environment: FORTIGATE_ENVIRONMENT_COMMANDS,
            interfaces: FORTIGATE_INTERFACE_COMMANDS,
        },
        DeviceProfile::Auto => NetworkCommandProfile {
            profile: DeviceProfile::Auto,
            os_label: "网络设备",
            version: GENERIC_VERSION_COMMANDS,
            cpu: GENERIC_CPU_COMMANDS,
            memory: GENERIC_MEMORY_COMMANDS,
            environment: GENERIC_ENVIRONMENT_COMMANDS,
            interfaces: GENERIC_INTERFACE_COMMANDS,
        },
    }
}

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
        device_model: None,
        serial_number: None,
        temperature: None,
    }
}

fn looks_like_structured_runtime_output(output: &str) -> bool {
    output.contains("HOST=") && output.contains("OS=")
}

fn first_non_empty_line(output: &str) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("--More--") && !line.starts_with("###"))
        .map(ToString::to_string)
}

fn extract_line_value(line: &str) -> Option<String> {
    let lower = line.to_lowercase();
    for prefix in [
        "hostname ",
        "sysname ",
        "processor board id ",
        "serial number ",
        "serial-number ",
        "model number ",
        "model name ",
    ] {
        if lower.starts_with(prefix) {
            let value = line[prefix.len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

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
        if trimmed.is_empty() || trimmed.starts_with("###") {
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

#[allow(dead_code)]
fn looks_like_network_command_error(output: &str) -> bool {
    let lower = output.to_lowercase();
    [
        "invalid input",
        "unknown command",
        "unrecognized command",
        "incomplete command",
        "ambiguous command",
        "syntax error",
        "command not found",
        "bad command",
        "wrong parameter",
        "too many parameters",
        "too few parameters",
        "authorization failed",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn first_ipv4(output: &str) -> Option<String> {
    output.split_whitespace().find_map(|token| {
        let candidate = token.trim_matches(|c: char| !(c.is_ascii_digit() || c == '.'));
        let octets = candidate.split('.').collect::<Vec<_>>();
        if octets.len() != 4 {
            return None;
        }
        let parsed = octets
            .iter()
            .filter_map(|part| part.parse::<u8>().ok())
            .collect::<Vec<_>>();
        if parsed.len() == 4 && parsed != [0, 0, 0, 0] {
            Some(candidate.to_string())
        } else {
            None
        }
    })
}

fn number_before_keyword(line: &str, keyword: &str) -> Option<u64> {
    let lower = line.to_lowercase();
    let keyword_index = lower.find(keyword)?;
    let prefix = &line[..keyword_index];
    prefix
        .split(|c: char| !(c.is_ascii_digit()))
        .filter(|value| !value.is_empty())
        .filter_map(|value| value.parse::<u64>().ok())
        .last()
}

fn percent_before_keyword(line: &str, keyword: &str) -> Option<f64> {
    let lower = line.to_lowercase();
    let keyword_index = lower.find(keyword)?;
    first_percent(&line[..keyword_index])
}

fn first_percent(text: &str) -> Option<f64> {
    for (index, ch) in text.char_indices() {
        if ch != '%' {
            continue;
        }
        let prefix = &text[..index];
        let number = prefix
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|value| !value.is_empty())
            .last()?;
        if let Ok(value) = number.parse::<f64>() {
            return Some(value.clamp(0.0, 100.0));
        }
    }
    None
}

#[allow(dead_code)]
fn detect_network_profile(output: &str) -> DeviceProfile {
    let lower = output.to_lowercase();

    if lower.contains("fortigate")
        || lower.contains("fortios")
        || lower.contains("fortinet")
        || lower.contains("serial-number:")
    {
        DeviceProfile::Fortigate
    } else if lower.contains("h3c") || lower.contains("comware") {
        DeviceProfile::H3c
    } else if lower.contains("huawei")
        || lower.contains("vrp")
        || lower.contains("versatile routing platform")
    {
        DeviceProfile::Huawei
    } else if lower.contains("ruijie") || lower.contains("rgos") {
        DeviceProfile::Ruijie
    } else if lower.contains("cisco ios")
        || lower.contains("cisco nx-os")
        || lower.contains("cisco adaptive security")
        || lower.contains("processor board id")
        || lower.contains("catalyst")
        || lower.contains("nexus")
    {
        DeviceProfile::Cisco
    } else {
        DeviceProfile::Auto
    }
}

fn profile_matches_text(profile: &DeviceProfile, text: &str) -> bool {
    let lower = text.to_lowercase();
    match profile {
        DeviceProfile::Huawei => lower.contains("huawei") || lower.contains("vrp"),
        DeviceProfile::H3c => lower.contains("h3c") || lower.contains("comware"),
        DeviceProfile::Cisco => {
            lower.contains("cisco") || lower.contains("catalyst") || lower.contains("nexus")
        }
        DeviceProfile::Ruijie => lower.contains("ruijie") || lower.contains("rgos"),
        DeviceProfile::Fortigate => {
            lower.contains("fortigate") || lower.contains("fortios") || lower.contains("fortinet")
        }
        DeviceProfile::Auto => false,
    }
}

fn parse_network_cpu_percent(output: &str) -> Option<f64> {
    output.lines().find_map(|line| {
        let lower = line.to_lowercase();
        if !(lower.contains("cpu") || lower.contains("processor")) {
            return None;
        }
        if lower.contains("idle") {
            if let Some(idle) = percent_before_keyword(line, "idle") {
                return Some((100.0 - idle).clamp(0.0, 100.0));
            }
        }
        first_percent(line)
    })
}

fn size_unit_factor(unit: &str) -> Option<f64> {
    match unit
        .trim_matches(|c: char| !c.is_ascii_alphabetic())
        .to_lowercase()
        .as_str()
    {
        "b" | "byte" | "bytes" => Some(1.0 / 1024.0),
        "k" | "kb" | "kbyte" | "kbytes" | "kib" => Some(1.0),
        "m" | "mb" | "mbyte" | "mbytes" | "mib" => Some(1024.0),
        "g" | "gb" | "gbyte" | "gbytes" | "gib" => Some(1024.0 * 1024.0),
        _ => None,
    }
}

fn parse_size_token_to_kb(token: &str, next: Option<&str>) -> Option<u64> {
    if token.contains('%') {
        return None;
    }

    let cleaned = token.trim_matches(|c: char| {
        c == ',' || c == ';' || c == ':' || c == '=' || c == '(' || c == ')' || c == '[' || c == ']'
    });
    let mut number = String::new();
    let mut suffix = String::new();
    let mut seen_number = false;

    for ch in cleaned.chars() {
        if ch.is_ascii_digit() || (ch == '.' && seen_number) {
            number.push(ch);
            seen_number = true;
        } else if seen_number {
            suffix.push(ch);
        }
    }

    if number.is_empty() {
        return None;
    }

    let value = number.parse::<f64>().ok()?;
    let factor = if !suffix.is_empty() {
        size_unit_factor(&suffix)
    } else {
        next.and_then(size_unit_factor)
    }
    .unwrap_or_else(|| {
        if value >= 10_000_000.0 {
            1.0 / 1024.0
        } else {
            1.0
        }
    });

    Some((value * factor).round().max(0.0) as u64)
}

fn parse_size_values_to_kb(text: &str) -> Vec<u64> {
    let tokens = text.split_whitespace().collect::<Vec<_>>();
    tokens
        .iter()
        .enumerate()
        .filter_map(|(index, token)| parse_size_token_to_kb(token, tokens.get(index + 1).copied()))
        .collect()
}

fn first_size_to_kb(text: &str) -> Option<u64> {
    parse_size_values_to_kb(text).into_iter().next()
}

fn last_size_to_kb(text: &str) -> Option<u64> {
    parse_size_values_to_kb(text).into_iter().last()
}

fn size_before_keyword(line: &str, keyword: &str) -> Option<u64> {
    let lower = line.to_lowercase();
    let keyword_index = lower.find(keyword)?;
    last_size_to_kb(&line[..keyword_index])
}

fn size_after_keyword(line: &str, keyword: &str) -> Option<u64> {
    let lower = line.to_lowercase();
    let keyword_index = lower.find(keyword)?;
    first_size_to_kb(&line[keyword_index + keyword.len()..])
}

#[derive(Default)]
struct NetworkMemoryMetrics {
    total_kb: Option<u64>,
    used_kb: Option<u64>,
    available_kb: Option<u64>,
    percent: Option<f64>,
}

fn parse_network_memory_metrics(output: &str) -> NetworkMemoryMetrics {
    let mut metrics = NetworkMemoryMetrics::default();
    let mut paired_total_kb = 0_u64;
    let mut paired_used_kb = 0_u64;

    for line in output.lines() {
        let lower = line.to_lowercase();
        let is_memory_line = lower.contains("memory")
            || lower.contains("mem:")
            || lower.contains("processor pool")
            || lower.contains("i/o pool");
        if !is_memory_line {
            continue;
        }

        if metrics.percent.is_none() {
            metrics.percent = first_percent(line);
        }

        let total =
            size_before_keyword(line, "total").or_else(|| size_after_keyword(line, "total"));
        let used = size_before_keyword(line, "used").or_else(|| size_after_keyword(line, "used"));
        let free = size_before_keyword(line, "free")
            .or_else(|| size_after_keyword(line, "free"))
            .or_else(|| size_before_keyword(line, "available"))
            .or_else(|| size_after_keyword(line, "available"));

        if let (Some(total), Some(used)) = (total, used) {
            if total > 0 {
                paired_total_kb = paired_total_kb.saturating_add(total);
                paired_used_kb = paired_used_kb.saturating_add(used.min(total));
            }
            continue;
        }

        if metrics.total_kb.is_none() {
            metrics.total_kb = total;
        }
        if metrics.used_kb.is_none() {
            metrics.used_kb = used;
        }
        if metrics.available_kb.is_none() {
            metrics.available_kb = free;
        }
    }

    if paired_total_kb > 0 {
        metrics.total_kb = Some(paired_total_kb);
        metrics.used_kb = Some(paired_used_kb);
        metrics.available_kb = Some(paired_total_kb.saturating_sub(paired_used_kb));
    }

    if metrics.used_kb.is_none() {
        if let (Some(total), Some(available)) = (metrics.total_kb, metrics.available_kb) {
            metrics.used_kb = Some(total.saturating_sub(available.min(total)));
        }
    }

    if metrics.percent.is_none() {
        if let (Some(total), Some(used)) = (metrics.total_kb, metrics.used_kb) {
            if total > 0 {
                metrics.percent = Some(((used as f64) / (total as f64) * 100.0).clamp(0.0, 100.0));
            }
        }
    }

    metrics
}

fn parse_network_temperature(output: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if lower.contains("temperature") || lower.contains("temp") {
            Some(trimmed.to_string())
        } else {
            None
        }
    })
}

fn parse_network_bytes(output: &str, directions: &[&str]) -> u64 {
    output
        .lines()
        .filter_map(|line| {
            let lower = line.to_lowercase();
            if !directions.iter().any(|direction| lower.contains(direction)) {
                return None;
            }
            number_before_keyword(line, "bytes")
        })
        .sum()
}

fn parse_network_hostname(output: &str, profile: &DeviceProfile) -> String {
    if let Some(host) = find_value_by_keywords(
        output,
        &[
            "hostname",
            "host name",
            "device name",
            "sysname",
            "system name",
        ],
    ) {
        return host;
    }

    for line in output.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if let Some((host, _)) = lower.split_once(" uptime is ") {
            let original_host = &trimmed[..host.len()];
            let candidate = original_host.trim();
            if !candidate.is_empty()
                && !candidate.contains(' ')
                && !profile_matches_text(profile, candidate)
            {
                return candidate.to_string();
            }
        }
    }

    "unknown".to_string()
}

fn parse_network_os(output: &str, profile: &DeviceProfile) -> String {
    let profile_info = network_command_profile(profile);
    let keywords: &[&str] = match profile {
        DeviceProfile::Fortigate => &["version:", "fortios", "fortigate"],
        DeviceProfile::Huawei => &["vrp", "huawei", "software", "version"],
        DeviceProfile::H3c => &["comware", "h3c", "software", "version"],
        DeviceProfile::Cisco => &[
            "cisco ios",
            "cisco nx-os",
            "cisco adaptive security",
            "software",
        ],
        DeviceProfile::Ruijie => &["ruijie", "rgos", "software", "version"],
        DeviceProfile::Auto => &["software", "version", "ios", "nx-os", "fortios", "huawei"],
    };

    find_value_by_keywords(output, keywords)
        .or_else(|| first_non_empty_line(output))
        .unwrap_or_else(|| profile_info.os_label.to_string())
}

fn parse_network_model(output: &str, profile: &DeviceProfile) -> Option<String> {
    if let Some(model) = find_value_by_keywords(
        output,
        &[
            "model name",
            "model number",
            "device model",
            "product model",
            "product id",
            "chassis type",
            "chassis",
            "hardware",
            "pid",
        ],
    ) {
        return Some(model);
    }

    for line in output.lines() {
        let trimmed = line.trim();
        let lower = trimmed.to_lowercase();
        if trimmed.is_empty()
            || trimmed.starts_with("###")
            || lower.contains("software")
            || lower.contains("copyright")
            || lower.starts_with("version:")
        {
            continue;
        }

        match profile {
            DeviceProfile::Huawei | DeviceProfile::H3c | DeviceProfile::Ruijie => {
                if profile_matches_text(profile, trimmed) {
                    if let Some((model, _)) = lower.split_once(" uptime is ") {
                        return Some(trimmed[..model.len()].trim().to_string());
                    }
                    return Some(trimmed.to_string());
                }
            }
            DeviceProfile::Cisco => {
                if lower.starts_with("cisco ") || lower.contains(" cisco ") {
                    if let Some((model, _)) = lower.split_once(" processor") {
                        return Some(trimmed[..model.len()].trim().to_string());
                    }
                    return Some(trimmed.to_string());
                }
            }
            DeviceProfile::Fortigate => {
                if profile_matches_text(profile, trimmed) && lower.contains("version") {
                    return Some(trimmed.to_string());
                }
            }
            DeviceProfile::Auto => {}
        }
    }

    None
}

fn parse_network_serial(output: &str) -> Option<String> {
    find_value_by_keywords(
        output,
        &[
            "serial-number",
            "serial number",
            "serial no",
            "serial num",
            "system serial",
            "system serial number",
            "processor board id",
            "chassis serial",
            "sn:",
        ],
    )
}

fn apply_network_memory_metrics(info: &mut ServerRuntimeInfo, metrics: NetworkMemoryMetrics) {
    if let Some(total_kb) = metrics.total_kb {
        let used_kb = metrics
            .used_kb
            .or_else(|| {
                metrics
                    .percent
                    .map(|percent| ((total_kb as f64) * percent / 100.0).round() as u64)
            })
            .unwrap_or(0)
            .min(total_kb);

        info.memory_total_kb = total_kb;
        info.memory_used_kb = used_kb;
        info.memory_available_kb = metrics
            .available_kb
            .unwrap_or_else(|| total_kb.saturating_sub(used_kb));
    } else if let Some(memory_percent) = metrics.percent {
        info.memory_total_kb = 100;
        info.memory_used_kb = memory_percent.round().clamp(0.0, 100.0) as u64;
        info.memory_available_kb = 100_u64.saturating_sub(info.memory_used_kb);
    }
}

fn parse_network_runtime_info(output: &str, profile: &DeviceProfile) -> ServerRuntimeInfo {
    let profile_info = network_command_profile(profile);
    let mut info = empty_runtime_info("unknown".to_string(), profile_info.os_label.to_string());

    if output.trim().is_empty() {
        return info;
    }

    info.host = parse_network_hostname(output, profile);

    if let Some(uptime) = find_value_by_keywords(output, &["uptime", "up time", "运行时间"]) {
        info.uptime = uptime;
    }

    info.os = parse_network_os(output, profile);

    info.kernel_name = "network-os".to_string();
    info.kernel = info.os.clone();
    info.ip_address = first_ipv4(output).unwrap_or_else(|| "unknown".to_string());

    if let Some(model) = parse_network_model(output, profile) {
        info.device_model = Some(model.clone());
        info.cpu_model = model;
    }

    info.serial_number = parse_network_serial(output);
    info.temperature = parse_network_temperature(output);

    if let Some(cpu_percent) = parse_network_cpu_percent(output) {
        info.cpu_user_percent = cpu_percent;
        info.cpu_idle_percent = 100.0 - cpu_percent;
        info.load_avg = format!("{:.1}% CPU", cpu_percent);
    }

    apply_network_memory_metrics(&mut info, parse_network_memory_metrics(output));

    info.net_rx_bytes = parse_network_bytes(output, &[" input", "rx", "receive"]);
    info.net_tx_bytes = parse_network_bytes(output, &[" output", "tx", "transmit"]);
    info
}

#[allow(dead_code)]
async fn execute_first_useful_network_command(
    manager: &SshManager,
    session_id: &str,
    commands: &[&str],
) -> Result<String, String> {
    let mut last_error: Option<String> = None;

    for command in commands {
        match manager.execute_command(session_id, command).await {
            Ok(output)
                if !output.trim().is_empty() && !looks_like_network_command_error(&output) =>
            {
                return Ok(output)
            }
            Ok(output) => {
                last_error = Some(format!("命令无有效输出: {} ({})", command, output.trim()));
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    Err(last_error.unwrap_or_else(|| "没有可用的网络设备命令".to_string()))
}

#[allow(dead_code)]
async fn collect_network_runtime_output(
    manager: &SshManager,
    session_id: &str,
    requested_profile: DeviceProfile,
) -> Result<(String, DeviceProfile), String> {
    if requested_profile != DeviceProfile::Auto {
        let output = collect_network_profile_runtime_output(
            manager,
            session_id,
            network_command_profile(&requested_profile),
            None,
        )
        .await?;
        return Ok((output, requested_profile));
    }

    let version_output = execute_first_useful_network_command(
        manager,
        session_id,
        network_command_profile(&DeviceProfile::Auto).version,
    )
    .await
    .ok();
    let detected_profile = version_output
        .as_deref()
        .map(detect_network_profile)
        .filter(|profile| *profile != DeviceProfile::Auto)
        .unwrap_or(DeviceProfile::Auto);

    let output = collect_network_profile_runtime_output(
        manager,
        session_id,
        network_command_profile(&detected_profile),
        version_output,
    )
    .await?;

    Ok((output, detected_profile))
}

#[allow(dead_code)]
async fn collect_network_profile_runtime_output(
    manager: &SshManager,
    session_id: &str,
    profile: NetworkCommandProfile,
    version_output: Option<String>,
) -> Result<String, String> {
    let mut sections = Vec::new();

    sections.push(format!(
        "### profile\nPROFILE={}\nOS_LABEL={}",
        profile.profile, profile.os_label
    ));

    if let Some(output) = version_output {
        if !output.trim().is_empty() && !looks_like_network_command_error(&output) {
            sections.push(format!("### version\n{}", output));
        }
    } else if let Ok(output) =
        execute_first_useful_network_command(manager, session_id, profile.version).await
    {
        sections.push(format!("### version\n{}", output));
    }

    let command_groups: [(&str, &[&str]); 4] = [
        ("cpu", profile.cpu),
        ("memory", profile.memory),
        ("environment", profile.environment),
        ("interfaces", profile.interfaces),
    ];

    for (label, commands) in command_groups {
        if let Ok(output) =
            execute_first_useful_network_command(manager, session_id, commands).await
        {
            sections.push(format!("### {}\n{}", label, output));
        }
    }

    if sections.len() <= 1 {
        Err("没有可用的网络设备命令".to_string())
    } else {
        Ok(sections.join("\n\n"))
    }
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
        host: values
            .get("HOST")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
        os: values
            .get("OS")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string()),
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
        device_model: None,
        serial_number: None,
        temperature: None,
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
    initial_cols: Option<u32>,
    initial_rows: Option<u32>,
    app_state: State<'_, AppState>,
    ssh_state: State<'_, SshState>,
    app_handle: AppHandle,
) -> Result<(), String> {
    println!(
        "[CMD] connect_ssh 命令被调用: session_id={}, server_id={}, initial_cols={:?}, initial_rows={:?}",
        session_id, server_id, initial_cols, initial_rows
    );

    // 从数据库获取服务器信息
    let server = {
        let conn = app_state.db.lock().map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare("SELECT id, name, host, port, username, auth_type, password, private_key_path, group_name, device_type, device_profile, legacy_algorithms, created_at, updated_at FROM servers WHERE id = ?1")
            .map_err(|e| e.to_string())?;

        let server = stmt
            .query_row(params![server_id], |row| {
                Ok(Server {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    host: row.get(2)?,
                    port: row.get::<_, i64>(3)? as u16,
                    username: row.get(4)?,
                    auth_type: row
                        .get::<_, String>(5)?
                        .parse()
                        .unwrap_or(AuthType::Password),
                    password: row.get(6)?,
                    private_key_path: row.get(7)?,
                    group: row.get(8)?,
                    device_type: row
                        .get::<_, String>(9)?
                        .parse()
                        .unwrap_or(DeviceType::Linux),
                    device_profile: row
                        .get::<_, String>(10)?
                        .parse()
                        .unwrap_or(DeviceProfile::Auto),
                    legacy_algorithms: row.get::<_, i64>(11)? != 0,
                    created_at: row.get(12)?,
                    updated_at: row.get(13)?,
                })
            })
            .map_err(|e| format!("服务器不存在: {}", e))?;

        server
    };

    // 建立 SSH 连接
    ssh_state
        .manager
        .connect_async(&session_id, &server, app_handle, initial_cols, initial_rows)
        .await?;

    Ok(())
}

/// 断开 SSH 连接
#[tauri::command]
pub async fn disconnect_ssh(
    session_id: String,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    ssh_state.manager.disconnect(&session_id).await?;
    Ok(())
}

/// 发送数据到 SSH 会话
#[tauri::command]
pub async fn write_ssh(
    session_id: String,
    data: String,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    ssh_state.manager.write(&session_id, &data).await
}

/// 调整终端窗口大小
#[tauri::command]
pub async fn resize_ssh(
    session_id: String,
    cols: u32,
    rows: u32,
    ssh_state: State<'_, SshState>,
) -> Result<(), String> {
    ssh_state.manager.resize(&session_id, cols, rows).await
}

/// 发送 SSH 命令 (保留兼容性)
#[tauri::command]
pub async fn send_ssh_command(
    session_id: String,
    command: String,
    ssh_state: State<'_, SshState>,
) -> Result<String, String> {
    ssh_state
        .manager
        .write(&session_id, &format!("{}\n", command))
        .await?;
    Ok("命令已发送".to_string())
}

/// 获取服务器运行时信息（主机、系统、CPU、内存、磁盘、网络）
#[tauri::command]
pub async fn get_server_runtime_info(
    session_id: String,
    ssh_state: State<'_, SshState>,
) -> Result<ServerRuntimeInfo, String> {
    let manager = ssh_state.manager.clone();
    let device_type = manager
        .session_device_type(&session_id)
        .await
        .unwrap_or(DeviceType::Linux);

    if device_type == DeviceType::Network {
        let device_profile = manager
            .session_device_profile(&session_id)
            .await
            .unwrap_or(DeviceProfile::Auto);
        return Ok(empty_runtime_info(
            "unknown".to_string(),
            network_command_profile(&device_profile).os_label.to_string(),
        ));
    }

    let output = execute_first_non_empty_command(
        manager.as_ref(),
        &session_id,
        &[SERVER_INFO_COMMAND_LINUX, SERVER_INFO_COMMAND_LINUX_MINIMAL],
    )
    .await?;

    if looks_like_structured_runtime_output(&output) {
        Ok(parse_runtime_info(&output))
    } else {
        Ok(parse_network_runtime_info(&output, &DeviceProfile::Auto))
    }
}

/// 获取进程列表（按 CPU 使用率降序）
#[tauri::command]
pub async fn get_server_process_list(
    session_id: String,
    limit: Option<u32>,
    ssh_state: State<'_, SshState>,
) -> Result<Vec<ServerProcessInfo>, String> {
    let manager = ssh_state.manager.clone();
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
    let manager = ssh_state.manager.clone();
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
    let manager = ssh_state.manager.clone();
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
