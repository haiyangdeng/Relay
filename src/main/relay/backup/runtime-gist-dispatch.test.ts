import { describe, expect, it } from 'vitest'
import { createRuntimeGistWriter } from './runtime-gist-writer'

describe('Runtime Gist actual request invocation boundary', () => {
  it('invokes the mutation while authority is still live before publishing submission notifications', async () => {
    let live = true
    const calls: { method: string; live: boolean }[] = []
    const check = (): void => {
      if (!live) throw new Error('Fixture authority revoked')
    }
    const writer = createRuntimeGistWriter(async (_url, options) => {
      calls.push({ method: options.method ?? 'GET', live })
      if (options.method === 'PATCH') throw new Error('Fixture submitted write outcome unknown')
      return {
        status: 200,
        data: null,
        headers: {},
        bytes: Buffer.from(
          JSON.stringify({
            id: 'abcde',
            public: false,
            truncated: false,
            files: {
              'clash-party.yaml': {
                filename: 'clash-party.yaml',
                content: 'old',
                size: 3,
                truncated: false
              }
            }
          })
        )
      }
    })
    const result = await writer.write(
      {
        request: { proxyPort: 18080, token: 'fixture-token', gistId: 'abcde' },
        payload: Buffer.from('new')
      },
      new AbortController().signal,
      {
        beforeSend: async () => check(),
        beforeDispatch: check,
        // Production sync publishes State here. Such a synchronous observer can
        // revoke the held window, so it cannot precede the actual request call.
        submitted: () => {
          live = false
        }
      }
    )
    expect(result.status).toBe('uncertain')
    expect(calls).toEqual([
      { method: 'GET', live: true },
      { method: 'PATCH', live: true }
    ])
  })
})
