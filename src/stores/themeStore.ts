import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface ThemeState {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
  setTheme: (theme: 'light' | 'dark') => void;
}

export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      theme: 'light', // 默认使用淡色主题
      toggleTheme: () => set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' })),
      setTheme: (theme) => set({ theme }),
    }),
    {
      name: 'theme-storage',
      // 版本号升级，强制迁移到淡色主题作为默认值
      version: 2,
      migrate: (persistedState: unknown, version: number) => {
        // 版本 1 或更早版本迁移到默认淡色主题
        if (version < 2) {
          return { theme: 'light' as const };
        }
        return persistedState as ThemeState;
      },
    }
  )
);
