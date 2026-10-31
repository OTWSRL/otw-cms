'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

/** Re-renders the screen every few seconds while something runs on the server, such as an update. */
export function AutoRefresh({ everyMs = 2000 }: { everyMs?: number }) {
  const router = useRouter()
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), everyMs)
    return () => clearInterval(timer)
  }, [router, everyMs])
  return null
}
