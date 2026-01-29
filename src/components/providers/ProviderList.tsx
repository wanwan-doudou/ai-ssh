import { useState, useEffect } from "react";
import { Plus, Search, Bot, MoreVertical, Check, Sparkles, Zap, Loader2, CheckCircle, XCircle } from "lucide-react";
import type { Provider } from "@/types";
import { ProviderForm } from "./ProviderForm";
import { useProviderStore } from "@/stores/providerStore";
import { invoke } from "@tauri-apps/api/core";

// 测试连接结果类型
interface TestConnectionResult {
  success: boolean;
  message: string;
  latencyMs: number | null;
}

// Provider 类型图标映射
const providerIcons: Record<string, { color: string; bg: string }> = {
  claude: { color: "text-orange-400", bg: "bg-orange-500/20" },
  openai: { color: "text-green-400", bg: "bg-green-500/20" },
  codex: { color: "text-blue-400", bg: "bg-blue-500/20" },
  gemini: { color: "text-purple-400", bg: "bg-purple-500/20" },
  custom: { color: "text-surface-400", bg: "bg-surface-500/20" },
};

export function ProviderList() {
  const [showForm, setShowForm] = useState(false);
  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  
  const { providers, setActiveProvider, fetchProviders, isLoading } = useProviderStore();

  // 组件挂载时从后端加载 Providers
  useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);
  
  // 过滤 providers
  const filteredProviders = providers.filter((provider) =>
    provider.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    provider.type.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleEdit = (provider: Provider) => {
    setEditingProvider(provider);
    setShowForm(true);
  };

  const handleAdd = () => {
    setEditingProvider(null);
    setShowForm(true);
  };

  const handleCloseForm = () => {
    setShowForm(false);
    setEditingProvider(null);
  };

  return (
    <div className="h-full flex flex-col">
      {/* 头部 */}
      {/* 头部 */}
      <header className="h-16 px-6 flex items-center justify-between border-b border-surface-200 dark:border-surface-800 transition-colors duration-300">
        <h2 className="text-xl font-semibold text-surface-900 dark:text-white">AI 配置</h2>
        <button onClick={handleAdd} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          添加 Provider
        </button>
      </header>

      {/* 搜索栏 */}
      <div className="px-6 py-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
          <input
            type="text"
            placeholder="搜索 AI Provider..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input pl-10"
          />
        </div>
      </div>

      {/* Provider 列表 */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {isLoading ? (
          <div className="h-full flex flex-col items-center justify-center text-surface-500">
            <Loader2 className="w-10 h-10 animate-spin mb-4 opacity-50" />
            <p className="text-sm">加载中...</p>
          </div>
        ) : filteredProviders.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-surface-500">
            <Bot className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg">暂无 AI 配置</p>
            <p className="text-sm mt-1">点击上方按钮添加 Claude、OpenAI 等 API 配置</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredProviders.map((provider) => (
              <ProviderCard 
                key={provider.id} 
                provider={provider} 
                onEdit={() => handleEdit(provider)}
                onSetActive={() => setActiveProvider(provider.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* ... (omit form logic as it's just rendering) ... */}
      {/* 编辑/添加表单模态框 */}
      {showForm && (
        <ProviderForm 
          provider={editingProvider} 
          onClose={handleCloseForm} 
        />
      )}
    </div>
  );
}

interface ProviderCardProps {
  provider: Provider;
  onEdit: () => void;
  onSetActive: () => void;
}

function ProviderCard({ provider, onEdit, onSetActive }: ProviderCardProps) {
  const { deleteProvider } = useProviderStore();
  const [showMenu, setShowMenu] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const iconStyle = providerIcons[provider.type] || providerIcons.custom;

  // 测试连接
  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await invoke<TestConnectionResult>("test_provider_connection", {
        providerType: provider.type,
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl || null,
      });
      setTestResult(result);
    } catch (e) {
      setTestResult({
        success: false,
        message: String(e),
        latencyMs: null,
      });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={`glass-card p-4 group transition-all duration-300 ${
      provider.isActive 
        ? "border-2 border-primary-500/50 shadow-[0_0_15px_rgba(20,184,166,0.15)]" 
        : "hover:bg-white/80 dark:hover:bg-surface-700/40 hover:border-surface-300 dark:hover:border-surface-600"
    }`}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 flex-1 min-w-0">
          <div className={`w-10 h-10 rounded-lg ${iconStyle.bg} flex items-center justify-center`}>
            {provider.type === "claude" && <Sparkles className={`w-5 h-5 ${iconStyle.color}`} />}
            {provider.type !== "claude" && <Bot className={`w-5 h-5 ${iconStyle.color}`} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-medium text-surface-900 dark:text-white transition-colors truncate" title={provider.name}>
                {provider.name}
              </h3>
              {provider.isActive && (
                <span className="flex-shrink-0 whitespace-nowrap px-1.5 py-0.5 text-xs bg-primary-500/20 text-primary-600 dark:text-primary-400 rounded">
                  当前使用
                </span>
              )}
            </div>
            <p className="text-sm text-surface-500 dark:text-surface-400 capitalize truncate">{provider.type}</p>
          </div>
        </div>
        
        <div className="relative">
          <button 
            onClick={() => setShowMenu(!showMenu)}
            className="p-1 rounded hover:bg-surface-100 dark:hover:bg-surface-600 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <MoreVertical className="w-4 h-4 text-surface-500 dark:text-surface-400" />
          </button>
          
          {showMenu && (
            <div className="absolute right-0 mt-1 w-32 bg-white dark:bg-surface-800 border border-surface-200 dark:border-surface-700 rounded-lg shadow-xl z-50">
              <button 
                onClick={() => { onEdit(); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-700 text-surface-600 dark:text-surface-300 transition-colors"
              >
                编辑
              </button>
              <button 
                onClick={() => { deleteProvider(provider.id); setShowMenu(false); }}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500 dark:text-red-400 transition-colors"
              >
                删除
              </button>
            </div>
          )}
        </div>
      </div>
      
      {/* 测试结果显示 */}
      {testResult && (
        <div className={`mt-3 p-2 rounded-lg text-xs flex items-center gap-2 ${
          testResult.success 
            ? "bg-green-500/10 text-green-400" 
            : "bg-red-500/10 text-red-400"
        }`}>
          {testResult.success ? (
            <CheckCircle className="w-4 h-4 flex-shrink-0" />
          ) : (
            <XCircle className="w-4 h-4 flex-shrink-0" />
          )}
          <span className="flex-1 truncate">{testResult.message}</span>
          {testResult.latencyMs && (
            <span className="text-surface-500">{testResult.latencyMs}ms</span>
          )}
        </div>
      )}
      
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-surface-500 truncate flex-1" title={provider.model || "默认模型"}>
          {provider.model || "默认模型"}
        </span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* 测试连接按钮 */}
          <button 
            onClick={handleTestConnection}
            disabled={testing}
            className="btn-secondary text-xs py-1 px-3 flex items-center gap-1"
          >
            {testing ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Zap className="w-3 h-3" />
            )}
            {testing ? "测试中" : "测试"}
          </button>
          {!provider.isActive && (
            <button 
              onClick={onSetActive}
              className="btn-secondary text-xs py-1 px-3 flex items-center gap-1"
            >
              <Check className="w-3 h-3" />
              激活
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
