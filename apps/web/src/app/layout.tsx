import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { ClientProviders } from '@/components/client-providers'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'VisMed - Integrated Management',
  description: 'VisMed Multi-clinic management and integration system',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="antialiased h-full">
      <body className={`${inter.className} h-full overflow-hidden bg-background`}>
        <ClientProviders>
          {children}
        </ClientProviders>
      </body>
    </html>
  )
}
