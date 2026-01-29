import { useState, useEffect } from "react";
import { X, Server, Key, Lock } from "lucide-react";
import type { Server as ServerType } from "@/types";
import { useServerStore } from "@/stores/serverStore";

interface ServerFormProps {
  server: ServerType | null;
  onClose: () => void;
}

export function ServerForm({ server, onClose }: ServerFormProps) {
  const { addServer, updateServer } = useServerStore();
  const isEditing = !!server;

  const [formData, setFormData] = useState({
    name: "",
    host: "",
    port: 22,
    username: "root",
    authType: "password" as "password" | "privateKey",
    password: "",
    privateKeyPath: "",
    group: "",
  });

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (server) {
      setFormData({
        name: server.name,
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType,
        password: server.password || "",
        privateKeyPath: server.privateKeyPath || "",
        group: server.group || "",
      });
    }
  }, [server]);

  const validate = () => {
    const newErrors: Record<string, string> = {};
    
    if (!formData.name.trim()) {
      newErrors.name = "请输入服务器名称";
    }
    if (!formData.host.trim()) {
      newErrors.host = "请输入主机地址";
    }
    if (formData.port < 1 || formData.port > 65535) {
      newErrors.port = "端口范围应为 1-65535";
    }
    if (!formData.username.trim()) {
      newErrors.username = "请输入用户名";
    }
    if (formData.authType === "password" && !formData.password.trim()) {
      newErrors.password = "请输入密码";
    }
    if (formData.authType === "privateKey" && !formData.privateKeyPath.trim()) {
      newErrors.privateKeyPath = "请输入私钥路径";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!validate()) return;

    setIsSubmitting(true);
    
    const serverData: Omit<ServerType, "id" | "createdAt" | "updatedAt"> = {
      name: formData.name,
      host: formData.host,
      port: formData.port,
      username: formData.username,
      authType: formData.authType,
      password: formData.authType === "password" ? formData.password : undefined,
      privateKeyPath: formData.authType === "privateKey" ? formData.privateKeyPath : undefined,
      group: formData.group || undefined,
    };

    try {
      if (isEditing && server) {
        await updateServer(server.id, serverData);
      } else {
        await addServer(serverData);
      }
      onClose();
    } catch (err) {
      console.error('保存服务器失败:', err);
      setErrors({ submit: String(err) });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="glass-card w-full max-w-md mx-4 p-6 animate-in fade-in zoom-in-95 duration-200 bg-white dark:bg-surface-800 border-surface-200 dark:border-surface-700">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary-500/20 flex items-center justify-center">
              <Server className="w-5 h-5 text-primary-600 dark:text-primary-400" />
            </div>
            <h3 className="text-lg font-semibold text-surface-900 dark:text-white">
              {isEditing ? "编辑服务器" : "添加服务器"}
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
              服务器名称
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="例如：生产服务器"
              className="input"
            />
            {errors.name && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.name}</p>}
          </div>

          {/* 主机和端口 */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                主机地址
              </label>
              <input
                type="text"
                value={formData.host}
                onChange={(e) => setFormData({ ...formData, host: e.target.value })}
                placeholder="IP 或域名"
                className="input"
              />
              {errors.host && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.host}</p>}
            </div>
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                端口
              </label>
              <input
                type="number"
                value={formData.port}
                onChange={(e) => setFormData({ ...formData, port: parseInt(e.target.value) || 22 })}
                className="input"
              />
              {errors.port && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.port}</p>}
            </div>
          </div>

          {/* 用户名 */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              用户名
            </label>
            <input
              type="text"
              value={formData.username}
              onChange={(e) => setFormData({ ...formData, username: e.target.value })}
              placeholder="root"
              className="input"
            />
            {errors.username && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.username}</p>}
          </div>

          {/* 认证方式 */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
              认证方式
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setFormData({ ...formData, authType: "password" })}
                className={`p-3 rounded-lg border transition-all flex items-center gap-2 ${
                  formData.authType === "password"
                    ? "border-primary-500 bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400"
                    : "border-surface-200 dark:border-surface-600 text-surface-500 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-500"
                }`}
              >
                <Lock className="w-4 h-4" />
                密码
              </button>
              <button
                type="button"
                onClick={() => setFormData({ ...formData, authType: "privateKey" })}
                className={`p-3 rounded-lg border transition-all flex items-center gap-2 ${
                  formData.authType === "privateKey"
                    ? "border-primary-500 bg-primary-50 text-primary-600 dark:bg-primary-500/10 dark:text-primary-400"
                    : "border-surface-200 dark:border-surface-600 text-surface-500 dark:text-surface-400 hover:border-surface-300 dark:hover:border-surface-500"
                }`}
              >
                <Key className="w-4 h-4" />
                密钥
              </button>
            </div>
          </div>

          {/* 密码/私钥路径 */}
          {formData.authType === "password" ? (
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                密码
              </label>
              <input
                type="password"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                placeholder="输入密码"
                className="input"
              />
              {errors.password && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.password}</p>}
            </div>
          ) : (
            <div>
              <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
                私钥路径
              </label>
              <input
                type="text"
                value={formData.privateKeyPath}
                onChange={(e) => setFormData({ ...formData, privateKeyPath: e.target.value })}
                placeholder="例如：~/.ssh/id_rsa"
                className="input"
              />
              {errors.privateKeyPath && <p className="text-red-500 dark:text-red-400 text-xs mt-1">{errors.privateKeyPath}</p>}
            </div>
          )}

          {/* 分组 */}
          <div>
            <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-1.5">
              分组 <span className="text-surface-500">(可选)</span>
            </label>
            <input
              type="text"
              value={formData.group}
              onChange={(e) => setFormData({ ...formData, group: e.target.value })}
              placeholder="例如：生产环境"
              className="input"
            />
          </div>

          {/* 按钮 */}
          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1" disabled={isSubmitting}>
              取消
            </button>
            <button type="submit" className="btn-primary flex-1" disabled={isSubmitting}>
              {isSubmitting ? "保存中..." : (isEditing ? "保存" : "添加")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
