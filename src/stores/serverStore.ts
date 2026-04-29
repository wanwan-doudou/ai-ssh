import { create } from 'zustand';
import type { Server } from '@/types';
import { invoke } from '@tauri-apps/api/core';

interface ServerStore {
  servers: Server[];
  isLoading: boolean;
  error: string | null;
  // 从后端加载服务器列表
  fetchServers: () => Promise<void>;
  // 添加服务器（调用后端 API）
  addServer: (server: Omit<Server, 'id' | 'createdAt' | 'updatedAt'>) => Promise<Server | null>;
  // 更新服务器（调用后端 API）
  updateServer: (id: string, server: Partial<Server>) => Promise<boolean>;
  // 删除服务器（调用后端 API）
  deleteServer: (id: string) => Promise<boolean>;
  // 获取单个服务器
  getServer: (id: string) => Server | undefined;
}

export const useServerStore = create<ServerStore>()((set, get) => ({
  servers: [],
  isLoading: false,
  error: null,
  
  fetchServers: async () => {
    set({ isLoading: true, error: null });
    try {
      // 调用后端 API 获取服务器列表
      const servers = await invoke<Server[]>('get_servers');
      // 转换后端数据格式为前端格式
      const formattedServers = servers.map((s: any) => {
        const rawAuthType = s.authType ?? s.auth_type ?? 'password';
        const rawDeviceType = s.deviceType ?? s.device_type ?? 'linux';
        const rawPrivateKeyPath = s.privateKeyPath ?? s.private_key_path ?? undefined;
        return {
          ...s,
          authType: rawAuthType === 'privateKey' || rawAuthType === 'private_key'
            ? 'privateKey' as const
            : 'password' as const,
          deviceType: rawDeviceType === 'network' || rawDeviceType === 'network_device' || rawDeviceType === 'networkDevice'
            ? 'network' as const
            : 'linux' as const,
          privateKeyPath: rawPrivateKeyPath,
        };
      });
      set({ servers: formattedServers, isLoading: false });
    } catch (err) {
      console.error('获取服务器列表失败:', err);
      set({ error: String(err), isLoading: false });
    }
  },
  
  addServer: async (serverData) => {
    try {
      // 调用后端 API 添加服务器
      const newServer = await invoke<Server>('add_server', {
        name: serverData.name,
        host: serverData.host,
        port: serverData.port,
        username: serverData.username,
        authType: serverData.authType === 'privateKey' ? 'privateKey' : 'password',
        deviceType: serverData.deviceType,
        password: serverData.password || null,
        privateKeyPath: serverData.privateKeyPath || null,
        group: serverData.group || null,
      });
      // 刷新列表
      await get().fetchServers();
      return newServer;
    } catch (err) {
      console.error('添加服务器失败:', err);
      set({ error: String(err) });
      return null;
    }
  },
  
  updateServer: async (id, serverData) => {
    try {
      const existingServer = get().servers.find(s => s.id === id);
      if (!existingServer) return false;
      
      // 合并现有数据和更新数据
      const merged = { ...existingServer, ...serverData };
      
      // 调用后端 API 更新服务器
      await invoke('update_server', {
        id,
        name: merged.name,
        host: merged.host,
        port: merged.port,
        username: merged.username,
        authType: merged.authType === 'privateKey' ? 'privateKey' : 'password',
        deviceType: merged.deviceType,
        password: merged.password || null,
        privateKeyPath: merged.privateKeyPath || null,
        group: merged.group || null,
      });
      // 刷新列表
      await get().fetchServers();
      return true;
    } catch (err) {
      console.error('更新服务器失败:', err);
      set({ error: String(err) });
      return false;
    }
  },
  
  deleteServer: async (id) => {
    try {
      // 调用后端 API 删除服务器
      await invoke('delete_server', { id });
      // 刷新列表
      await get().fetchServers();
      return true;
    } catch (err) {
      console.error('删除服务器失败:', err);
      set({ error: String(err) });
      return false;
    }
  },
  
  getServer: (id) => {
    return get().servers.find((server) => server.id === id);
  },
}));
