/**
 * Native + browser notification helper.
 *
 * Uses Tauri's notification API when running inside the desktop wrapper
 * (Tauri injects `__TAURI__` on the window object). Falls back to the
 * web Notifications API when running in a regular browser. Both paths
 * fail soft: a denied permission becomes a no-op rather than a crash.
 */

/**
 * The Tauri 2.x notification plugin (`@tauri-apps/plugin-notification`)
 * isn't installed by default; users who want native dock notifications
 * can `npm i @tauri-apps/plugin-notification` and the web Notifications
 * API will be replaced automatically. Until then the standard browser
 * Notifications API works inside Tauri's webview the same as in Chrome.
 */
export async function notifyAlert(title: string, body: string): Promise<boolean> {
  // Web Notifications path — works in Tauri webview and standalone browser.
  if ('Notification' in window) {
    if (Notification.permission === 'default') {
      try {
        await Notification.requestPermission()
      } catch {
        // ignore
      }
    }
    if (Notification.permission === 'granted') {
      try {
        new Notification(title, { body })
        return true
      } catch {
        return false
      }
    }
  }
  return false
}

/**
 * Tracks which alerts have already fired so we don't spam the user.
 * State persists to IndexedDB (kv store) under a date-stamped key, so
 * the same NVDA→Sell transition doesn't re-notify across reloads
 * within a single trading day. Cleared automatically the next day.
 */
import { kvGet, kvSet } from './storage'

const memoryCache = new Set<string>()
let loadedForDay: string | null = null

function todayKey(): string {
  const today = new Date().toISOString().slice(0, 10)
  return `alerts:fired:${today}`
}

async function ensureLoaded(): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  if (loadedForDay === today) return
  memoryCache.clear()
  const stored = (await kvGet<string[]>(todayKey())) ?? []
  stored.forEach((sig) => memoryCache.add(sig))
  loadedForDay = today
}

export async function notifyOnce(signature: string, title: string, body: string): Promise<void> {
  await ensureLoaded()
  if (memoryCache.has(signature)) return
  memoryCache.add(signature)
  await kvSet(todayKey(), Array.from(memoryCache))
  await notifyAlert(title, body)
}

export async function resetNotifications(): Promise<void> {
  memoryCache.clear()
  loadedForDay = null
  await kvSet(todayKey(), [])
}

/**
 * Dock / taskbar badge for risk count. Uses the document title as a
 * universal fallback so the count shows up in tabs/windows even when
 * native badging isn't available. When running inside Tauri 2.x with
 * `tauri-plugin-window-state` configured, native badge calls hook in
 * automatically; when not, the title-prefix approach still works.
 *
 * Native menus (File > Import, View > Toggle theme, etc.) require
 * additions to `src-tauri/src/main.rs` and `src-tauri/tauri.conf.json`
 * — keep them as a separate Rust task. This module only handles what
 * the JavaScript side can drive on its own.
 */
export function setDockBadge(count: number, baseTitle = 'Finance Oracle Workstation'): void {
  // Title-prefix fallback (works everywhere)
  document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle

  // Try native badging where available (Chromium on Windows / macOS dock)
  const navAny = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void> }
  if (navAny.setAppBadge) {
    void navAny.setAppBadge(count > 0 ? count : undefined).catch(() => undefined)
  }
}
