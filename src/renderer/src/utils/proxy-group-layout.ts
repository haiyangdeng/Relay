import { includesIgnoreCase } from './includes'

export function visibleGroupMembers<T extends { name: string; history: { delay: number }[] }>(
  members: readonly T[],
  search: string | undefined,
  hideUnavailable: boolean,
  revealed?: string
): T[] {
  return members.filter((member) => {
    if (!member || !includesIgnoreCase(member.name, search)) return false
    if (!hideUnavailable || member.name === revealed || 'all' in member) return true
    return !member.history?.length || member.history[member.history.length - 1].delay !== 0
  })
}

// Virtuoso indexes rows rather than nodes. Missing members must never turn -1
// into the last row of the preceding group.
export function proxyGroupRowIndex(
  groupCounts: readonly number[],
  groupIndex: number,
  sortedMembers: readonly { name: string }[],
  member: string | undefined,
  cols: number
): number | undefined {
  if (!member || !Number.isInteger(cols) || cols < 1 || !groupCounts[groupIndex]) return undefined
  const index = sortedMembers.findIndex((proxy) => proxy.name === member)
  if (index < 0) return undefined
  const row = Math.floor(index / cols)
  if (row >= groupCounts[groupIndex]) return undefined
  return groupCounts.slice(0, groupIndex).reduce((sum, count) => sum + count, 0) + row
}
