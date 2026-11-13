import { describe, expect, it } from 'vitest'
import { connectionSortFromPreferences, connectionSortPreference } from './connection-sort'

describe('Owned connection sorting preferences', () => {
  it.each([
    ['time', 'startedAt'],
    ['upload', 'upload'],
    ['download', 'download'],
    ['uploadSpeed', 'uploadRate'],
    ['downloadSpeed', 'downloadRate']
  ] as const)(
    'maps %s in both directions without changing direction semantics',
    (preference, order) => {
      for (const direction of ['asc', 'desc'] as const)
        expect(
          connectionSortFromPreferences({
            connectionOrderBy: preference,
            connectionDirection: direction
          })
        ).toEqual({ order, descending: direction === 'desc' })
      expect(connectionSortPreference(order)).toBe(preference)
    }
  )

  it('uses upstream defaults before preferences arrive and never persists a snapshot as an upstream order', () => {
    expect(connectionSortFromPreferences()).toEqual({ order: 'startedAt', descending: false })
    expect(connectionSortPreference('snapshot')).toBeUndefined()
    expect(connectionSortPreference('unknown')).toBeUndefined()
  })
})
