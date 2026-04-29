import { useState, useEffect } from "react";
import { X, Bot, Eye, EyeOff } from "lucide-react";
import type { Provider, ProviderType } from "@/types";
import { useProviderStore } from "@/stores/providerStore";

interface ProviderFormProps {
  provider: Provider | null;
  onClose: () => void;
}

type SelectableProviderType = Exclude<ProviderType, "codex">;

const providerTypes: { value: SelectableProviderType; label: string; description: string }[] = [
  { value: "claude", label: "Claude", description: "Anthropic Messages API" },
  { value: "openai", label: "OpenAI", description: "OpenAI Chat Completions" },
  { value: "gemini", label: "Gemini", description: "Google Gemini 原生 API" },
  { value: "custom", label: "自定义", description: "OpenAI 兼容格式 API" },
];

const providerDefaults: Record<SelectableProviderType, { baseUrl: string; model: string; baseUrlHelp: string }> = {
  claude: {
    baseUrl: "https://api.anthropic.com",
    model: "claude-3-5-haiku-latest",
    baseUrlHelp: "Claude 原生 Messages API。可填根地址或 /v1，系统会自动拼到 /v1/messages。",
  },
  openai: {
    baseUrl: "https://api.openai.com",
    model: "gpt-4.1-mini",
    baseUrlHelp: "OpenAI Chat Completions。可填根地址或 /v1，系统会自动拼到 /v1/chat/completions。",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-2.5-flash",
    baseUrlHelp: "Gemini 原生 API。可填根地址或 /v1beta，系统会调用 /models/{model}:generateContent。",
  },
  custom: {
    baseUrl: "https://api.example.com/v1",
    model: "gpt-4o-mini",
    baseUrlHelp: "OpenAI 兼容接口。可填根地址、/v1，或 Gemini 的 /v1beta/openai 路径。",
  },
};

const getProviderDescription = (type: ProviderType) => {
  if (type === "codex") {
    return "Codex 不是普通 Chat Completions Provider；请改用 OpenAI 或自定义接口。";
  }

  return providerTypes.find((item) => item.value === type)?.description || "";
};

const getProviderDefaults = (type: ProviderType) => {
  if (type === "codex") return providerDefaults.openai;
  return providerDefaults[type];
};

export function ProviderForm({ provider, onClose }: ProviderFormProps) {
  const { addProvider, updateProvider } = useProviderStore();
  const isEditing = !!provider;

  const [formData, setFormData] = useState({
    name: "",
    type: "claude" as ProviderType,
    apiKey: "",
    baseUrl: "",
    model: "",
  });

  const [showApiKey, setShowApiKey] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (provider) {
      setFormData({
        name: provider.name,
        type: provider.type,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl || "",
        model: provider.model || "",
      });
    }
  }, [provider]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    
    if (!formData.name.trim()) {
      newErrors.name = "请输入配置名称";
    }
    if (!formData.apiKey.trim()) {
      newErrors.apiKey = "请输入 API Key";
    }
    if (formData.type === "codex") {
      newErrors.type = "Codex 暂不作为独立 Provider 支持，请选择 OpenAI 或自定义";
    }
    if (formData.type === "custom" && !formData.baseUrl.trim()) {
      newErrors.baseUrl = "自定义类型需要填写 Base URL";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validate() || isSubmitting) return;

    const providerData: Omit<Provider, "id" | "createdAt" | "updatedAt" | "isActive"> = {
      name: formData.name.trim(),
      type: formData.type,
      apiKey: formData.apiKey.trim(),
      baseUrl: formData.baseUrl.trim() || undefined,
      model: formData.model.trim() || undefined,
    };

    setIsSubmitting(true);
    try {
      if (isEditing && provider) {
        await updateProvider(provider.id, providerData);
      } else {
        await addProvider(providerData);
      }
      onClose();
    } catch (err) {
      console.error('保存 Provider 失败:', err);
      setErrors({ submit: `保存失败: ${err}` });
    } finally {
      setIsSubmitting(false);
    }
  };

  const currentDefaults = getProviderDefaults(formData.type);
  const typeDescription = getProviderDescription(formData.type);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="glass-card w-full max-w-md mx-4 p-6 animate-in fade-in zoom-in-95 duration-200 bg-white dark:bg-surface-800 border-surface-200 dark:border-surface-700">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary-500/20 flex items-center justify-center">
              <Bot className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            </div>
            <h3 className="text-lg font-semibold text-surface-900 dark:text-white">
              {isEditing ? "编辑 Provider" : "添加 Provider"}
            </h3>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-surface-100 dark:hover:bg-surface-700 rounded-lg transition-colors">
            <X className="w-5 h-5 text-surface-500 dark:text-surface-400" />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* 名称 */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              配置名称
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="例如：Claude Pro"
              className="input"
            />
            {errors.name && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.name}</p>}
          </div>

          {/* 类型选择 */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              Provider 类型
            </label>
            <div className="grid grid-cols-2 gap-2">
              {providerTypes.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setFormData({ ...formData, type: type.value })}
                  className={`p-2 rounded-lg border text-center transition-all ${
                    formData.type === type.value
                      ? "border-primary-500 bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400"
                      : "border-surface-200 dark:border-surface-600 text-surface-500 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-500"
                  }`}
                >
                  <span className="text-sm font-medium">{type.label}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-surface-500 mt-2">
              {typeDescription}
            </p>
            {errors.type && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.type}</p>}
          </div>

          {/* API Key */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              API Key
            </label>
            <div className="relative">
              <input
                type={showApiKey ? "text" : "password"}
                value={formData.apiKey}
                onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
                placeholder="输入 API Key"
                className="input pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-surface-400 hover:text-surface-600 dark:hover:text-surface-300"
              >
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {errors.apiKey && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.apiKey}</p>}
          </div>

          {/* Base URL */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              Base URL <span className="text-surface-500">{formData.type === "custom" ? "(必填)" : "(可选，使用默认)"}</span>
            </label>
            <input
              type="text"
              value={formData.baseUrl}
              onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
              placeholder={currentDefaults.baseUrl}
              className="input"
            />
            <p className="text-xs text-surface-500 mt-1">{currentDefaults.baseUrlHelp}</p>
            {errors.baseUrl && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.baseUrl}</p>}
          </div>

          {/* Model */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              模型 <span className="text-surface-500">(可选)</span>
            </label>
            <input
              type="text"
              value={formData.model}
              onChange={(e) => setFormData({ ...formData, model: e.target.value })}
              placeholder={`留空默认：${currentDefaults.model}`}
              className="input"
            />
            <p className="text-xs text-surface-500 mt-1">建议明确填写你账号可用的模型 ID；留空时使用上面的默认值。</p>
          </div>

          {/* 错误提示 */}
          {errors.submit && (
            <p className="text-red-500 dark:text-red-400 text-sm text-center">{errors.submit}</p>
          )}

          {/* 按钮 */}
          <div className="flex gap-3 pt-2">
            <button 
              type="button" 
              onClick={onClose} 
              disabled={isSubmitting}
              className="btn-secondary flex-1"
            >
              取消
            </button>
            <button 
              type="submit" 
              disabled={isSubmitting}
              className="btn-primary flex-1 flex items-center justify-center gap-2"
            >
              {isSubmitting && <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              {isEditing ? "保存" : "添加"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
