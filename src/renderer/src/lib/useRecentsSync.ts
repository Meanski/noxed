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
    // Until the saved list has loaded, saving would overwrite it with only
    // this session's recents, so a failed load means no saving at all.
    let loaded = false
    const save = () => {
      timer = null
      window.api.settings.set('recentConnections', useAppStore.getState().recentConnections).catch((err: unknown) => {
        useAppStore.getState().addNotification({ type: 'warning', message: ipcErrorMessage(err, 'Could not save recent connections') })
      })
    }

    window.api.settings
      .get()
      .then((cfg: { recentConnections?: unknown }) => {
        // Anything opened before settings arrived goes first.
        const current = useAppStore.getState().recentConnections
        const saved = sanitizeRecents(cfg.recentConnections).filter((r) => !current.some((c) => c.id === r.id))
        loaded = true
        useAppStore.getState().setRecentConnections([...current, ...saved].slice(0, MAX_RECENTS))
      })
      .catch((err: unknown) => {
        useAppStore.getState().addNotification({ type: 'warning', message: ipcErrorMessage(err, 'Could not load recent connections') })
      })

    const unsubscribe = useAppStore.subscribe((state, prev) => {
      if (!loaded || state.recentConnections === prev.recentConnections) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(save, PERSIST_DELAY_MS)
    })

    // Don't lose the last change to the batching delay. Closing the window
    // tears the page down without unmounting React, so flush on pagehide too.
    const flush = () => {
      if (!timer) return
      clearTimeout(timer)
      save()
    }
    window.addEventListener('pagehide', flush)

    return () => {
      unsubscribe()
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])
}
