export const STAR_URL = 'https://github.com/getagentseal/codeburn'

const FIRST_SEEN = 'codeburn.firstSeen'
const STAR_DONE = 'codeburn.starDone'
const DAY = 86_400_000

type Store = { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> }

export function recordFirstSeen(store: Store, now = Date.now()): void {
  if (store.get<number>(FIRST_SEEN) === undefined) void store.update(FIRST_SEEN, now)
}

/** The sidebar's star line: from the third day of use, until it is clicked or dismissed. */
export function showStar(store: Store, now = Date.now()): boolean {
  const first = store.get<number>(FIRST_SEEN)
  return !store.get<boolean>(STAR_DONE) && first !== undefined && now - first >= 2 * DAY
}

export function finishStar(store: Store): Thenable<void> {
  return store.update(STAR_DONE, true)
}
