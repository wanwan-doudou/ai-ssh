//! 数据库初始化和操作

use rusqlite::{Connection, Result};
use std::path::Path;

/// 初始化数据库
pub fn init_database(path: &Path) -> Result<Connection> {
    let conn = Connection::open(path)?;

    // 创建服务器表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS servers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL DEFAULT 22,
            username TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            password TEXT,
            private_key_path TEXT,
            group_name TEXT,
            device_type TEXT NOT NULL DEFAULT 'linux',
            device_profile TEXT NOT NULL DEFAULT 'auto',
            legacy_algorithms INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    // 兼容旧版本数据库：补充 device_type 字段
    let has_device_type = {
        let mut stmt = conn.prepare("PRAGMA table_info(servers)")?;
        let mut rows = stmt.query([])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            let column_name: String = row.get(1)?;
            if column_name == "device_type" {
                found = true;
                break;
            }
        }
        found
    };

    if !has_device_type {
        conn.execute(
            "ALTER TABLE servers ADD COLUMN device_type TEXT NOT NULL DEFAULT 'linux'",
            [],
        )?;
    }

    let has_legacy_algorithms = {
        let mut stmt = conn.prepare("PRAGMA table_info(servers)")?;
        let mut rows = stmt.query([])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            let column_name: String = row.get(1)?;
            if column_name == "legacy_algorithms" {
                found = true;
                break;
            }
        }
        found
    };

    if !has_legacy_algorithms {
        conn.execute(
            "ALTER TABLE servers ADD COLUMN legacy_algorithms INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
        conn.execute(
            "UPDATE servers SET legacy_algorithms = 1 WHERE device_type = 'network'",
            [],
        )?;
    }

    let has_device_profile = {
        let mut stmt = conn.prepare("PRAGMA table_info(servers)")?;
        let mut rows = stmt.query([])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            let column_name: String = row.get(1)?;
            if column_name == "device_profile" {
                found = true;
                break;
            }
        }
        found
    };

    if !has_device_profile {
        conn.execute(
            "ALTER TABLE servers ADD COLUMN device_profile TEXT NOT NULL DEFAULT 'auto'",
            [],
        )?;
    }

    // 创建 providers 表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            api_key TEXT NOT NULL,
            base_url TEXT,
            model TEXT,
            context_window_tokens INTEGER,
            is_active INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )",
        [],
    )?;

    let has_context_window_tokens = {
        let mut stmt = conn.prepare("PRAGMA table_info(providers)")?;
        let mut rows = stmt.query([])?;
        let mut found = false;
        while let Some(row) = rows.next()? {
            let column_name: String = row.get(1)?;
            if column_name == "context_window_tokens" {
                found = true;
                break;
            }
        }
        found
    };

    if !has_context_window_tokens {
        conn.execute(
            "ALTER TABLE providers ADD COLUMN context_window_tokens INTEGER",
            [],
        )?;
    }

    Ok(conn)
}
