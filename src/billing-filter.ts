import { callBillingMode, effectiveRouteId, parseBillingMode, registeredRouteIds } from './models.js'
import { filterProjectsByCall } from './parser.js'
import type { ParsedApiCall, ProjectSummary } from './types.js'

// The call-level half of #1451: `--route` picks the door a call was billed
// through, `--billing` picks whether that door charges per call. Both read the
// same evidence every report keys its model rows on, so a slice never
// disagrees with the row it came from, and both slice at the CALL — a session
// that mixed doors contributes only its matching calls.
//
// `direct` is the complement of the registered doors, and it is honestly
// direct-OR-unknown: a provider that records no door at all is indistinguishable
// from one billed by the vendor itself. The help says so rather than claiming
// confirmed first-party billing.

/// The `--route` values the CLI accepts: every registered door plus the
/// complement. Sorted the way the registry lists them, with `direct` first
/// because it is the one that is not a door.
export const ROUTE_FILTER_VALUES: readonly string[] = ['direct', ...registeredRouteIds()]

export const BILLING_FILTER_VALUES: readonly string[] = ['metered', 'subscription']

export type BillingRouteFilter = {
  /// A value from ROUTE_FILTER_VALUES; already validated by the CLI.
  route?: string
  /// A value from BILLING_FILTER_VALUES; already validated by the CLI.
  billing?: string
}

function callMatches(call: ParsedApiCall, filter: BillingRouteFilter): boolean {
  if (filter.route) {
    const route = effectiveRouteId(call.model, call.route)
    if (filter.route === 'direct' ? route !== null : route !== filter.route) return false
  }
  // An unknown mode answers to neither `metered` nor `subscription`; it is
  // never coerced into one to make a filter produce a row.
  if (filter.billing && callBillingMode(call) !== parseBillingMode(filter.billing)) return false
  return true
}

/// Apply `--route` / `--billing` to a parsed corpus, rebuilding every nested
/// total from the retained calls. Returns the input unchanged when neither
/// filter is set, so the unfiltered path pays nothing.
export function filterProjectsByBillingRoute(projects: ProjectSummary[], filter: BillingRouteFilter): ProjectSummary[] {
  if (!filter.route && !filter.billing) return projects
  return filterProjectsByCall(projects, call => callMatches(call, filter))
}
