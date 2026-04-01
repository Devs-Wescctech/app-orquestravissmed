'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { Topbar } from '@/components/layout/Topbar';
import { useAuthStore } from '@/lib/store';
import { useClinicStore } from '@/lib/clinic-store';
import { Loader2 } from 'lucide-react';

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const router = useRouter();
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    const hasHydrated = useAuthStore((s) => s._hasHydrated);
    const activeClinic = useClinicStore((s) => s.activeClinic);

    useEffect(() => {
        if (!hasHydrated) return;

        if (!isAuthenticated) {
            router.push('/login');
            return;
        }
        if (!activeClinic) {
            router.push('/select-clinic');
        }
    }, [hasHydrated, isAuthenticated, activeClinic, router]);

    if (!hasHydrated) {
        return (
            <div className="flex h-screen w-full bg-[#F8FAFC] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!isAuthenticated || !activeClinic) {
        return (
            <div className="flex h-screen w-full bg-[#F8FAFC] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="flex h-screen w-full bg-[#F8FAFC]">
            <Sidebar />
            <div className="flex flex-col flex-1 h-full overflow-hidden">
                <Topbar />
                <main className="flex-1 overflow-y-auto p-8">
                    {children}
                </main>
            </div>
        </div>
    );
}
