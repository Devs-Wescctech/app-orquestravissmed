'use client';

import { Toaster } from 'sonner';

export function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Toaster position="top-right" richColors />
    </>
  );
}
