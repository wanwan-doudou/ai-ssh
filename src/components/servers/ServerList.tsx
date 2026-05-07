import { useState, useEffect } from "react";
import { Plus, Search, Server, MoreVertical, Network, ShieldAlert } from "lucide-react";
import type { DeviceProfile, Server as ServerType } from "@/types";
import { ServerForm } from "./ServerForm";
import { useServerStore } from "@/stores/serverStore";
import { useTerminalStore } from "@/stores/terminalStore";

interface ServerListProps {
  onNavigate: (view: "servers" | "providers" | "terminal") => void;
}

const DEVICE_PROFILE_LABELS: Record<DeviceProfile, string> = {
  auto: "自动识别",
  huawei: "华为",
  h3c: "H3C",
  cisco: "Cisco",
  ruijie: "锐捷",
  fortigate: "FortiGate",
};

export function ServerList({ onNavigate }: ServerListProps) {
  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<ServerType | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  
  const { servers, fetchServers } = useServerStore();
  const { addSession } = useTerminalStore();
  
  // 组件挂载时从后端加载服务器列表
  useEffect(() => {
    fetchServers();
  }, [fetchServers]);
  
  // 过滤服务器
  const filteredServers = servers.filter((server) =>
    server.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    server.host.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleEdit = (server: ServerType) => {
    setEditingServer(server);
    setShowForm(true);
  };

  const handleAdd = () => {
    setEditingServer(null);
    setShowForm(true);
  };

  const handleCloseForm = () => {
    setShowForm(false);
    setEditingServer(null);
  };

  const handleConnect = (server: ServerType) => {
    const sessionId = `session_${Date.now()}`;
    addSession({
      id: sessionId,
      serverId: server.id,
      serverName: server.name,
      isConnected: false,
      createdAt: Date.now(),
      buffer: '',
    });
    onNavigate("terminal");
  };

  return (
    <div className="h-full flex flex-col">
      {/* 头部 */}
      <header className="h-16 px-6 flex items-center justify-between border-b border-surface-200 dark:border-surface-800 transition-colors duration-300">
        <h2 className="text-xl font-semibold text-surface-900 dark:text-white">服务器管理</h2>
        <button onClick={handleAdd} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          添加服务器
        </button>
      </header>

      {/* 搜索栏 */}
      <div className="px-6 py-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-400 dark:text-surface-500" />
          <input
            type="text"
            placeholder="搜索服务器..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="input pl-10"
          />
        </div>
      </div>

      {/* 服务器列表 */}
      <div className="flex-1 overflow-auto px-6 pb-6">
        {filteredServers.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-surface-500">
            <Server className="w-16 h-16 mb-4 opacity-50" />
            <p className="text-lg">暂无服务器配置</p>
            <p className="text-sm mt-1">点击上方按钮添加第一个服务器</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredServers.map((server) => (
              <ServerCard 
                key={server.id} 
                server={server} 
                onEdit={() => handleEdit(server)} 
                onConnect={() => handleConnect(server)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 编辑/添加表单模态框 */}
      {showForm && (
        <ServerForm 
          server={editingServer} 
          onClose={handleCloseForm} 
        />
      )}
    </div>
  );
}

interface ServerCardProps {
  server: ServerType;
  onEdit: () => void;
  onConnect: () => void;
}

function ServerCard({ server, onEdit, onConnect }: ServerCardProps) {
  const { deleteServer } = useServerStore();
  const [showMenu, setShowMenu] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  
  const handleDelete = async () => {
    setIsDeleting(true);
    await deleteServer(server.id);
    setShowMenu(false);
    setIsDeleting(false);
  };

  return (
    <div className="glass-card glow-border p-4 group hover:bg-white/80 dark:hover:bg-surface-700/40 transition-all duration-300">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary-500/20 flex items-center justify-center">
            {server.deviceType === "network" ? (
              <Network className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            ) : (
              <Server className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            )}
          </div>
          <div>
            <h3 className="font-medium text-surface-900 dark:text-white transition-colors">{server.name}</h3>
            <p className="text-sm text-surface-500 dark:text-surface-400">{server.host}:{server.port}</p>
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
                onClick={handleDelete}
                disabled={isDeleting}
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-100 dark:hover:bg-surface-700 text-red-500 dark:text-red-400 disabled:opacity-50 transition-colors"
              >
                {isDeleting ? '删除中...' : '删除'}
              </button>
            </div>
          )}
        </div>
      </div>
      
      <div className="mt-4 flex items-center justify-between">
        <div className="min-w-0 text-xs text-surface-500">
          <span>
            {server.username}@{server.authType === "password" ? "密码" : "密钥"} · {server.deviceType === "network" ? DEVICE_PROFILE_LABELS[server.deviceProfile] : "Linux"}
          </span>
          {server.legacyAlgorithms && (
            <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-950/40 dark:text-amber-300">
              <ShieldAlert className="h-3 w-3" />
              兼容
            </span>
          )}
        </div>
        <button 
          onClick={onConnect}
          className="btn-primary text-xs py-1 px-3"
        >
          连接
        </button>
      </div>
    </div>
  );
}
