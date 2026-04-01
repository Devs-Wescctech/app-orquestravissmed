import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'VisMed - Integrated Management',
  description: 'VisMed Multi-clinic management and integration system',
}

import { Toaster } from 'sonner'

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="antialiased h-full">
      <body className={`${inter.className} h-full overflow-hidden bg-background`}>
        {children}
        <Toaster position="top-right" richColors />
      </body>
    </html>
  )
}
