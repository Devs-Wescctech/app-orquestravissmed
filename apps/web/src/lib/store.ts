import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface User {
    id: string;
    email: string;
    name: string;
    active?: boolean;
    roles?: { role: string; clinicId?: string }[];
}

interface AuthState {
    user: User | null;
    isAuthenticated: boolean;
    _hasHydrated: boolean;
    setHasHydrated: (v: boolean) => void;
    login: (user: User) => void;
    logout: () => void;
}

export const useAuthStore = create<AuthState>()(
    persist(
        (set) => ({
            user: null,
            isAuthenticated: false,
            _hasHydrated: false,
            setHasHydrated: (v) => set({ _hasHydrated: v }),
            login: (userData) => set({ user: userData, isAuthenticated: true }),
            logout: () => set({ user: null, isAuthenticated: false }),
        }),
        {
            name: 'vismed-auth-storage',
            onRehydrateStorage: () => (state) => {
                state?.setHasHydrated(true);
            },
            partialize: (state) => ({
                user: state.user,
                isAuthenticated: state.isAuthenticated,
            }),
        }
    )
);
