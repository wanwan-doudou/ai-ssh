use crate::models::{Provider, ProviderType};
use crate::provider_utils::{
    anthropic_messages_url, default_base_url_for_provider, default_model_for_provider,
    gemini_generate_content_url, openai_compatible_url,
};
use crate::AppState;
use futures::StreamExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

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

const AI_SYSTEM_PROMPT: &str = r#"你是一个智能 SSH 终端助手。帮助用户管理服务器、执行命令、分析输出。

回复规则：
1. 用中文简洁回复。
2. 需要让前端执行命令时，回复末尾必须单独给一个 JSON 代码块，格式严格如下：
```json
{"command":"docker ps"}
```
3. 一次最多给一个 command。不要把多个命令写在同一个 command 里，也不要用 &&、; 串联多个独立排查步骤。
4. 如果任务需要多步排查，先选择最直接、最安全、只读的一条命令；等用户或前端返回结果后再决定下一步。
5. 不要把示例命令、备选命令、命令清单放进 ```bash / ```shell / ```sh 代码块，避免被前端误认为可执行命令。说明性命令请用普通文本或行内代码。
6. 如果只是解释、总结、分析已有输出，通常不要给 command。
7. 分析命令输出时，提取关键信息，给出简明总结；如果确实还需要下一步，只给一个最相关的 command。
8. 如果上下文提示某个命令仍在执行、尚未完成，不要把暂无输出判断为失败或无结果；请明确说明命令还没结束，只能基于当前已有输出判断。"#;

const DEFAULT_CONTEXT_WINDOW_TOKENS: usize = 256_000;
const MIN_HISTORY_TOKEN_BUDGET: usize = 16_000;
const MAX_HISTORY_TOKEN_BUDGET: usize = 640_000;
const RESPONSE_TOKEN_RESERVE: usize = 12_000;
const CURRENT_TURN_TOKEN_RESERVE: usize = 8_000;
const HISTORY_MESSAGE_HARD_LIMIT: usize = 240;
const MESSAGE_OVERHEAD_TOKENS: usize = 8;

fn limited_history(history: &[HistoryMessage], token_budget: usize) -> Vec<&HistoryMessage> {
    let mut selected: Vec<&HistoryMessage> = Vec::new();
    let first_user_message = history.iter().position(|msg| msg.role == "user");
    let recent_start = history.len().saturating_sub(HISTORY_MESSAGE_HARD_LIMIT);
    let mut used_tokens = 0usize;

    if let Some(index) = first_user_message {
        if index < recent_start {
            let message = &history[index];
            let message_tokens = estimate_message_tokens(message);
            if message_tokens <= token_budget {
                selected.push(message);
                used_tokens += message_tokens;
            }
        }
    }

    let mut recent: Vec<&HistoryMessage> = Vec::new();
    for message in history.iter().skip(recent_start).rev() {
        let message_tokens = estimate_message_tokens(message);
        if used_tokens + message_tokens > token_budget {
            continue;
        }

        recent.push(message);
        used_tokens += message_tokens;
    }

    recent.reverse();
    selected.extend(recent);
    selected
}

fn estimate_message_tokens(message: &HistoryMessage) -> usize {
    estimate_text_tokens(&message.role)
        + estimate_text_tokens(&message.content)
        + MESSAGE_OVERHEAD_TOKENS
}

fn estimate_text_tokens(text: &str) -> usize {
    let non_ascii = text.chars().filter(|ch| !ch.is_ascii()).count();
    let ascii = text.chars().filter(|ch| ch.is_ascii()).count();

    // 终端输出大多是 ASCII，中文对话更接近 1 字 1 token。分开估算比固定 chars/3 更稳。
    (non_ascii + ascii / 4).max(1)
}

fn history_token_budget_for_provider(provider: &Provider) -> usize {
    let context_window = context_window_for_provider(provider);
    let available = context_window
        .saturating_sub(RESPONSE_TOKEN_RESERVE)
        .saturating_sub(CURRENT_TURN_TOKEN_RESERVE);

    available
        .saturating_mul(70)
        .saturating_div(100)
        .clamp(MIN_HISTORY_TOKEN_BUDGET, MAX_HISTORY_TOKEN_BUDGET)
}

fn context_window_for_provider(provider: &Provider) -> usize {
    if let Some(tokens) = provider.context_window_tokens {
        if tokens > 0 {
            return tokens as usize;
        }
    }

    DEFAULT_CONTEXT_WINDOW_TOKENS
}

#[tauri::command]
pub async fn ai_chat(
    state: State<'_, AppState>,
    provider_id: String,
    message: String,
    session_id: String,
    history: Option<Vec<HistoryMessage>>, // 新增：接收历史消息
) -> Result<AiChatResponse, String> {
    // 保留 session_id 参数以维持前端 invoke 契约；非流式接口当前不按会话区分处理。
    let _ = &session_id;

    // 1. 获取 Provider 信息
    let provider = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, name, provider_type, api_key, base_url, model, context_window_tokens, is_active, created_at, updated_at FROM providers WHERE id = ?1",
            params![provider_id],
            |row| {
                Ok(Provider {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider_type: row.get::<_, String>(2)?.parse().unwrap_or(ProviderType::Custom),
                    api_key: row.get(3)?,
                    base_url: row.get(4)?,
                    model: row.get(5)?,
                    context_window_tokens: row.get(6)?,
                    is_active: row.get::<_, i64>(7)? != 0,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        ).map_err(|e| format!("Provider not found: {}", e))?
    };

    // 3. 构建消息历史
    let history_messages = history.unwrap_or_default();

    // 4. 调用 AI API
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())?;

    let response_text = match provider.provider_type {
        ProviderType::Openai | ProviderType::Custom | ProviderType::Deepseek => {
            call_openai_compatible(
                &client,
                &provider,
                AI_SYSTEM_PROMPT,
                &message,
                &history_messages,
            )
            .await?
        }
        ProviderType::Claude => {
            call_claude(
                &client,
                &provider,
                AI_SYSTEM_PROMPT,
                &message,
                &history_messages,
            )
            .await?
        }
        ProviderType::Gemini => {
            call_gemini(
                &client,
                &provider,
                AI_SYSTEM_PROMPT,
                &message,
                &history_messages,
            )
            .await?
        }
    };

    // 5. 清洗 think 模型的推理标签残片后再解析响应 (提取 Command)
    let cleaned_response_text = strip_think_blocks(&response_text);
    let (content, command) = parse_ai_response(&cleaned_response_text);

    Ok(AiChatResponse { content, command })
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
            "SELECT id, name, provider_type, api_key, base_url, model, context_window_tokens, is_active, created_at, updated_at FROM providers WHERE id = ?1",
            params![provider_id],
            |row| {
                Ok(Provider {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider_type: row.get::<_, String>(2)?.parse().unwrap_or(ProviderType::Custom),
                    api_key: row.get(3)?,
                    base_url: row.get(4)?,
                    model: row.get(5)?,
                    context_window_tokens: row.get(6)?,
                    is_active: row.get::<_, i64>(7)? != 0,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        ).map_err(|e| format!("Provider not found: {}", e))?
    };

    // 3. 构建消息历史
    let history_messages = history.unwrap_or_default();

    // 4. 创建 HTTP 客户端
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // 5. 流式调用 AI API
    let result = match provider.provider_type {
        ProviderType::Openai | ProviderType::Custom | ProviderType::Deepseek => {
            call_openai_compatible_stream(
                &app,
                &client,
                &provider,
                AI_SYSTEM_PROMPT,
                &message,
                &history_messages,
                &event_name,
            )
            .await
        }
        ProviderType::Claude => {
            call_claude_stream(
                &app,
                &client,
                &provider,
                AI_SYSTEM_PROMPT,
                &message,
                &history_messages,
                &event_name,
            )
            .await
        }
        ProviderType::Gemini => {
            call_gemini_stream(
                &app,
                &client,
                &provider,
                AI_SYSTEM_PROMPT,
                &message,
                &history_messages,
                &event_name,
            )
            .await
        }
    };

    // 6. 处理结果
    if let Err(e) = result {
        let _ = app.emit(
            &event_name,
            StreamEvent {
                chunk: None,
                done: true,
                error: Some(e),
                command: None,
            },
        );
    }

    Ok(())
}

// 辅助函数：调用 OpenAI 兼容接口
async fn call_openai_compatible(
    client: &reqwest::Client,
    provider: &Provider,
    system_prompt: &str,
    user_message: &str,
    history: &[HistoryMessage], // 新增：历史消息
) -> Result<String, String> {
    let url = openai_compatible_url(
        provider.base_url.as_deref(),
        default_base_url_for_provider(&provider.provider_type),
        "chat/completions",
    );
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());

    // 构建消息数组：system + 历史 + 当前用户消息
    let mut messages = vec![serde_json::json!({"role": "system", "content": system_prompt})];

    // 添加历史消息：保留首条用户诉求，并限制最近消息窗口，避免 token 超限。
    for msg in limited_history(history, history_token_budget_for_provider(provider)) {
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

    let res = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", provider.api_key))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !res.status().is_success() {
        return Err(format!("API Error: {}", res.status()));
    }

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;
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
    history: &[HistoryMessage], // 新增：历史消息
) -> Result<String, String> {
    let url = anthropic_messages_url(provider.base_url.as_deref());
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());

    // 构建消息数组：历史 + 当前用户消息
    let mut messages: Vec<serde_json::Value> = Vec::new();

    // 添加历史消息：保留首条用户诉求，并限制最近消息窗口，避免 token 超限。
    for msg in limited_history(history, history_token_budget_for_provider(provider)) {
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

    let res = client
        .post(&url)
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

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;
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
    let url = openai_compatible_url(
        provider.base_url.as_deref(),
        default_base_url_for_provider(&provider.provider_type),
        "chat/completions",
    );
    let model = provider
        .model
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_model_for_provider(&provider.provider_type).to_string());

    // 构建消息数组
    let mut messages = vec![serde_json::json!({"role": "system", "content": system_prompt})];

    for msg in limited_history(history, history_token_budget_for_provider(provider)) {
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

    let res = client
        .post(&url)
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
    let mut raw_content = String::new();
    let mut emitted_content = String::new();
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
                        raw_content.push_str(content);
                        let cleaned_content = strip_think_blocks(&raw_content);
                        if cleaned_content.len() > emitted_content.len() {
                            let chunk = cleaned_content[emitted_content.len()..].to_string();
                            emitted_content = cleaned_content;
                            // 发送清洗后的增量到前端，过滤 think 标签残片。
                            let _ = app.emit(
                                event_name,
                                StreamEvent {
                                    chunk: Some(chunk),
                                    done: false,
                                    error: None,
                                    command: None,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    // 解析命令并发送完成事件
    let full_content = strip_think_blocks(&raw_content);
    let (_, command) = parse_ai_response(&full_content);
    let _ = app.emit(
        event_name,
        StreamEvent {
            chunk: None,
            done: true,
            error: None,
            command,
        },
    );

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

    for msg in limited_history(history, history_token_budget_for_provider(provider)) {
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

    let res = client
        .post(&url)
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
    let mut raw_content = String::new();
    let mut emitted_content = String::new();
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
                            raw_content.push_str(text);
                            let cleaned_content = strip_think_blocks(&raw_content);
                            if cleaned_content.len() > emitted_content.len() {
                                let chunk = cleaned_content[emitted_content.len()..].to_string();
                                emitted_content = cleaned_content;
                                // 发送清洗后的增量到前端，过滤 think 标签残片。
                                let _ = app.emit(
                                    event_name,
                                    StreamEvent {
                                        chunk: Some(chunk),
                                        done: false,
                                        error: None,
                                        command: None,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // 解析命令并发送完成事件
    let full_content = strip_think_blocks(&raw_content);
    let (_, command) = parse_ai_response(&full_content);
    let _ = app.emit(
        event_name,
        StreamEvent {
            chunk: None,
            done: true,
            error: None,
            command,
        },
    );

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

fn build_gemini_contents(
    history: &[HistoryMessage],
    user_message: &str,
    history_token_budget: usize,
) -> Vec<serde_json::Value> {
    let mut turns: Vec<(String, String)> = Vec::new();
    for msg in limited_history(history, history_token_budget) {
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
    history_token_budget: usize,
) -> serde_json::Value {
    serde_json::json!({
        "systemInstruction": {
            "parts": [{ "text": system_prompt }]
        },
        "contents": build_gemini_contents(history, user_message, history_token_budget),
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
    let body = build_gemini_body(
        system_prompt,
        user_message,
        history,
        history_token_budget_for_provider(provider),
    );

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

    let json: serde_json::Value = res
        .json()
        .await
        .map_err(|e| format!("Parse error: {}", e))?;
    extract_gemini_text(&json)
        .map(|text| strip_think_blocks(&text))
        .ok_or_else(|| "Invalid Gemini response format".to_string())
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
    let body = build_gemini_body(
        system_prompt,
        user_message,
        history,
        history_token_budget_for_provider(provider),
    );

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

    let mut raw_content = String::new();
    let mut emitted_content = String::new();
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
                        raw_content.push_str(&content);
                        let cleaned_content = strip_think_blocks(&raw_content);
                        if cleaned_content.len() > emitted_content.len() {
                            let chunk = cleaned_content[emitted_content.len()..].to_string();
                            emitted_content = cleaned_content;
                            let _ = app.emit(
                                event_name,
                                StreamEvent {
                                    chunk: Some(chunk),
                                    done: false,
                                    error: None,
                                    command: None,
                                },
                            );
                        }
                    }
                }
            }
        }
    }

    let full_content = strip_think_blocks(&raw_content);
    let (_, command) = parse_ai_response(&full_content);
    let _ = app.emit(
        event_name,
        StreamEvent {
            chunk: None,
            done: true,
            error: None,
            command,
        },
    );

    Ok(full_content)
}

fn find_ascii_case_insensitive(haystack: &str, needle: &str, start: usize) -> Option<usize> {
    let haystack_bytes = haystack.as_bytes();
    let needle_bytes = needle.as_bytes();

    if needle_bytes.is_empty() || start >= haystack_bytes.len() {
        return None;
    }

    haystack_bytes[start..]
        .windows(needle_bytes.len())
        .position(|window| {
            window
                .iter()
                .zip(needle_bytes.iter())
                .all(|(left, right)| left.eq_ignore_ascii_case(right))
        })
        .map(|index| start + index)
}

fn trim_incomplete_think_tag_suffix(value: &str) -> &str {
    let tag_prefixes = ["<think", "</think>"];
    let max_suffix_len = tag_prefixes
        .iter()
        .map(|prefix| prefix.len().saturating_sub(1))
        .max()
        .unwrap_or(0)
        .min(value.len());

    for suffix_len in (1..=max_suffix_len).rev() {
        let suffix_start = value.len() - suffix_len;
        if !value.is_char_boundary(suffix_start) {
            continue;
        }

        let suffix = &value[suffix_start..];
        if tag_prefixes.iter().any(|prefix| {
            suffix_len <= prefix.len() && prefix[..suffix_len].eq_ignore_ascii_case(suffix)
        }) {
            return &value[..suffix_start];
        }
    }

    value
}

fn find_next_think_marker(text: &str, cursor: usize) -> Option<(usize, bool)> {
    let opening = find_ascii_case_insensitive(text, "<think", cursor).map(|index| (index, true));
    let closing = find_ascii_case_insensitive(text, "</think>", cursor).map(|index| (index, false));

    match (opening, closing) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(marker), None) | (None, Some(marker)) => Some(marker),
        (None, None) => None,
    }
}

fn strip_think_blocks(text: &str) -> String {
    let mut output = String::new();
    let mut cursor = 0usize;

    while let Some((marker_start, is_opening)) = find_next_think_marker(text, cursor) {
        output.push_str(&text[cursor..marker_start]);

        if is_opening {
            let Some(opening_end_offset) = text[marker_start..].find('>') else {
                return trim_incomplete_think_tag_suffix(&output).to_string();
            };
            let content_start = marker_start + opening_end_offset + 1;

            if let Some(closing_start) =
                find_ascii_case_insensitive(text, "</think>", content_start)
            {
                cursor = closing_start + "</think>".len();
            } else {
                return trim_incomplete_think_tag_suffix(&output).to_string();
            }
        } else {
            cursor = marker_start + "</think>".len();
        }
    }

    output.push_str(&text[cursor..]);
    trim_incomplete_think_tag_suffix(&output).to_string()
}

// 辅助函数：解析 AI 响应提取命令
fn parse_ai_response(text: &str) -> (String, Option<String>) {
    // 方法1：尝试寻找 JSON block（```json { "command": "xxx" } ```）
    if let Some(cmd) = extract_json_command(text) {
        let clean_text = remove_json_block(text);
        return (clean_text, Some(cmd));
    }

    // 方法2：兼容部分 OpenAI 兼容模型直接返回裸 JSON 对象。
    if let Some(cmd) = extract_bare_json_command(text) {
        return ("".to_string(), Some(cmd));
    }

    // 方法3：尝试寻找 bash/shell block 中的单行命令
    if let Some(cmd) = extract_bash_command(text) {
        return (text.to_string(), Some(cmd));
    }

    // 方法4：尝试寻找 $ 开头的命令行
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

// 从裸 JSON 响应中提取命令：{"command":"docker ps"}
fn extract_bare_json_command(text: &str) -> Option<String> {
    let trimmed = text.trim();
    if !trimmed.starts_with('{') || !trimmed.ends_with('}') {
        return None;
    }

    let parsed = serde_json::from_str::<serde_json::Value>(trimmed).ok()?;
    let command = parsed.get("command").and_then(|value| value.as_str())?;
    let command = command.trim();

    if command.is_empty() {
        None
    } else {
        Some(command.to_string())
    }
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
    command: String,
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
