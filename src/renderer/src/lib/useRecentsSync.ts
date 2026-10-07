import { useEffect } from 'react'
import { useAppStore } from '../store'
import { MAX_RECENTS, sanitizeRecents } from './recents'
import { ipcErrorMessage } from './format'

// Recents change every time a tab opens; batch the writes.
const PERSIST_DELAY_MS = 1000

/** Loads saved recent connections once, then persists changes to settings. */
export function useRecentsSync(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let loaded = false

    window.api.settings
      .get()
      .then((cfg: { recentConnections?: unknown }) => {
        // Anything opened before settings arrived goes first.
        const current = useAppStore.getState().recentConnections
        const saved = sanitizeRecents(cfg.recentConnections).filter((r) => !current.some((c) => c.id === r.id))
        useAppStore.getState().setRecentConnections([...current, ...saved].slice(0, MAX_RECENTS))
      })
      .catch((err: unknown) => {
        useAppStore.getState().addNotification({ type: 'warning', message: ipcErrorMessage(err, 'Could not load recent connections') })
      })
      .finally(() => { loaded = true })

    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (!loaded || state.recentConnections === prev.recentConnections) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        window.api.settings.set('recentConnections', state.recentConnections).catch((err: unknown) => {
          useAppStore.getState().addNotification({ type: 'warning', message: ipcErrorMessage(err, 'Could not save recent connections') })
        })
      }, PERSIST_DELAY_MS)
    })

    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])
}
