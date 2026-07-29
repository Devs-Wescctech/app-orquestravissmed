import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
    sidebarCollapsed: boolean;
    setSidebarCollapsed: (v: boolean) => void;
    toggleSidebar: () => void;
}

export const useUIStore = create<UIState>()(
    persist(
        (set) => ({
            sidebarCollapsed: false,
            setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),
            toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
        }),
        {
            name: 'vismed-ui-preferences',
        }
    )
);
