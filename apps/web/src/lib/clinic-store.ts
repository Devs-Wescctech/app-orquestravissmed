import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface ClinicInfo {
    id: string;
    name: string;
    cnpj?: string | null;
    active: boolean;
}

interface ClinicState {
    activeClinic: ClinicInfo | null;
    clinics: ClinicInfo[];
    setActiveClinic: (clinic: ClinicInfo) => void;
    setClinics: (clinics: ClinicInfo[]) => void;
    clearClinic: () => void;
}

export const useClinicStore = create<ClinicState>()(
    persist(
        (set) => ({
            activeClinic: null,
            clinics: [],
            setActiveClinic: (clinic) => set({ activeClinic: clinic }),
            setClinics: (clinics) => set({ clinics }),
            clearClinic: () => set({ activeClinic: null, clinics: [] }),
        }),
        {
            name: 'vismed-clinic-storage',
        }
    )
);

/** Convenience hook */
export function useClinic() {
    const activeClinic = useClinicStore((s) => s.activeClinic);
    const clinics = useClinicStore((s) => s.clinics);
    const setActiveClinic = useClinicStore((s) => s.setActiveClinic);
    const setClinics = useClinicStore((s) => s.setClinics);
    const clearClinic = useClinicStore((s) => s.clearClinic);
    return { activeClinic, clinics, setActiveClinic, setClinics, clearClinic };
}
