use crate::models::ProviderType;

pub const DEFAULT_OPENAI_BASE_URL: &str = "https://api.openai.com";
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
pub const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com";
pub const DEFAULT_DEEPSEEK_BASE_URL: &str = "https://api.deepseek.com";

pub const DEFAULT_OPENAI_MODEL: &str = "gpt-4.1-mini";
pub const DEFAULT_CLAUDE_MODEL: &str = "claude-3-5-haiku-latest";
pub const DEFAULT_GEMINI_MODEL: &str = "gemini-2.5-flash";
pub const DEFAULT_DEEPSEEK_MODEL: &str = "deepseek-chat";
pub const DEFAULT_CUSTOM_MODEL: &str = "gpt-4o-mini";

/// 根据 Provider 类型返回默认的 Base URL（用于 OpenAI 兼容类 Provider）
pub fn default_base_url_for_provider(provider_type: &ProviderType) -> &'static str {
    match provider_type {
        ProviderType::Claude => DEFAULT_ANTHROPIC_BASE_URL,
        ProviderType::Openai => DEFAULT_OPENAI_BASE_URL,
        ProviderType::Gemini => DEFAULT_GEMINI_BASE_URL,
        ProviderType::Deepseek => DEFAULT_DEEPSEEK_BASE_URL,
        ProviderType::Custom => DEFAULT_OPENAI_BASE_URL,
    }
}

pub fn default_model_for_provider(provider_type: &ProviderType) -> &'static str {
    match provider_type {
        ProviderType::Claude => DEFAULT_CLAUDE_MODEL,
        ProviderType::Openai => DEFAULT_OPENAI_MODEL,
        ProviderType::Gemini => DEFAULT_GEMINI_MODEL,
        ProviderType::Deepseek => DEFAULT_DEEPSEEK_MODEL,
        ProviderType::Custom => DEFAULT_CUSTOM_MODEL,
    }
}

fn normalized_base_url(base_url: Option<&str>, default_base_url: &str) -> String {
    base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_base_url)
        .trim_end_matches('/')
        .to_string()
}

pub fn anthropic_messages_url(base_url: Option<&str>) -> String {
    let base = normalized_base_url(base_url, DEFAULT_ANTHROPIC_BASE_URL);

    if base.ends_with("/v1/messages") {
        base
    } else if base.ends_with("/v1") {
        format!("{}/messages", base)
    } else {
        format!("{}/v1/messages", base)
    }
}

pub fn openai_compatible_url(
    base_url: Option<&str>,
    default_base_url: &str,
    endpoint: &str,
) -> String {
    let base = normalized_base_url(base_url, default_base_url);
    let endpoint = endpoint.trim_start_matches('/');

    if base.ends_with(endpoint) {
        return base;
    }

    if base.ends_with("/v1") || base.ends_with("/openai") {
        format!("{}/{}", base, endpoint)
    } else {
        format!("{}/v1/{}", base, endpoint)
    }
}

pub fn openai_models_url(base_url: Option<&str>) -> String {
    openai_compatible_url(base_url, DEFAULT_OPENAI_BASE_URL, "models")
}

pub fn normalize_gemini_model(model: &str) -> String {
    model
        .trim()
        .trim_start_matches("models/")
        .trim_start_matches('/')
        .to_string()
}

fn normalized_gemini_base_url(base_url: Option<&str>) -> String {
    let mut base = normalized_base_url(base_url, DEFAULT_GEMINI_BASE_URL);

    if base.ends_with("/openai") {
        base.truncate(base.len() - "/openai".len());
    }

    base
}

pub fn gemini_models_url(base_url: Option<&str>) -> String {
    let base = normalized_gemini_base_url(base_url);

    if base.ends_with("/models") {
        base
    } else if base.ends_with("/v1beta") || base.ends_with("/v1") {
        format!("{}/models", base)
    } else {
        format!("{}/v1beta/models", base)
    }
}

pub fn gemini_generate_content_url(base_url: Option<&str>, model: &str, stream: bool) -> String {
    let base = normalized_gemini_base_url(base_url);
    let model = normalize_gemini_model(model);
    let method = if stream {
        "streamGenerateContent?alt=sse"
    } else {
        "generateContent"
    };

    if base.ends_with("/v1beta") || base.ends_with("/v1") {
        format!("{}/models/{}:{}", base, model, method)
    } else {
        format!("{}/v1beta/models/{}:{}", base, model, method)
    }
}
