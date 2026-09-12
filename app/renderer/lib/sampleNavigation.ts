/**
 * Minimal sample-navigation adapter (Goal 4, Inspect samples).
 *
 * CONTRACT (for the shared navigation integration): the cohort sample list
 * calls `openSample(ref)` when the user activates a sample row. Whoever owns
 * the common drill-through navigation registers itself once via
 * `registerSampleOpener`. `openSample` returns false when no navigation is
 * registered, and the Compare section keeps its self-contained inline sample
 * rendering — the feature works standalone today and gains the shared
 * navigation without code changes here.
 *
 * `SampleRef` carries the canonical identity pieces only (project + session id
 * + timestamp). A bare sessionId is not globally unique, so consumers must
 * pair it with the project label exactly as reports print it.
 */
export type SampleRef = {
  sessionId: string
  project: string
  timestamp: string
}

export type SampleOpener = (ref: SampleRef) => void

let opener: SampleOpener | null = null

/** Install (or remove with null) the shared navigation's sample opener. */
export function registerSampleOpener(next: SampleOpener | null): void {
  opener = next
}

/** Hand a sample to the registered navigation; false when none is registered. */
export function openSample(ref: SampleRef): boolean {
  if (!opener) return false
  opener(ref)
  return true
}
