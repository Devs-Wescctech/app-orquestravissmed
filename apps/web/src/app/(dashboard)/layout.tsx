'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/Sidebar';
import { Topbar } from '@/components/layout/Topbar';
import { useAuthStore } from '@/lib/store';
import { useClinicStore } from '@/lib/clinic-store';
import { Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import Cookies from 'js-cookie';

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode
}) {
    const router = useRouter();
    const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
    const activeClinic = useClinicStore((s) => s.activeClinic);
    const [mounted, setMounted] = useState(false);
    const [isSessionSynced, setIsSessionSynced] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    useEffect(() => {
        if (!mounted) return;

        // Sync token from cookies to the Supabase client if needed
        const syncSupabase = async () => {
            const token = Cookies.get('vismed_auth_token');
            const { data: { session } } = await supabase.auth.getSession();
            
            if (token && (!session || session.access_token !== token)) {
                console.log('Syncing Supabase session with cookie token...');
                await supabase.auth.setSession({
                    access_token: token,
                    refresh_token: '',
                });
            }
            setIsSessionSynced(true);
        };
        syncSupabase();

        if (!isAuthenticated) {
            router.push('/login');
            return;
        }
        if (!activeClinic) {
            router.push('/select-clinic');
        }
    }, [mounted, isAuthenticated, activeClinic, router]);

    // Avoid hydration mismatch
    if (!mounted) {
        return (
            <div className="flex h-screen w-full bg-[#F8FAFC] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        );
    }

    if (!isAuthenticated || !activeClinic || !isSessionSynced) {
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
