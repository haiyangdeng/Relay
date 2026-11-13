import { describe, expect, it } from 'vitest'
import { readConnections } from './owned-observe'

describe('Owned core connection snapshots', () => {
  it('keeps genuine zero counters and an empty list', async () => {
    expect(
      await readConnections({
        read: async () => ({ connections: [], downloadTotal: 0, uploadTotal: 0 })
      })
    ).toEqual({ connections: [], download: 0, upload: 0 })
  })
  it('refuses malformed counters and missing lists instead of fabricating empty traffic', async () => {
    for (const value of [
      { downloadTotal: 0, uploadTotal: 0 },
      { connections: [], downloadTotal: '0', uploadTotal: 0 },
      { connections: [], downloadTotal: -1, uploadTotal: 0 },
      { connections: [], downloadTotal: Infinity, uploadTotal: 0 },
      { connections: [], download: 1024, upload: 512 }
    ])
      await expect(readConnections({ read: async () => value })).rejects.toThrow('快照无效')
  })
  it('maps the pinned Mihomo total fields and its empty nullable connection list', async () => {
    expect(
      await readConnections({
        read: async () => ({ connections: null, downloadTotal: 1024, uploadTotal: 512 })
      })
    ).toEqual({ connections: [], download: 1024, upload: 512 })
  })
})
