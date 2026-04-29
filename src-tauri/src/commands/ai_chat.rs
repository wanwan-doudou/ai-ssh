use crate::models::{Provider, ProviderType};
use crate::provider_utils::{
    anthropic_messages_url, default_model_for_provider, gemini_generate_content_url,
    openai_chat_completions_url,
};
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::{State, AppHandle, Emitter};
use rusqlite::params;
use futures::StreamExt;

#[derive(Debug, Serialize, Deserialize)]
pub struct AiChatResponse {
    pub content: String,
    pub command: Option<String>,
}

/// 历史消息结构（用于接收前端传来的历史）
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    provider_id: String,
    message: String,
    session_id: String,
    history: Option<Vec<HistoryMessage>>,  // 新增：接收历史消息
) -> Result<AiChatResponse, String> {
    // 保留 session_id 参数以维持前端 invoke 契约；非流式接口当前不按会话区分处理。
    let _ = &session_id;

    // 1. 获取 Provider 信息
    let provider = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, name, provider_type, api_key, base_url, model, is_active, created_at, updated_at FROM providers WHERE id = ?1",
            params![provider_id],
            |row| {
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
            },
        ).map_err(|e| format!("Provider not found: {}", e))?
    };

    // 2. 构造 AI 请求上下文 (System Prompt) - 中文+简洁
    let system_prompt = r#"你是一个智能 SSH 终端助手。帮助用户管理服务器、执行命令、分析输出。

规则：
1. 用中文简洁回复
2. 如果需要执行命令，只给出一个最直接相关的命令
3. 命令格式：在回复末尾单独用 ```bash 包裹，例如：
```bash
docker ps
```
4. 不要同时给多个命令
5. 分析命令输出时，提取关键信息，给出简明总结
6. 请结合对话上下文理解用户意图，保持对话连贯性
7. 如果上下文提示某个命令仍在执行、尚未完成，不要把暂无输出判断为失败或无结果；请明确说明命令还没结束，只能基于当前已有输出判断"#;

    // 3. 构建消息历史
    let history_messages = history.unwrap_or_default();

    // 4. 调用 AI API
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let response_text = match provider.provider_type {
        ProviderType::Openai | ProviderType::Custom => {
            call_openai_compatible(&client, &provider, system_prompt, &message, &history_messages).await?
        }
        ProviderType::Claude => {
            call_claude(&client, &provider, system_prompt, &message, &history_messages).await?
        }
        ProviderType::Gemini => {
            call_gemini(&client, &provider, system_prompt, &message, &history_messages).await?
        }
        ProviderType::Codex => {
            return Err("Codex Provider 暂不支持普通 Chat Completions。请使用 OpenAI Provider，或等后续接入 Responses API。".to_string());
        }
    };

    // 5. 解析响应 (提取 Command)
    let (content, command) = parse_ai_response(&response_text);

    Ok(AiChatResponse {
        content,
        command,
    })
}

/// 流式事件数据结构
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    pub chunk: Option<String>,   // 增量文本块
    pub done: bool,              // 是否完成
    pub error: Option<String>,   // 错误信息
    pub command: Option<String>, // 完成后解析出的命令
}

/// 流式 AI 聊天命令
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
    message: String,
    session_id: String,
    history: Option<Vec<HistoryMessage>>,
) -> Result<(), String> {
    let event_name = format!("ai-stream-{}", session_id);
    
    // 1. 获取 Provider 信息
    let provider = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, name, provider_type, api_key, base_url, model, is_active, created_at, updated_at FROM providers WHERE id = ?1",
            params![provider_id],
            |row| {
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
            },
        ).map_err(|e| format!("Provider not found: {}", e))?
    };

    // 2. 构造 AI 请求上下文 (System Prompt)
    let system_prompt = r#"你是一个智能 SSH 终端助手。帮助用户管理服务器、执行命令、分析输出。

规则：
1. 用中文简洁回复
2. 如果需要执行命令，只给出一个最直接相关的命令
3. 命令格式：在回复末尾单独用 ```bash 包裹，例如：
```bash
docker ps
```
4. 不要同时给多个命令
5. 分析命令输出时，提取关键信息，给出简明总结
6. 请结合对话上下文理解用户意图，保持对话连贯性
7. 如果上下文提示某个命令仍在执行、尚未完成，不要把暂无输出判断为失败或无结果；请明确说明命令还没结束，只能基于当前已有输出判断"#;

    // 3. 构建消息历史
    let history_messages = history.unwrap_or_default();

    // 4. 创建 HTTP 客户端
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // 5. 流式调用 AI API
    let result = match provider.provider_type {
        ProviderType::Openai | ProviderType::Custom => {
            call_openai_compatible_stream(&app, &client, &provider, system_prompt, &message, &history_messages, &event_name).await
        }
        ProviderType::Claude => {
            call_claude_stream(&app, &client, &provider, system_prompt, &message, &history_messages, &event_name).await
        }
        ProviderType::Gemini => {
            call_gemini_stream(&app, &client, &provider, system_prompt, &message, &history_messages, &event_name).await
        }
        ProviderType::Codex => {
            Err("Codex Provider 暂不支持普通 Chat Completions。请使用 OpenAI Provider，或等后续接入 Responses API。".to_string())
        }
    };

    // 6. 处理结果
    if let Err(e) = result {
        let _ = app.emit(&event_name, StreamEvent {
            chunk: None,
            done: true,
            error: Some(e),
            command: None,
        });
    }

    Ok(())
}

// 辅助函数：调用 OpenAI 兼容接口
async fn call_openai_compatible(
    client: &reqwest::Client,
    provider: &Provider,
    system_prompt: &str,
    user_message: &str,
    history: &[HistoryMessage],  // 新增：历史消息
) -> Result<String, String> {
    let url = openai_chat_completions_url(provider.base_url.as_deref());
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());

    // 构建消息数组：system + 历史 + 当前用户消息
    let mut messages = vec![
        serde_json::json!({"role": "system", "content": system_prompt})
    ];
    
    // 添加历史消息（限制最近10轮对话，避免 token 超限）
    let history_limit = history.len().saturating_sub(40);
    for msg in history.iter().skip(history_limit) {
        messages.push(serde_json::json!({
            "role": msg.role,
            "content": msg.content
        }));
    }
    
    // 添加当前用户消息
    messages.push(serde_json::json!({"role": "user", "content": user_message}));

    let body = serde_json::json!({
        "model": model,
        "messages": messages
    });

    let res = client.post(&url)
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("API Error: {}", res.status()));
    }

    let json: serde_json::Value = res.json().await.map_err(|e| format!("Parse error: {}", e))?;
    let content = json["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("Invalid response format")?
        .to_string();

    Ok(content)
}

// 辅助函数：调用 Claude 接口
async fn call_claude(
    client: &reqwest::Client,
    provider: &Provider,
    system_prompt: &str,
    user_message: &str,
    history: &[HistoryMessage],  // 新增：历史消息
) -> Result<String, String> {
    let url = anthropic_messages_url(provider.base_url.as_deref());
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());

    // 构建消息数组：历史 + 当前用户消息
    let mut messages: Vec<serde_json::Value> = Vec::new();
    
    // 添加历史消息（限制最近10轮对话，避免 token 超限）
    let history_limit = history.len().saturating_sub(40);
    for msg in history.iter().skip(history_limit) {
        messages.push(serde_json::json!({
            "role": msg.role,
            "content": msg.content
        }));
    }
    
    // 添加当前用户消息
    messages.push(serde_json::json!({"role": "user", "content": user_message}));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,  // 提高以避免响应截断
        "system": system_prompt,
        "messages": messages
    });

    let res = client.post(&url)
        .header("x-api-key", &provider.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("API Error: {}", res.status()));
    }

    let json: serde_json::Value = res.json().await.map_err(|e| format!("Parse error: {}", e))?;
    let content = json["content"][0]["text"]
        .as_str()
        .ok_or("Invalid response format")?
        .to_string();

    Ok(content)
}

// 流式调用 OpenAI 兼容接口
async fn call_openai_compatible_stream(
    app: &AppHandle,
    client: &reqwest::Client,
    provider: &Provider,
    system_prompt: &str,
    user_message: &str,
    history: &[HistoryMessage],
    event_name: &str,
) -> Result<String, String> {
    let url = openai_chat_completions_url(provider.base_url.as_deref());
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());

    // 构建消息数组
    let mut messages = vec![
        serde_json::json!({"role": "system", "content": system_prompt})
    ];
    
    let history_limit = history.len().saturating_sub(40);
    for msg in history.iter().skip(history_limit) {
        messages.push(serde_json::json!({
            "role": msg.role,
            "content": msg.content
        }));
    }
    messages.push(serde_json::json!({"role": "user", "content": user_message}));

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "stream": true,  // 启用流式
        "max_tokens": 8192  // 允许较长的响应，避免截断
    });

    let res = client.post(&url)
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("API Error {}: {}", status, body));
    }

    // 处理 SSE 流
    let mut full_content = String::new();
    let mut stream = res.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        // 按行处理 SSE 数据
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..];
                if data == "[DONE]" {
                    continue;
                }
                
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) = json["choices"][0]["delta"]["content"].as_str() {
                        full_content.push_str(content);
                        // 发送增量到前端
                        let _ = app.emit(event_name, StreamEvent {
                            chunk: Some(content.to_string()),
                            done: false,
                            error: None,
                            command: None,
                        });
                    }
                }
            }
        }
    }

    // 解析命令并发送完成事件
    let (_, command) = parse_ai_response(&full_content);
    let _ = app.emit(event_name, StreamEvent {
        chunk: None,
        done: true,
        error: None,
        command,
    });

    Ok(full_content)
}

// 流式调用 Claude 接口
async fn call_claude_stream(
    app: &AppHandle,
    client: &reqwest::Client,
    provider: &Provider,
    system_prompt: &str,
    user_message: &str,
    history: &[HistoryMessage],
    event_name: &str,
) -> Result<String, String> {
    let url = anthropic_messages_url(provider.base_url.as_deref());
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());

    // 构建消息数组
    let mut messages: Vec<serde_json::Value> = Vec::new();
    
    let history_limit = history.len().saturating_sub(40);
    for msg in history.iter().skip(history_limit) {
        messages.push(serde_json::json!({
            "role": msg.role,
            "content": msg.content
        }));
    }
    messages.push(serde_json::json!({"role": "user", "content": user_message}));

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,  // 提高以避免响应截断
        "system": system_prompt,
        "messages": messages,
        "stream": true  // 启用流式
    });

    let res = client.post(&url)
        .header("x-api-key", &provider.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("API Error {}: {}", status, body));
    }

    // 处理 SSE 流
    let mut full_content = String::new();
    let mut stream = res.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        // 按行处理 SSE 数据
        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if line.starts_with("data: ") {
                let data = &line[6..];
                
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    // Claude SSE 格式：content_block_delta 事件包含文本
                    if json["type"] == "content_block_delta" {
                        if let Some(text) = json["delta"]["text"].as_str() {
                            full_content.push_str(text);
                            // 发送增量到前端
                            let _ = app.emit(event_name, StreamEvent {
                                chunk: Some(text.to_string()),
                                done: false,
                                error: None,
                                command: None,
                            });
                        }
                    }
                }
            }
        }
    }

    // 解析命令并发送完成事件
    let (_, command) = parse_ai_response(&full_content);
    let _ = app.emit(event_name, StreamEvent {
        chunk: None,
        done: true,
        error: None,
        command,
    });

    Ok(full_content)
}

fn push_gemini_turn(turns: &mut Vec<(String, String)>, role: &str, content: &str) {
    let content = content.trim();
    if content.is_empty() {
        return;
    }

    if let Some((last_role, last_content)) = turns.last_mut() {
        if last_role == role {
            last_content.push_str("\n\n");
            last_content.push_str(content);
            return;
        }
    }

    turns.push((role.to_string(), content.to_string()));
}

fn build_gemini_contents(history: &[HistoryMessage], user_message: &str) -> Vec<serde_json::Value> {
    let mut turns: Vec<(String, String)> = Vec::new();
    let history_limit = history.len().saturating_sub(40);

    for msg in history.iter().skip(history_limit) {
        let role = match msg.role.as_str() {
            "assistant" => "model",
            "user" | "system" => "user",
            _ => "user",
        };
        push_gemini_turn(&mut turns, role, &msg.content);
    }

    push_gemini_turn(&mut turns, "user", user_message);

    turns
        .into_iter()
        .map(|(role, content)| {
            serde_json::json!({
                "role": role,
                "parts": [{ "text": content }]
            })
        })
        .collect()
}

fn build_gemini_body(
    system_prompt: &str,
    user_message: &str,
    history: &[HistoryMessage],
) -> serde_json::Value {
    serde_json::json!({
        "systemInstruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": build_gemini_contents(history, user_message),
        "generationConfig": {
            "maxOutputTokens": 8192
        }
    })
}

fn extract_gemini_text(json: &serde_json::Value) -> Option<String> {
    let parts = json["candidates"][0]["content"]["parts"].as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("");

    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

async fn call_gemini(
    client: &reqwest::Client,
    provider: &Provider,
    system_prompt: &str,
    user_message: &str,
    history: &[HistoryMessage],
) -> Result<String, String> {
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());
    let url = gemini_generate_content_url(provider.base_url.as_deref(), &model, false);
    let body = build_gemini_body(system_prompt, user_message, history);

    let res = client
        .post(&url)
        .header("x-goog-api-key", &provider.api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("API Error {}: {}", status, body));
    }

    let json: serde_json::Value = res.json().await.map_err(|e| format!("Parse error: {}", e))?;
    extract_gemini_text(&json).ok_or_else(|| "Invalid Gemini response format".to_string())
}

async fn call_gemini_stream(
    app: &AppHandle,
    client: &reqwest::Client,
    provider: &Provider,
    system_prompt: &str,
    user_message: &str,
    history: &[HistoryMessage],
    event_name: &str,
) -> Result<String, String> {
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());
    let url = gemini_generate_content_url(provider.base_url.as_deref(), &model, true);
    let body = build_gemini_body(system_prompt, user_message, history);

    let res = client
        .post(&url)
        .header("x-goog-api-key", &provider.api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        return Err(format!("API Error {}: {}", status, body));
    }

    let mut full_content = String::new();
    let mut stream = res.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| format!("Stream error: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        while let Some(line_end) = buffer.find('\n') {
            let line = buffer[..line_end].trim().to_string();
            buffer = buffer[line_end + 1..].to_string();

            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    continue;
                }

                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(content) = extract_gemini_text(&json) {
                        full_content.push_str(&content);
                        let _ = app.emit(event_name, StreamEvent {
                            chunk: Some(content),
                            done: false,
                            error: None,
                            command: None,
                        });
                    }
                }
            }
        }
    }

    let (_, command) = parse_ai_response(&full_content);
    let _ = app.emit(event_name, StreamEvent {
        chunk: None,
        done: true,
        error: None,
        command,
    });

    Ok(full_content)
}

// 辅助函数：解析 AI 响应提取命令
fn parse_ai_response(text: &str) -> (String, Option<String>) {
    // 方法1：尝试寻找 JSON block（```json { "command": "xxx" } ```）
    if let Some(cmd) = extract_json_command(text) {
        let clean_text = remove_json_block(text);
        return (clean_text, Some(cmd));
    }
    
    // 方法2：尝试寻找 bash/shell block 中的单行命令
    if let Some(cmd) = extract_bash_command(text) {
        return (text.to_string(), Some(cmd));
    }
    
    // 方法3：尝试寻找 $ 开头的命令行
    if let Some(cmd) = extract_dollar_command(text) {
        return (text.to_string(), Some(cmd));
    }

    // 未找到命令
    (text.to_string(), None)
}

// 从 JSON block 中提取命令
fn extract_json_command(text: &str) -> Option<String> {
    let patterns = ["```json", "```JSON"];
    
    for pattern in patterns {
        if let Some(start) = text.find(pattern) {
            let after_pattern = &text[start + pattern.len()..];
            if let Some(end) = after_pattern.find("```") {
                let json_str = after_pattern[..end].trim();
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(json_str) {
                    if let Some(cmd) = parsed.get("command").and_then(|c| c.as_str()) {
                        return Some(cmd.to_string());
                    }
                }
            }
        }
    }
    None
}

// 移除 JSON block 返回干净的文本
fn remove_json_block(text: &str) -> String {
    let patterns = ["```json", "```JSON"];
    
    for pattern in patterns {
        if let Some(start) = text.find(pattern) {
            let after_pattern = &text[start + pattern.len()..];
            if let Some(end) = after_pattern.find("```") {
                let before = &text[..start];
                let after = &after_pattern[end + 3..];
                return format!("{}{}", before.trim(), after.trim());
            }
        }
    }
    text.to_string()
}

// 从 bash/shell block 中提取命令
fn extract_bash_command(text: &str) -> Option<String> {
    let patterns = ["```bash", "```shell", "```sh", "```BASH"];
    
    for pattern in patterns {
        if let Some(start) = text.find(pattern) {
            let after_pattern = &text[start + pattern.len()..];
            if let Some(end) = after_pattern.find("```") {
                let code_block = after_pattern[..end].trim();
                // 只提取单行命令
                let lines: Vec<&str> = code_block.lines().collect();
                if lines.len() == 1 {
                    let cmd = lines[0].trim();
                    // 移除可能的 $ 前缀
                    let cmd = cmd.strip_prefix("$ ").unwrap_or(cmd);
                    if !cmd.is_empty() {
                        return Some(cmd.to_string());
                    }
                }
            }
        }
    }
    None
}

// 提取 $ 开头的命令
fn extract_dollar_command(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("$ ") {
            let cmd = trimmed.strip_prefix("$ ").unwrap().trim();
            if !cmd.is_empty() && !cmd.contains('\n') {
                return Some(cmd.to_string());
            }
        }
    }
    None
}

#[tauri::command]
pub async fn execute_command_via_ai(
    state: State<'_, AppState>,
    session_id: String,
    command: String
) -> Result<(), String> {
    // 保留这些参数以维持 Tauri command 签名；当前前端直接调用 write_ssh 执行命令。
    let _ = (&state, &session_id, &command);

    // 这个命令可能由前端 AI Panel 调用，或者用于其他自动化场景
    // 这里我们简单复用 ssh 模块的 write_ssh 逻辑，或者调用 state 中的 shared logic
    // 由于 commands::ssh 逻辑可能没公开，我们这里暂时仅作为占位
    // 实际项目中应该调用 ssh service
    
    // 这种情况下，最佳实践是前端直接调用 write_ssh，AI Panel 已经这样做了。
    // 如果必须保留此接口：
    Err("Use write_ssh instead".to_string())
}
