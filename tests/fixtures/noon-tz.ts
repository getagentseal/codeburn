/** A fixed-offset zone in which it is about noon right now, on the same date as UTC. A CLI
 * child run in it has ~12 hours of "today" on either side, so a fixture stamped a little in
 * the past lands in today however close the run is to midnight UTC. Etc/GMT signs are
 * inverted: Etc/GMT-12 is UTC+12. */
export function noonTz(now = new Date()): string {
  const east = 12 - now.getUTCHours()
  return east === 0 ? 'UTC' : `Etc/GMT${east > 0 ? '-' : '+'}${Math.abs(east)}`
}
