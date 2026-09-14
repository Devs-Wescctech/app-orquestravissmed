'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ConflictDetails } from '@/lib/booking-conflict-details';

export function useBookingConflicts(clinicId: string | undefined, records: Array<{ id?: string; syncError?: string | null }>) {
    const [result, setResult] = useState<{ clinicId?: string; records: typeof records; data: Record<string, ConflictDetails> }>({ records: [], data: {} });
    useEffect(() => {
        const controller = new AbortController();
        setResult({ clinicId, records, data: {} });
        if (!clinicId) return () => controller.abort();
        const pending = records.filter(r => r.id && /BREAK_CONFLICT|BREAK_OWNERSHIP_PENDING/.test(r.syncError || ''));
        void (async () => {
            for (const record of pending) {
                if (controller.signal.aborted) return;
                let detail: ConflictDetails;
                try {
                    const response = await api.get(`/booking-sync/records/${encodeURIComponent(record.id!)}/conflict-details`, {
                        params: { clinicId }, signal: controller.signal,
                    });
                    detail = response.data;
                } catch {
                    detail = { checkedAt: new Date().toISOString(), availability: 'unavailable', overlaps: [], sameNameBookings: [],
                        reason: 'Não foi possível consultar os detalhes. Use Atualizar para tentar novamente.' };
                }
                if (!controller.signal.aborted) setResult(previous => ({ ...previous, data: { ...previous.data, [record.id!]: detail } }));
            }
        })();
        return () => controller.abort();
    }, [clinicId, records]);
    return result.clinicId === clinicId && result.records === records ? result.data : {};
}
