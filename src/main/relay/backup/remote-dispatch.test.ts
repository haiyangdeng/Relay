import { describe, expect, it } from 'vitest'
import { createRemoteBackupTransport } from './remote'

describe('WebDAV mutation submission observer isolation', () => {
  it('calls the real transport before publishing a submission observer that can revoke authority', async () => {
    let live = true
    const calls: { method: string; live: boolean }[] = []
    const check = (): void => {
      if (!live) throw new Error('Fixture authority revoked')
    }
    const transport = createRemoteBackupTransport(async (_url, options) => {
      calls.push({ method: options.method ?? 'GET', live })
      return { status: 201, body: '', headers: { etag: '"fixture-v1"' }, bytes: Buffer.alloc(0) }
    })
    const result = await transport.upload(
      {
        provider: 'webdav',
        action: 'upload',
        url: 'https://backup.example.test/new.json',
        username: 'fixture',
        password: '',
        proxyPort: 18080
      },
      Buffer.from('fixture-archive'),
      new AbortController().signal,
      async () => check(),
      {
        assertLive: check,
        submitted: () => {
          live = false
        }
      }
    )
    expect(result.status).toBe('uncertain')
    expect(calls).toEqual([{ method: 'PUT', live: true }])
  })
})
