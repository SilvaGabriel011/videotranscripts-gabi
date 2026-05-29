import './globals.css'
import type { ReactNode } from 'react'

export const metadata = {
  title: 'YouTube Transcript',
  description: 'Extrai transcripts e legendas (.txt + .srt) de vídeos do YouTube',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
