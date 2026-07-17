export type ToastKind = 'ok' | 'error'
export type Toast = { id: number; text: string; kind: ToastKind }

let current: Toast | null = null
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
const hosts: number[] = []
let hostSeq = 0
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

/** Show a toast, replacing any current one (only ever one at a time), and start
 * its auto-dismiss timer. */
export function showToast(text: string, kind: ToastKind = 'ok', durationMs = 3000): void {
  seq += 1
  current = { id: seq, text, kind }
  clearTimer()
  timer = setTimeout(() => {
    current = null
    timer = null
    emit()
  }, durationMs)
  emit()
}

export function dismissToast(): void {
  clearTimer()
  current = null
  emit()
}

export function getToast(): Toast | null {
  return current
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Register a Toast host. Only the first-registered host renders (so App and a
 * standalone-tested Settings can both mount one without doubling the toast). The
 * store resets when the last host unmounts, keeping tests isolated. */
export function registerToastHost(): { id: number; release: () => void } {
  const id = ++hostSeq
  hosts.push(id)
  emit()
  return {
    id,
    release: () => {
      const index = hosts.indexOf(id)
      if (index >= 0) hosts.splice(index, 1)
      if (hosts.length === 0) {
        clearTimer()
        current = null
      }
      emit()
    },
  }
}

export function isPrimaryHost(id: number): boolean {
  return hosts.length > 0 && hosts[0] === id
}
