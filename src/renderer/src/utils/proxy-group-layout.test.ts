import { describe, expect, it } from 'vitest'
import { proxyGroupRowIndex, visibleGroupMembers } from './proxy-group-layout'

const members = [
  { name: 'Zulu', history: [{ delay: 0 }] },
  { name: 'Alpha', history: [{ delay: 10 }] },
  { name: 'Beta', history: [] }
]
describe('runtime group layout targets', () => {
  it('keeps the member list available while the group contributes no collapsed rows', () => {
    const visible = visibleGroupMembers(members, '', false)
    expect(visible).toHaveLength(3)
    expect(proxyGroupRowIndex([2, 0], 1, visible, 'Beta', 2)).toBeUndefined()
    expect(proxyGroupRowIndex([2, 2], 1, visible, 'Beta', 2)).toBe(3)
  })
  it('locates against the committed sorted rows and current column count after search clears', () => {
    expect(visibleGroupMembers(members, 'Alpha', false)).toHaveLength(1)
    const sorted = visibleGroupMembers(members, '', false).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    expect(proxyGroupRowIndex([3, 2], 1, sorted, 'Zulu', 2)).toBe(4)
    expect(proxyGroupRowIndex([3, 1], 1, sorted, 'Zulu', 3)).toBe(3)
  })
  it('reveals only the requested current member without changing unavailable filtering globally', () => {
    expect(visibleGroupMembers(members, '', true).map((entry) => entry.name)).toEqual([
      'Alpha',
      'Beta'
    ])
    expect(visibleGroupMembers(members, '', true, 'Zulu')).toHaveLength(3)
    expect(visibleGroupMembers(members, 'Alpha', true, 'Zulu')).toEqual([members[1]])
  })
  it('never turns an absent member or invalid layout into a previous group index', () => {
    expect(proxyGroupRowIndex([8, 2], 1, members, 'absent', 2)).toBeUndefined()
    expect(proxyGroupRowIndex([8, 2], 1, members, undefined, 2)).toBeUndefined()
    expect(proxyGroupRowIndex([8, 2], 1, members, 'Zulu', 0)).toBeUndefined()
  })
})
