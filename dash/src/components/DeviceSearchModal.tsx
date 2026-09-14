import { useEffect, useState } from 'react'

import { scanDevices, pairDevice, type DiscoveredDevice } from '@/lib/api'

export function DeviceSearchModal({ onClose, onPaired }: { onClose: () => void; onPaired: () => void }) {
  const [scanning, setScanning] = useState(true)
  const [found, setFound] = useState<DiscoveredDevice[]>([])
  const [error, setError] = useState<string | null>(null)
  const [pairing, setPairing] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)

  const scan = async () => {
    setScanning(true)
    setError(null)
    setStatus(null)
    try {
      setFound(await scanDevices())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void scan()
  }, [])

  const connect = async (d: DiscoveredDevice) => {
    setPairing(d.fingerprint)
    setError(null)
    setStatus(`请在「${d.name}」上核对配对码 ${d.code}，并在对方设备上批准。等待中…`)
    try {
      const r = await pairDevice(d)
      if (r.ok) {
        setStatus(`已连接到「${r.name ?? d.name}」。`)
        onPaired()
        setTimeout(onClose, 700)
      } else {
        setError(r.error ?? '配对失败')
        setStatus(null)
        setPairing(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus(null)
      setPairing(null)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-lg border border-border bg-card shadow-[0_24px_60px_-20px_rgba(0,0,0,0.35)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-sm font-semibold text-foreground">搜索局域网设备</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void scan()}
              disabled={scanning}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-tertiary-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              重新扫描
            </button>
            <button onClick={onClose} className="rounded-md px-2 py-1 text-tertiary-foreground hover:text-foreground" aria-label="关闭">
              ✕
            </button>
          </div>
        </div>

        <div className="px-5 py-4">
          {scanning ? (
            <div className="flex items-center gap-3 py-6 text-sm text-tertiary-foreground">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
              正在搜索局域网中的设备…
            </div>
          ) : found.length === 0 ? (
            <p className="py-6 text-center text-sm text-tertiary-foreground">
              未发现设备。请在你的其他电脑上于同一 Wi-Fi 下运行 <span className="font-mono text-foreground">codeburn share</span>。
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {found.map((d) => (
                <div key={d.fingerprint} className="flex items-center gap-3 rounded-md border border-border px-3.5 py-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-interactive-secondary text-primary">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="4" width="18" height="12" rx="2" />
                      <path d="M8 20h8M12 16v4" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{d.name}</div>
                    <div className="truncate font-mono text-xs text-tertiary-foreground">
                      {d.host}:{d.port}
                    </div>
                  </div>
                  {d.paired ? (
                    <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">已连接</span>
                  ) : pairing === d.fingerprint ? (
                    <span className="font-mono text-xs text-tertiary-foreground">配对码 {d.code}</span>
                  ) : (
                    <button
                      onClick={() => void connect(d)}
                      disabled={!!pairing}
                      className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      连接
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {status && <p className="mt-3 text-xs text-tertiary-foreground">{status}</p>}
          {error && <p className="mt-3 text-xs text-chart-8">{error}</p>}
        </div>
      </div>
    </div>
  )
}
