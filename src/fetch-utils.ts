// Default ceiling for outbound HTTP. Every CLI command awaits loadPricing(),
// and the macOS menubar shells out to the CLI and blocks on its exit — so an
// unbounded fetch() on a half-open network (e.g. Wi-Fi/DNS not yet up after
// wake-from-sleep) wedges the menubar on its loading spinner indefinitely.
// 8s is generous for these small JSON endpoints while still failing fast.
export const DEFAULT_FETCH_TIMEOUT_MS = 8000

/// fetch() with a hard timeout. On timeout the returned promise rejects with a
/// TimeoutError (an AbortError subtype), which callers already handle via their
/// existing try/catch + bundled-snapshot fallback. A caller-supplied signal is
/// combined with the timeout so either can abort the request.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal
  return fetch(url, { ...init, signal })
}
