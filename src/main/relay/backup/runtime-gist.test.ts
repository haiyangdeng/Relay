import { createHash } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RUNTIME_GIST_FILENAME,
  RUNTIME_GIST_MAX_BYTES,
  runtimeGistRequest,
  runtimeGistSource,
  type RelayRuntimeGistPlan
} from '../../../shared/relay/runtime-gist'
import type { PluginRequestOptions, PluginResponse } from '../../resolve/plugin/http-client'
import { decryptAgeContent, generateAgeKeyPair } from '../../utils/age'
import { createRuntimeGistService, type RuntimeGistSnapshot } from './runtime-gist'

const id = 'abcdef0123456789',
  input = { token: 'PRIVATE-fixture-token', proxyPort: 17891 },
  services: ReturnType<typeof createRuntimeGistService>[] = []
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.requestClose()))
  vi.unstubAllEnvs()
})
function response(
  content: string,
  status = 200,
  overrides: Record<string, unknown> = {}
): PluginResponse {
  const bytes = Buffer.from(
    JSON.stringify({
      id,
      public: false,
      files: {
        [RUNTIME_GIST_FILENAME]: {
          filename: RUNTIME_GIST_FILENAME,
          content,
          size: Buffer.byteLength(content),
          truncated: false,
          raw_url: 'https://PRIVATE-never-read.invalid/raw'
        }
      },
      ...overrides
    })
  )
  return { status, headers: {}, body: bytes.toString(), bytes }
}
function fixture() {
  const source: RuntimeGistSnapshot = {
    instanceId: '00000000-0000-0000-0000-000000000001',
    revision: 'a'.repeat(64),
    configuration: 'proxies: []\n# PRIVATE-runtime-secret\n',
    proxyPort: 17891
  }
  const clock = { now: 10000 },
    confirm = vi.fn(async (_plan: RelayRuntimeGistPlan) => false),
    readRuntime = vi.fn(
      async (
        _signal: AbortSignal,
        _source?: import('../../../shared/relay/runtime-gist').RelayRuntimeGistSource,
        _port?: number
      ) => ({ ...source })
    ),
    assertRuntime = vi.fn((expected: Readonly<RuntimeGistSnapshot>) => {
      if (
        source.instanceId !== expected.instanceId ||
        source.revision !== expected.revision ||
        source.proxyPort !== expected.proxyPort
      )
        throw new Error('Fixture owned runtime changed')
    }),
    assertIdle = vi.fn(),
    sent: { url: string; options: PluginRequestOptions }[] = []
  let remoteContent = 'proxies: []\n# previous remote snapshot\n'
  const perform = async (url: string, options: PluginRequestOptions): Promise<PluginResponse> => {
    sent.push({
      url,
      options: {
        ...options,
        headers: { ...options.headers },
        ...(Buffer.isBuffer(options.body) ? { body: Buffer.from(options.body) } : {})
      }
    })
    if (options.method === 'POST' || options.method === 'PATCH') {
      const data = JSON.parse(String(options.body))
      remoteContent = data.files[RUNTIME_GIST_FILENAME].content
      return response(remoteContent, options.method === 'POST' ? 201 : 200)
    }
    return response(remoteContent)
  }
  const request = vi.fn(perform),
    service = createRuntimeGistService({
      readRuntime,
      confirm,
      assertIdle,
      assertRuntime,
      request,
      now: () => clock.now
    })
  services.push(service)
  return {
    service,
    source,
    readRuntime,
    confirm,
    assertIdle,
    assertRuntime,
    request,
    perform,
    sent,
    clock
  }
}
describe('Manual owned runtime YAML Gist synchronization', () => {
  const tunSource = {
    kind: 'tun-managed' as const,
    sessionId: '11111111-1111-4111-8111-111111111111'
  }
  it('keeps omitted sources backward compatible and strictly validates explicit source selectors', () => {
    expect(runtimeGistRequest(input)).not.toHaveProperty('source')
    expect(runtimeGistSource({ kind: 'local-proxy' })).toEqual({ kind: 'local-proxy' })
    expect(runtimeGistRequest({ ...input, source: tunSource }).source).toEqual(tunSource)
    for (const source of [
      null,
      [],
      { kind: ['local-proxy'] },
      { kind: new String('local-proxy') },
      { kind: 'local-proxy', sessionId: tunSource.sessionId },
      { ...tunSource, sessionId: '../other' },
      { ...tunSource, proxyPort: 17891 }
    ])
      expect(() => runtimeGistRequest({ ...input, source })).toThrow()
  })
  it('binds explicit TUN capture, port, public plan and every later read without falling back', async () => {
    const f = fixture()
    Object.assign(f.source, { source: tunSource, instanceId: tunSource.sessionId })
    const plan = await f.service.prepare({ ...input, source: tunSource })
    expect(plan.source).toEqual(tunSource)
    expect(f.readRuntime).toHaveBeenLastCalledWith(
      expect.any(AbortSignal),
      tunSource,
      input.proxyPort
    )
    expect(f.assertIdle).toHaveBeenLastCalledWith(tunSource)
    f.confirm.mockResolvedValueOnce(true)
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toMatchObject({
      status: 'uploaded'
    })
    for (const call of f.readRuntime.mock.calls)
      expect(call.slice(1)).toEqual([tunSource, input.proxyPort])
    expect(f.sent.map((item) => item.options.method)).toEqual(['POST', 'GET'])
  })
  it('rejects a local fallback, wrong TUN session or wrong account port before issuing a plan', async () => {
    for (const patch of [
      {},
      { source: tunSource, instanceId: '22222222-2222-4222-8222-222222222222' },
      { source: tunSource, instanceId: tunSource.sessionId, proxyPort: 18191 }
    ]) {
      const f = fixture()
      Object.assign(f.source, patch)
      await expect(f.service.prepare({ ...input, source: tunSource })).rejects.toThrow('准备未通过')
      expect(f.confirm).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
    }
  })
  it('holds the original TUN source through consent and rejects same-body source substitution', async () => {
    const f = fixture()
    Object.assign(f.source, { source: tunSource, instanceId: tunSource.sessionId })
    const plan = await f.service.prepare({ ...input, source: tunSource })
    f.confirm.mockImplementationOnce(async () => {
      f.source.source = undefined
      return true
    })
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
    expect(f.request).not.toHaveBeenCalled()
  })
  it('checks the proof-bound renderer context after async guards and immediately before dispatch', async () => {
    const f = fixture()
    let live = true,
      checks = 0
    const context = (): void => {
      if (!live) throw new Error('fixture context gone')
    }
    const plan = await f.service.prepare(input, undefined, context)
    f.confirm.mockResolvedValueOnce(true)
    f.assertRuntime.mockImplementation(() => {
      if (++checks === 2) {
        queueMicrotask(() => {
          live = false
        })
      }
    })
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
    expect(f.request).not.toHaveBeenCalled()
    expect(checks).toBe(2)
  })
  it('keeps submitted writes uncertain when the saved context disappears without an event', async () => {
    const f = fixture()
    let live = true
    const plan = await f.service.prepare(input, undefined, () => {
      if (!live) throw new Error('gone')
    })
    f.confirm.mockResolvedValueOnce(true)
    f.request.mockImplementation(async (url, options) => {
      const result = await f.perform(url, options)
      if (options.method === 'POST') live = false
      return result
    })
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toEqual({
      status: 'uncertain'
    })
    expect(f.sent.map((item) => item.options.method)).toEqual(['POST'])
  })

  it('rechecks saved-account authorization after native consent and consumes revoked evidence without sending credentials', async () => {
    const f = fixture()
    let active = true
    const recheck = vi.fn(async () => {
      if (!active) throw new Error('PRIVATE-account-token')
    })
    const plan = await f.service.prepare(input, recheck)
    f.confirm.mockImplementationOnce(async () => {
      active = false
      return true
    })
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
    expect(f.request).not.toHaveBeenCalled()
    expect(recheck).toHaveBeenCalledTimes(2)
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
  })
  it('checks the saved account after asynchronous runtime inspection and synchronously binds runtime state after account inspection', async () => {
    for (const changed of ['account', 'runtime'] as const) {
      const f = fixture()
      let active = true,
        checks = 0
      const recheck = async () => {
        checks++
        if (changed === 'runtime' && checks === 2) f.source.revision = 'b'.repeat(64)
        if (!active) throw new Error('Fixture account revoked')
      }
      const plan = await f.service.prepare(input, recheck)
      f.confirm.mockResolvedValue(true)
      if (changed === 'account')
        f.readRuntime.mockImplementationOnce(async () => {
          active = false
          return { ...f.source }
        })
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
      expect(f.request).not.toHaveBeenCalled()
    }
  })
  it('does not PATCH after account revocation during target GET, and reports uncertain after a submitted POST loses authorization', async () => {
    for (const update of [true, false]) {
      const f = fixture()
      let active = true
      const plan = await f.service.prepare(
        { ...input, ...(update ? { gistId: id } : {}) },
        async () => {
          if (!active) throw new Error('Fixture account changed')
        }
      )
      f.confirm.mockResolvedValue(true)
      f.request.mockImplementationOnce(async (url, options) => {
        const response = await f.perform(url, options)
        active = false
        return response
      })
      const pending = f.service.execute({ evidenceId: plan.evidenceId })
      if (update) await expect(pending).rejects.toThrow('同步未确认')
      else expect(await pending).toMatchObject({ status: 'uncertain' })
      expect(f.request).toHaveBeenCalledTimes(1)
      expect(f.request.mock.calls[0][1].method).toBe(update ? 'GET' : 'POST')
    }
  })
  it('rechecks cancellation and expiry after a saved-account guard was awaiting storage', async () => {
    for (const invalidation of ['cancel', 'expire'] as const) {
      const f = fixture(),
        guard = Promise.withResolvers<void>(),
        entered = Promise.withResolvers<void>()
      let checks = 0
      const plan = await f.service.prepare(input, async () => {
        if (++checks === 2) {
          entered.resolve()
          await guard.promise
        }
      })
      f.confirm.mockResolvedValue(true)
      const pending = f.service.execute({ evidenceId: plan.evidenceId })
      await entered.promise
      if (invalidation === 'cancel') f.service.cancel()
      else f.clock.now += 60001
      guard.resolve()
      if (invalidation === 'cancel') expect(await pending).toEqual({ status: 'cancelled' })
      else await expect(pending).rejects.toThrow('同步未确认')
      expect(f.request).not.toHaveBeenCalled()
    }
  })
  it('accepts only a bounded credential/target request and never accepts renderer configuration or paths', () => {
    expect(runtimeGistRequest({ ...input, gistId: '', recipient: '' })).toEqual(input)
    for (const patch of [
      { configuration: 'PRIVATE' },
      { path: '/PRIVATE' },
      { url: 'https://other.invalid' },
      { token: 'short' },
      { token: 'secret\r\nHeader: injected' },
      { gistId: '../other' },
      { recipient: 'age1invalid\nPRIVATE' },
      { proxyPort: 80 },
      { proxyPort: 65536 }
    ])
      expect(() => runtimeGistRequest({ ...input, ...patch })).toThrow()
  })
  it('prepares only from the main-process snapshot and defaults to cancellation with no network or secret reply', async () => {
    const f = fixture(),
      plan = await f.service.prepare(input)
    expect(plan).toMatchObject({
      action: 'create',
      endpoint: 'https://api.github.com/gists',
      filename: RUNTIME_GIST_FILENAME,
      containsSecrets: true,
      encrypted: false,
      configurationSHA256: createHash('sha256').update(f.source.configuration).digest('hex')
    })
    expect(JSON.stringify(plan)).not.toContain('PRIVATE')
    expect(f.request).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toEqual({
      status: 'cancelled'
    })
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(plan)
    expect(f.request).not.toHaveBeenCalled()
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
  })
  it('creates one secret fixed-file Gist through only the verified proxy and succeeds only after exact readback', async () => {
    const f = fixture(),
      plan = await f.service.prepare(input)
    f.confirm.mockResolvedValue(true)
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toEqual({
      status: 'uploaded',
      gistId: id,
      url: 'https://gist.github.com/' + id
    })
    expect(f.sent.map(({ url, options }) => [url, options.method])).toEqual([
      ['https://api.github.com/gists', 'POST'],
      ['https://api.github.com/gists/' + id, 'GET']
    ])
    const data = JSON.parse(String(f.sent[0].options.body))
    expect(data).toEqual({
      description: 'Auto Synced Clash Party Runtime Config',
      public: false,
      files: { [RUNTIME_GIST_FILENAME]: { content: f.source.configuration } }
    })
    for (const { options } of f.sent)
      expect(options).toMatchObject({
        headers: { Authorization: 'Bearer ' + input.token },
        proxy: { host: '127.0.0.1', port: input.proxyPort },
        binary: true,
        captureRedirects: true
      })
    expect(f.readRuntime).toHaveBeenCalledTimes(5)
    expect(f.sent[1].options.headers?.['Cache-Control']).toBe('no-cache')
  })
  it('checks a specified secret single-file target before one PATCH and preserves optional AGE compatibility', async () => {
    const f = fixture(),
      keys = await generateAgeKeyPair(),
      plan = await f.service.prepare({ ...input, gistId: id, recipient: keys.recipient })
    expect(plan).toMatchObject({ action: 'update', gistId: id, encrypted: true })
    f.confirm.mockResolvedValue(true)
    expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('uploaded')
    expect(f.sent.map(({ options }) => options.method)).toEqual(['GET', 'PATCH', 'GET'])
    const patch = JSON.parse(String(f.sent[1].options.body)),
      content = patch.files[RUNTIME_GIST_FILENAME].content
    expect(Object.keys(patch)).toEqual(['files'])
    expect(content).toContain('BEGIN AGE ENCRYPTED FILE')
    expect(content).not.toContain('PRIVATE')
    expect(await decryptAgeContent(content, keys.secretKey)).toBe(f.source.configuration)
    expect(createHash('sha256').update(content).digest('hex')).toBe(plan.payloadSHA256)
  })
  it('rejects invalid snapshots, mismatched owned proxy ports and oversized or invalid UTF-8 text before network', async () => {
    for (const patch of [
      { instanceId: '' },
      { revision: 'unknown' },
      { proxyPort: 17892 },
      { configuration: 'x'.repeat(RUNTIME_GIST_MAX_BYTES + 1) },
      { configuration: '\ud800' },
      { configuration: 'proxies:\0[]' }
    ]) {
      const f = fixture()
      Object.assign(f.source, patch)
      await expect(f.service.prepare(input)).rejects.toThrow('准备未通过')
      expect(f.request).not.toHaveBeenCalled()
    }
    const f = fixture()
    await expect(f.service.prepare({ ...input, recipient: 'not-a-recipient' })).rejects.toThrow(
      '准备未通过'
    )
  })
  it('rechecks instance, revision, exact configuration and owned proxy after confirmation', async () => {
    for (const patch of [
      { instanceId: 'another-instance' },
      { revision: 'b'.repeat(64) },
      { configuration: 'proxies: []\n# changed' },
      { proxyPort: 17892 }
    ]) {
      const f = fixture(),
        plan = await f.service.prepare(input)
      f.confirm.mockImplementation(async () => {
        Object.assign(f.source, patch)
        return true
      })
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
      expect(f.request).not.toHaveBeenCalled()
    }
  })
  it('rechecks the source immediately before PATCH and stops when the target GET was in flight during a runtime change', async () => {
    const f = fixture(),
      plan = await f.service.prepare({ ...input, gistId: id })
    f.confirm.mockResolvedValue(true)
    f.request.mockImplementationOnce(async (url, options) => {
      const result = await f.perform(url, options)
      f.source.revision = 'b'.repeat(64)
      return result
    })
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
    expect(f.sent.map(({ options }) => options.method)).toEqual(['GET'])
  })
  it('refuses expired or backward-clock preparation before and during confirmation', async () => {
    for (const during of [false, true])
      for (const time of [9999, 70000]) {
        const f = fixture(),
          plan = await f.service.prepare(input)
        if (during)
          f.confirm.mockImplementation(async () => {
            f.clock.now = time
            return true
          })
        else f.clock.now = time
        await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow()
        expect(f.request).not.toHaveBeenCalled()
      }
  })
  it('rejects public, foreign, extra-file, truncated, oversized, invalid UTF-8 or changed-target responses without PATCH/raw_url', async () => {
    const variants: PluginResponse[] = [
      response('old', 200, { public: true }),
      response('old', 200, { id: '11111' }),
      response('old', 200, { truncated: true }),
      response('old', 200, { files: { foreign: {} } }),
      response('old', 200, {
        files: {
          [RUNTIME_GIST_FILENAME]: {
            filename: RUNTIME_GIST_FILENAME,
            content: 'old',
            truncated: true
          }
        }
      }),
      response('x'.repeat(1024 * 1024 + 1)),
      { status: 200, headers: {}, body: '', bytes: Buffer.from([0xff]) },
      { status: 200, headers: {}, body: '', bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }
    ]
    for (const invalid of variants) {
      const f = fixture(),
        plan = await f.service.prepare({ ...input, gistId: id })
      f.confirm.mockResolvedValue(true)
      f.request.mockResolvedValueOnce(invalid)
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
      expect(f.request).toHaveBeenCalledTimes(1)
      expect(f.request.mock.calls[0][0]).toBe('https://api.github.com/gists/' + id)
      expect(f.request.mock.calls[0][1].method).toBe('GET')
    }
  })
  it('does not retry authentication failures or redirects and refuses a TLS-disabled environment', async () => {
    for (const status of [301, 302, 401, 403, 500]) {
      const f = fixture(),
        plan = await f.service.prepare({ ...input, gistId: id })
      f.confirm.mockResolvedValue(true)
      f.request.mockResolvedValueOnce({
        ...response('old'),
        status,
        headers: { location: 'https://PRIVATE.invalid' }
      })
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
      expect(f.request).toHaveBeenCalledTimes(1)
    }
    const f = fixture(),
      plan = await f.service.prepare(input)
    f.confirm.mockResolvedValue(true)
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0')
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('同步未确认')
    expect(f.request).not.toHaveBeenCalled()
  })
  it('reports a single write with failed, changed or unverified readback as uncertain without retrying', async () => {
    for (const failure of ['transport', 'content', 'runtime'] as const) {
      const f = fixture(),
        plan = await f.service.prepare(input)
      f.confirm.mockResolvedValue(true)
      if (failure === 'transport')
        f.request.mockRejectedValueOnce(new Error('PRIVATE-transmission-unknown'))
      else if (failure === 'content')
        f.request.mockImplementationOnce(f.perform).mockResolvedValueOnce(response('different'))
      else
        f.request.mockImplementationOnce(async (url, options) => {
          const result = await f.perform(url, options)
          f.source.proxyPort = 17892
          return result
        })
      expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('uncertain')
      expect(f.request.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(
        1
      )
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
    }
  })
  it('cancels preparation and confirmation without publishing proof or contacting GitHub, and waits for in-flight work', async () => {
    const f = fixture(),
      reading = Promise.withResolvers<RuntimeGistSnapshot>()
    f.readRuntime.mockImplementationOnce(() => reading.promise)
    const preparing = f.service.prepare(input),
      rejected = expect(preparing).rejects.toThrow('准备已取消')
    await vi.waitFor(() => expect(f.readRuntime).toHaveBeenCalled())
    f.service.cancel()
    const ended = vi.fn(),
      waiting = f.service.whenIdle().then(ended)
    expect(ended).not.toHaveBeenCalled()
    reading.resolve({ ...f.source })
    await rejected
    await waiting
    const plan = await f.service.prepare(input),
      approval = Promise.withResolvers<boolean>()
    f.confirm.mockImplementationOnce(() => approval.promise)
    const execution = f.service.execute({ evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalled())
    const closed = vi.fn(),
      closing = f.service.requestClose().then(closed)
    expect(closed).not.toHaveBeenCalled()
    await expect(f.service.prepare(input)).rejects.toThrow('等待')
    approval.resolve(true)
    expect(await execution).toEqual({ status: 'cancelled' })
    await closing
    expect(f.request).not.toHaveBeenCalled()
  })
  it('waits for an in-flight update target GET after cancel, then refuses PATCH or reuse of the consumed proof', async () => {
    const f = fixture(),
      plan = await f.service.prepare({ ...input, gistId: id }),
      deferred = Promise.withResolvers<PluginResponse>()
    f.confirm.mockResolvedValue(true)
    f.request.mockImplementationOnce(() => deferred.promise)
    const execution = f.service.execute({ evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
    f.service.cancel()
    expect(f.request.mock.calls[0][1].signal?.aborted).toBe(true)
    const ended = vi.fn(),
      waiting = f.service.whenIdle().then(ended)
    expect(ended).not.toHaveBeenCalled()
    deferred.resolve(response('old'))
    expect(await execution).toEqual({ status: 'cancelled' })
    await waiting
    expect(f.request).toHaveBeenCalledTimes(1)
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
  })
  it('waits for a submitted create on close and reports uncertainty without a readback or automatic replay', async () => {
    const f = fixture(),
      plan = await f.service.prepare(input),
      deferred = Promise.withResolvers<PluginResponse>()
    f.confirm.mockResolvedValue(true)
    f.request.mockImplementationOnce(() => deferred.promise)
    const execution = f.service.execute({ evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.request).toHaveBeenCalled())
    const ended = vi.fn(),
      closing = f.service.requestClose().then(ended)
    expect(ended).not.toHaveBeenCalled()
    expect(f.request.mock.calls[0][1].signal?.aborted).toBe(true)
    deferred.resolve(response(f.source.configuration, 201))
    expect(await execution).toEqual({ status: 'uncertain' })
    await closing
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.request.mock.calls[0][1].method).toBe('POST')
    expect(f.service.isBusy()).toBe(false)
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
  })
})
