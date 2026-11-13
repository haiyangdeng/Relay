import { createHash } from 'crypto'
import { performance } from 'perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadSubStoreAsset } from '../substore/resources'

const transport = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../../resolve/plugin/http-client', () => ({ requestOnce: transport.request }))
const bytes = Buffer.from('verified resource fixture')
const pin = {
  version: 'fixture',
  url: 'https://github.com/fixture/releases/download/v1/asset',
  releaseURL: 'https://github.com/fixture/releases/tag/v1',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex')
}
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('Pinned update download transport contract', () => {
  it('receives GitHub redirect responses and keeps the same explicit proxy on every allowed hop', async () => {
    transport.request
      .mockResolvedValueOnce({
        status: 302,
        headers: {
          location: 'https://release-assets.githubusercontent.com/fixture/asset?token=fixture'
        },
        body: ''
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, bytes })
    expect(await downloadSubStoreAsset(pin, 17891, new AbortController().signal)).toEqual(bytes)
    expect(transport.request).toHaveBeenCalledTimes(2)
    for (const call of transport.request.mock.calls)
      expect(call[1]).toMatchObject({
        captureRedirects: true,
        proxy: { host: '127.0.0.1', port: 17891 },
        binary: true,
        maxBytes: bytes.length
      })
  })
  it('refuses a redirect to a foreign host or HTTP without attempting another route', async () => {
    for (const location of ['https://foreign.test/asset', 'http://github.com/fixture/asset']) {
      transport.request.mockReset()
      transport.request.mockResolvedValueOnce({ status: 302, headers: { location }, body: '' })
      await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
        '来源'
      )
      expect(transport.request).toHaveBeenCalledTimes(1)
    }
  })
  it('rejects changed bytes and disabled TLS verification rather than accepting an update', async () => {
    transport.request.mockResolvedValueOnce({
      status: 200,
      headers: {},
      bytes: Buffer.from('wrong')
    })
    await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
      '摘要'
    )
    transport.request.mockClear()
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
      'TLS'
    )
    expect(transport.request).not.toHaveBeenCalled()
  })
})

const clocks = vi.hoisted(() => ({ wall: 1000000, mono: 5000, expireDuringHash: false }))
vi.mock('crypto', async (original) => {
  const crypto = await original<typeof import('crypto')>()
  return {
    ...crypto,
    createHash: (...args: Parameters<typeof crypto.createHash>) => {
      if (clocks.expireDuringHash) clocks.mono = 65000
      return crypto.createHash(...args)
    }
  }
})
beforeEach(() => {
  clocks.wall = 1000000
  clocks.mono = 5000
  clocks.expireDuringHash = false
  transport.request.mockReset().mockResolvedValue(complete)
  vi.spyOn(Date, 'now').mockImplementation(() => clocks.wall)
  vi.spyOn(performance, 'now').mockImplementation(() => clocks.mono)
})
afterEach(() => vi.restoreAllMocks())
const advance = (ms: number): void => {
  clocks.wall += ms
  clocks.mono += ms
}
const redirect = {
  status: 302,
  headers: { location: 'https://release-assets.githubusercontent.com/fixture/asset' },
  body: ''
}
const complete = { status: 200, headers: {}, bytes, body: '' }

describe('One 60-second asset deadline across redirects', () => {
  it('passes only the remaining budget to each allowed request', async () => {
    transport.request
      .mockImplementationOnce(async () => {
        advance(40000)
        return redirect
      })
      .mockImplementationOnce(async () => {
        advance(19999)
        return complete
      })
    const signal = new AbortController().signal
    expect(await downloadSubStoreAsset(pin, 17891, signal)).toEqual(bytes)
    expect(transport.request.mock.calls.map(([, options]) => options.timeout)).toEqual([
      60000, 20000
    ])
    for (const [, options] of transport.request.mock.calls)
      expect(options).toMatchObject({ proxy: { host: '127.0.0.1', port: 17891 }, signal })
  })
  it('rejects a complete valid body that arrives after the shared deadline', async () => {
    transport.request
      .mockImplementationOnce(async () => {
        advance(40000)
        return redirect
      })
      .mockImplementationOnce(async () => {
        advance(20001)
        return complete
      })
    await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
      '超时'
    )
    expect(transport.request).toHaveBeenCalledTimes(2)
  })
  it('refuses an exactly expired redirect before dispatching another request', async () => {
    transport.request.mockImplementationOnce(async () => {
      advance(60000)
      return redirect
    })
    await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
      '超时'
    )
    expect(transport.request).toHaveBeenCalledOnce()
  })
  it.each(['wall', 'mono'] as const)(
    'rejects an expired %s clock even if the other clock stalls',
    async (clock) => {
      transport.request.mockImplementationOnce(async () => {
        clocks[clock] += 60000
        return complete
      })
      await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
        '超时'
      )
      expect(transport.request).toHaveBeenCalledOnce()
    }
  )
  it.each(['wall', 'mono'] as const)(
    'rejects a %s clock that moves behind its start',
    async (clock) => {
      transport.request.mockImplementationOnce(async () => {
        clocks[clock]--
        return complete
      })
      await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
        '超时'
      )
      expect(transport.request).toHaveBeenCalledOnce()
    }
  )
  it.each(['wall', 'mono'] as const)(
    'rejects a non-finite %s clock before dispatch',
    async (clock) => {
      clocks[clock] = Number.NaN
      await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
        '超时'
      )
      expect(transport.request).not.toHaveBeenCalled()
    }
  )
  it('checks the deadline again after digest verification and returns no bytes', async () => {
    transport.request.mockImplementationOnce(async () => {
      advance(59999)
      clocks.expireDuringHash = true
      return complete
    })
    await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
      '超时'
    )
    expect(transport.request).toHaveBeenCalledOnce()
  })
  it('keeps the original AbortSignal and rejects late successful bytes after cancellation', async () => {
    const controller = new AbortController()
    transport.request.mockImplementationOnce(async () => {
      controller.abort()
      return complete
    })
    await expect(downloadSubStoreAsset(pin, 17891, controller.signal)).rejects.toThrow('取消')
    expect(transport.request.mock.calls[0][1].signal).toBe(controller.signal)
    expect(transport.request).toHaveBeenCalledOnce()
  })
  it('gives a subsequent asset invocation a fresh independent deadline', async () => {
    transport.request.mockImplementation(async () => {
      advance(59000)
      return complete
    })
    expect(await downloadSubStoreAsset(pin, 17891, new AbortController().signal)).toEqual(bytes)
    expect(await downloadSubStoreAsset(pin, 17891, new AbortController().signal)).toEqual(bytes)
    expect(transport.request.mock.calls.map(([, options]) => options.timeout)).toEqual([
      60000, 60000
    ])
  })
})

describe('Shared deadline cannot renew after an observed partial clock rollback', () => {
  it.each(['wall', 'mono'] as const)(
    'rejects partial %s rollback still above start while the other clock advances',
    async (clock) => {
      const other = clock === 'wall' ? 'mono' : 'wall'
      transport.request
        .mockImplementationOnce(async () => {
          clocks[clock] += 40000
          clocks[other] += 10000
          return redirect
        })
        .mockImplementationOnce(async () => {
          clocks[clock] -= 10000
          clocks[other] += 1000
          return redirect
        })
      await expect(downloadSubStoreAsset(pin, 17891, new AbortController().signal)).rejects.toThrow(
        '超时'
      )
      expect(transport.request).toHaveBeenCalledTimes(2)
      expect(transport.request.mock.calls.map(([, options]) => options.timeout)).toEqual([
        60000, 20000
      ])
    }
  )
})
