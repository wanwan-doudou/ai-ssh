//! Provider 管理命令

use crate::models::{Provider, ProviderType};
use crate::provider_utils::{
    anthropic_messages_url, gemini_models_url, openai_compatible_url, openai_models_url,
    DEFAULT_CLAUDE_MODEL, DEFAULT_DEEPSEEK_BASE_URL,
};
use crate::AppState;
use rusqlite::params;
use tauri::State;

/// 获取所有 Providers
#[tauri::command]
pub fn get_providers(state: State<AppState>) -> Result<Vec<Provider>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let mut stmt = conn
        .prepare("SELECT id, name, provider_type, api_key, base_url, model, is_active, created_at, updated_at FROM providers ORDER BY created_at DESC")
        .map_err(|e| e.to_string())?;
    
    let providers = stmt
        .query_map([], |row| {
            Ok(Provider {
                id: row.get(0)?,
                name: row.get(1)?,
                provider_type: row.get::<_, String>(2)?.parse().unwrap_or(ProviderType::Custom),
                api_key: row.get(3)?,
                base_url: row.get(4)?,
                model: row.get(5)?,
                is_active: row.get::<_, i64>(6)? != 0,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    
    Ok(providers)
}

/// 添加 Provider
#[tauri::command]
pub fn add_provider(
    state: State<AppState>,
    name: String,
    provider_type: String,
    api_key: String,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<Provider, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let provider_type_enum: ProviderType = provider_type.parse().map_err(|e: String| e)?;
    
    // 检查是否是第一个 provider，如果是则默认激活
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM providers", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let is_active = count == 0;
    
    conn.execute(
        "INSERT INTO providers (id, name, provider_type, api_key, base_url, model, is_active, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, name, provider_type_enum.to_string(), api_key, base_url, model, is_active as i64, now, now],
    ).map_err(|e| e.to_string())?;
    
    Ok(Provider {
        id,
        name,
        provider_type: provider_type_enum,
        api_key,
        base_url,
        model,
        is_active,
        created_at: now,
        updated_at: now,
    })
}

/// 更新 Provider
#[tauri::command]
pub fn update_provider(
    state: State<AppState>,
    id: String,
    name: String,
    provider_type: String,
    api_key: String,
    base_url: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let provider_type_enum: ProviderType = provider_type.parse().map_err(|e: String| e)?;
    
    conn.execute(
        "UPDATE providers SET name = ?1, provider_type = ?2, api_key = ?3, base_url = ?4, model = ?5, updated_at = ?6 WHERE id = ?7",
        params![name, provider_type_enum.to_string(), api_key, base_url, model, now, id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

/// 删除 Provider
#[tauri::command]
pub fn delete_provider(state: State<AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    conn.execute("DELETE FROM providers WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    
    Ok(())
}

/// 设置激活的 Provider
#[tauri::command]
pub fn set_active_provider(state: State<AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    
    // 先将所有 provider 设为非激活
    conn.execute("UPDATE providers SET is_active = 0", [])
        .map_err(|e| e.to_string())?;
    
    // 再将指定的 provider 设为激活
    conn.execute("UPDATE providers SET is_active = 1 WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    
    Ok(())
}

/// API 测试结果
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestConnectionResult {
    pub success: bool,
    pub message: String,
    pub latency_ms: Option<u64>,
}

/// 测试 AI Provider 连接
/// 通过发送简单请求验证 API Key 是否有效
#[tauri::command]
pub async fn test_provider_connection(
    provider_type: String,
    api_key: String,
    base_url: Option<String>,
) -> Result<TestConnectionResult, String> {
    use std::time::Instant;
    
    let start = Instant::now();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    
    // 根据 provider 类型选择测试端点
    let result = match provider_type.to_lowercase().as_str() {
        "claude" => test_claude(&client, &api_key, base_url).await,
        "openai" => test_openai(&client, &api_key, base_url).await,
        "gemini" => test_gemini(&client, &api_key, base_url).await,
        "deepseek" => test_deepseek(&client, &api_key, base_url).await,
        "custom" => {
            if let Some(url) = base_url {
                test_custom(&client, &api_key, &url).await
            } else {
                Err("自定义类型需要提供 Base URL".to_string())
            }
        }
        _ => Err(format!("不支持的 Provider 类型: {}", provider_type)),
    };
    
    let latency = start.elapsed().as_millis() as u64;
    
    match result {
        Ok(msg) => Ok(TestConnectionResult {
            success: true,
            message: msg,
            latency_ms: Some(latency),
        }),
        Err(e) => Ok(TestConnectionResult {
            success: false,
            message: e,
            latency_ms: Some(latency),
        }),
    }
}

/// 测试 Claude 原生 Messages API
async fn test_claude(
    client: &reqwest::Client,
    api_key: &str,
    base_url: Option<String>,
) -> Result<String, String> {
    let endpoint = anthropic_messages_url(base_url.as_deref());
    
    // 发送最小化的测试请求
    let response = client
        .post(&endpoint)
        .header("x-api-key", api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&serde_json::json!({
            "model": DEFAULT_CLAUDE_MODEL,
            "max_tokens": 1,
            "messages": [{"role": "user", "content": "Hi"}]
        }))
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    
    let status = response.status();
    if status.is_success() {
        Ok("Claude API 连接成功".to_string())
    } else if status.as_u16() == 401 {
        Err("API Key 无效或已过期".to_string())
    } else if status.as_u16() == 403 {
        Err("API Key 权限不足".to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!("请求失败 ({}): {}", status, body))
    }
}

/// 测试 OpenAI API
async fn test_openai(
    client: &reqwest::Client,
    api_key: &str,
    base_url: Option<String>,
) -> Result<String, String> {
    // 使用 models 端点测试，不消耗 tokens
    let endpoint = openai_models_url(base_url.as_deref());
    
    let response = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    
    let status = response.status();
    if status.is_success() {
        Ok("OpenAI API 连接成功".to_string())
    } else if status.as_u16() == 401 {
        Err("API Key 无效或已过期".to_string())
    } else if status.as_u16() == 403 {
        Err("API Key 权限不足".to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!("请求失败 ({}): {}", status, body))
    }
}

/// 测试 Gemini API
async fn test_gemini(
    client: &reqwest::Client,
    api_key: &str,
    base_url: Option<String>,
) -> Result<String, String> {
    // 使用 models 列表端点测试
    let endpoint = gemini_models_url(base_url.as_deref());
    
    let response = client
        .get(&endpoint)
        .header("x-goog-api-key", api_key)
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    
    let status = response.status();
    if status.is_success() {
        Ok("Gemini API 连接成功".to_string())
    } else if status.as_u16() == 400 || status.as_u16() == 403 {
        Err("API Key 无效或权限不足".to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!("请求失败 ({}): {}", status, body))
    }
}

/// 测试 DeepSeek API（OpenAI 兼容格式）
async fn test_deepseek(
    client: &reqwest::Client,
    api_key: &str,
    base_url: Option<String>,
) -> Result<String, String> {
    // 使用 models 端点测试，不消耗 tokens
    let endpoint = openai_compatible_url(
        base_url.as_deref(),
        DEFAULT_DEEPSEEK_BASE_URL,
        "models",
    );

    let response = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;

    let status = response.status();
    if status.is_success() {
        Ok("DeepSeek API 连接成功".to_string())
    } else if status.as_u16() == 401 {
        Err("API Key 无效或已过期".to_string())
    } else if status.as_u16() == 403 {
        Err("API Key 权限不足".to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!("请求失败 ({}): {}", status, body))
    }
}

/// 测试自定义 API (兼容 OpenAI 格式)
async fn test_custom(
    client: &reqwest::Client,
    api_key: &str,
    base_url: &str,
) -> Result<String, String> {
    // 尝试 OpenAI 兼容的 models 端点
    let endpoint = openai_compatible_url(Some(base_url), base_url, "models");
    
    let response = client
        .get(&endpoint)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("网络请求失败: {}", e))?;
    
    let status = response.status();
    if status.is_success() {
        Ok("自定义 API 连接成功".to_string())
    } else if status.as_u16() == 401 {
        Err("API Key 无效".to_string())
    } else {
        let body = response.text().await.unwrap_or_default();
        Err(format!("请求失败 ({}): {}", status, body))
    }
}
