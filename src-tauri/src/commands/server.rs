//! 服务器管理命令

use crate::models::{AuthType, DeviceType, Server};
use crate::AppState;
use rusqlite::params;
use tauri::State;

/// 获取所有服务器
#[tauri::command]
pub fn get_servers(state: State<AppState>) -> Result<Vec<Server>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn
        .prepare("SELECT id, name, host, port, username, auth_type, password, private_key_path, group_name, device_type, created_at, updated_at FROM servers ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    
    let servers = stmt
        .query_map([], |row| {
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
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    
    Ok(servers)
}

/// 添加服务器
#[tauri::command]
pub fn add_server(
    state: State<AppState>,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
    group: Option<String>,
    device_type: Option<String>,
) -> Result<Server, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let auth_type_enum: AuthType = auth_type.parse().map_err(|e: String| e)?;
    let device_type_enum: DeviceType = device_type
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("linux")
        .parse()
        .map_err(|e: String| e)?;
    
    conn.execute(
        "INSERT INTO servers (id, name, host, port, username, auth_type, password, private_key_path, group_name, device_type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![id, name, host, port as i64, username, auth_type_enum.to_string(), password, private_key_path, group, device_type_enum.to_string(), now, now],
    ).map_err(|e| e.to_string())?;
    
    Ok(Server {
        id,
        name,
        host,
        port,
        username,
        auth_type: auth_type_enum,
        password,
        private_key_path,
        group,
        device_type: device_type_enum,
        created_at: now,
        updated_at: now,
    })
}

/// 更新服务器
#[tauri::command]
pub fn update_server(
    state: State<AppState>,
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    auth_type: String,
    password: Option<String>,
    private_key_path: Option<String>,
    group: Option<String>,
    device_type: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let auth_type_enum: AuthType = auth_type.parse().map_err(|e: String| e)?;
    let device_type_enum: DeviceType = device_type
        .as_deref()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or("linux")
        .parse()
        .map_err(|e: String| e)?;
    
    conn.execute(
        "UPDATE servers SET name = ?1, host = ?2, port = ?3, username = ?4, auth_type = ?5, password = ?6, private_key_path = ?7, group_name = ?8, device_type = ?9, updated_at = ?10 WHERE id = ?11",
        params![name, host, port as i64, username, auth_type_enum.to_string(), password, private_key_path, group, device_type_enum.to_string(), now, id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

/// 删除服务器
#[tauri::command]
pub fn delete_server(state: State<AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    conn.execute("DELETE FROM servers WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    
    Ok(())
}
