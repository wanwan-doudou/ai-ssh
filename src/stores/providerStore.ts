import { create } from 'zustand';
import type { Provider } from '@/types';
import { invoke } from '@tauri-apps/api/core';

interface ProviderStore {
  providers: Provider[];
  activeProviderId: string | null;
  isLoading: boolean;
  // 从后端加载所有 Providers
  fetchProviders: () => Promise<void>;
  // 添加 Provider (同步到后端)
  addProvider: (provider: Omit<Provider, 'id' | 'createdAt' | 'updatedAt' | 'isActive'>) => Promise<void>;
  // 更新 Provider (同步到后端)
  updateProvider: (id: string, provider: Partial<Provider>) => Promise<void>;
  // 删除 Provider (同步到后端)
  deleteProvider: (id: string) => Promise<void>;
  // 设置激活的 Provider (同步到后端)
  setActiveProvider: (id: string) => Promise<void>;
  // 获取单个 Provider
  getProvider: (id: string) => Provider | undefined;
  // 获取当前激活的 Provider
  getActiveProvider: () => Provider | undefined;
}

export const useProviderStore = create<ProviderStore>()((set, get) => ({
  providers: [],
  activeProviderId: null,
  isLoading: false,

  fetchProviders: async () => {
    set({ isLoading: true });
    try {
      // 调用后端获取所有 Providers
      const providers = await invoke<Provider[]>('get_providers');
      // 找到激活的 Provider
      const activeProvider = providers.find(p => p.isActive);
      set({
        providers,
        activeProviderId: activeProvider?.id || null,
        isLoading: false,
      });
    } catch (err) {
      console.error('加载 Providers 失败:', err);
      set({ isLoading: false });
    }
  },

  addProvider: async (providerData) => {
    try {
      // 调用后端添加 Provider
      const newProvider = await invoke<Provider>('add_provider', {
        name: providerData.name,
        providerType: providerData.type,
        apiKey: providerData.apiKey,
        baseUrl: providerData.baseUrl || null,
        model: providerData.model || null,
        contextWindowTokens: providerData.contextWindowTokens ?? null,
      });

      set((state) => {
        const isFirst = state.providers.length === 0;
        return {
          providers: [...state.providers, newProvider],
          activeProviderId: isFirst || newProvider.isActive ? newProvider.id : state.activeProviderId,
        };
      });
    } catch (err) {
      console.error('添加 Provider 失败:', err);
      throw err;
    }
  },

  updateProvider: async (id, providerData) => {
    try {
      // 获取当前 Provider 数据以便合并
      const currentProvider = get().providers.find(p => p.id === id);
      if (!currentProvider) {
        throw new Error('Provider not found');
      }

      // 调用后端更新 Provider
      await invoke('update_provider', {
        id,
        name: providerData.name ?? currentProvider.name,
        providerType: providerData.type ?? currentProvider.type,
        apiKey: providerData.apiKey ?? currentProvider.apiKey,
        baseUrl: providerData.baseUrl ?? currentProvider.baseUrl ?? null,
        model: providerData.model ?? currentProvider.model ?? null,
        contextWindowTokens: providerData.contextWindowTokens !== undefined
          ? providerData.contextWindowTokens
          : currentProvider.contextWindowTokens ?? null,
      });

      set((state) => ({
        providers: state.providers.map((provider) =>
          provider.id === id
            ? { ...provider, ...providerData, updatedAt: Date.now() }
            : provider
        ),
      }));
    } catch (err) {
      console.error('更新 Provider 失败:', err);
      throw err;
    }
  },

  deleteProvider: async (id) => {
    try {
      // 调用后端删除 Provider
      await invoke('delete_provider', { id });

      set((state) => {
        const newProviders = state.providers.filter((provider) => provider.id !== id);
        // 如果删除的是当前激活的 provider，重新选择第一个
        const newActiveId = state.activeProviderId === id
          ? (newProviders[0]?.id || null)
          : state.activeProviderId;

        return {
          providers: newProviders,
          activeProviderId: newActiveId,
        };
      });
    } catch (err) {
      console.error('删除 Provider 失败:', err);
      throw err;
    }
  },

  setActiveProvider: async (id) => {
    try {
      // 调用后端设置激活的 Provider
      await invoke('set_active_provider', { id });

      set((state) => ({
        providers: state.providers.map((provider) => ({
          ...provider,
          isActive: provider.id === id,
        })),
        activeProviderId: id,
      }));
    } catch (err) {
      console.error('设置激活 Provider 失败:', err);
      throw err;
    }
  },

  getProvider: (id) => {
    return get().providers.find((provider) => provider.id === id);
  },

  getActiveProvider: () => {
    const { providers, activeProviderId } = get();
    return providers.find((provider) => provider.id === activeProviderId);
  },
}));
