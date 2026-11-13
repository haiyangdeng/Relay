import { describe, expect, it, vi } from 'vitest'
import type { RelayBackupAccount } from '../../../shared/relay/backup-accounts'
import { RUNTIME_GIST_DESCRIPTION } from '../../../shared/relay/runtime-gist-discovery'
import type { requestOnce, PluginResponse } from '../../resolve/plugin/http-client'
import { createRuntimeGistDiscoveryService } from './runtime-gist-discovery'

const row = (id = 'abcde') => ({
  id,
  description: RUNTIME_GIST_DESCRIPTION,
  public: false,
  truncated: false,
  updated_at: '2026-11-01T00:00:00Z',
  files: { 'clash-party.yaml': { filename: 'clash-party.yaml', size: 37 } }
})
const response = (rows: unknown, link?: string): PluginResponse => ({
  status: 200,
  headers: { ...(link ? { link } : {}) },
  body: '',
  bytes: Buffer.from(JSON.stringify(rows))
})
function setup() {
  let at = 100000,
    visible = true
  const current: RelayBackupAccount = {
      id: '11111111-1111-4111-8111-111111111111',
      revision: 'a'.repeat(64),
      name: 'Fixture Gist',
      provider: 'gist',
      proxyPort: 18191,
      recipient: 'AGE-public-setting-not-discovery-authority',
      state: 'active',
      hasCredential: true,
      createdAt: 1,
      updatedAt: 2
    },
    selected = () => ({ id: current.id, revision: current.revision }),
    assertSelection = (raw: unknown): void => {
      if (JSON.stringify(raw) !== JSON.stringify(selected()))
        throw new Error('PRIVATE account changed')
    },
    read = vi.fn(async (raw: unknown) => {
      assertSelection(raw)
      return structuredClone(current)
    }),
    credential = vi.fn(async (raw: unknown) => {
      assertSelection(raw)
      return { account: structuredClone(current), secret: 'PRIVATE-fixture-token' }
    }),
    assertIdle = vi.fn(),
    confirm = vi.fn(async () => true),
    request = vi.fn<typeof requestOnce>(async () => response([row()])),
    assertLive = vi.fn(() => {
      if (!visible) throw new Error('PRIVATE renderer gone')
    }),
    service = createRuntimeGistDiscoveryService({
      store: { read, credential },
      assertIdle,
      confirm,
      request,
      now: () => at
    })
  return {
    service,
    current,
    selected,
    read,
    credential,
    assertIdle,
    confirm,
    request,
    assertLive,
    advance: (delta: number) => {
      at += delta
    },
    loseContext: () => {
      visible = false
    },
    contextIsLive: () => visible,
    prepare: (page = 1) => service.prepare({ ...selected(), page }, assertLive)
  }
}

describe('Explicit read-only runtime Gist discovery', () => {
  it('has no initial IO and prepares public scope without decrypting, capturing or requesting', async () => {
    const f = setup()
    expect(f.read).not.toHaveBeenCalled()
    const plan = await f.prepare(2)
    expect(plan).toMatchObject({
      ...f.selected(),
      action: 'listRuntimeCandidates',
      endpoint: 'https://api.github.com/gists?per_page=100&page=2',
      page: 2,
      perPage: 100,
      description: RUNTIME_GIST_DESCRIPTION,
      filename: 'clash-party.yaml',
      proxyPort: 18191,
      expiresAt: 160000
    })
    expect(f.credential).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
    expect(JSON.stringify(plan)).not.toMatch(/PRIVATE|recipient|token|content/u)
    expect(f.service.cancel({ evidenceId: plan.evidenceId })).toBe(true)
  })
  it.each(['disabled', 'webdav'] as const)(
    'refuses %s accounts before any credential access',
    async (kind) => {
      const f = setup()
      if (kind === 'disabled') f.current.state = 'disabled'
      else {
        f.current.provider = 'webdav'
        f.current.directoryURL = 'https://dav.invalid/Relay/'
        f.current.username = 'fixture'
      }
      await expect(f.prepare()).rejects.toThrow('准备未通过')
      expect(f.credential).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
    }
  )
  it('captures private context before the first saved metadata await and refuses its late result', async () => {
    const f = setup(),
      held = Promise.withResolvers<RelayBackupAccount>()
    f.read.mockReturnValueOnce(held.promise)
    const preparing = f.prepare()
    f.loseContext()
    held.resolve(structuredClone(f.current))
    await expect(preparing).rejects.toThrow('准备未通过')
    expect(f.credential).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
  })
  it('does not decrypt or GET when Native cancels and consumes the proof once', async () => {
    const f = setup(),
      plan = await f.prepare()
    f.confirm.mockResolvedValueOnce(false)
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toEqual({
      status: 'cancelled'
    })
    expect(f.confirm).toHaveBeenCalledWith(plan)
    expect(f.credential).not.toHaveBeenCalled()
    expect(f.request).not.toHaveBeenCalled()
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('已失效')
  })
  it('returns every matching ID as safe unverified metadata with one fixed proxy GET and no follow-up', async () => {
    const f = setup(),
      first = {
        ...row(),
        html_url: 'https://evil.invalid/PRIVATE',
        owner: { login: 'PRIVATE' },
        PRIVATE: 'PRIVATE',
        content: 'PRIVATE'
      }
    Object.assign(first.files['clash-party.yaml'], {
      raw_url: 'https://evil.invalid/raw',
      content: 'PRIVATE'
    })
    f.request.mockResolvedValueOnce(
      response([first, row('abcdf')], '<https://evil.invalid/steal>; rel="next"')
    )
    const plan = await f.prepare(),
      result = await f.service.execute({ evidenceId: plan.evidenceId })
    expect(result).toEqual({
      status: 'listed',
      page: 1,
      scanned: 2,
      moreAvailable: true,
      nextPage: 2,
      budgetReached: false,
      checkedAt: 100000,
      account: f.selected(),
      entries: ['abcde', 'abcdf'].map((id) => ({
        id,
        updatedAt: '2026-11-01T00:00:00Z',
        payloadBytes: 37,
        verified: false
      }))
    })
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|raw_url|html_url|content|token|recipient/u)
    expect(f.request).toHaveBeenCalledOnce()
    expect(f.request).toHaveBeenCalledWith(
      plan.endpoint,
      expect.objectContaining({
        method: 'GET',
        proxy: { host: '127.0.0.1', port: 18191 },
        timeout: 60000,
        maxBytes: 2 * 1024 * 1024,
        binary: true,
        captureRedirects: true,
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          Authorization: 'Bearer PRIVATE-fixture-token',
          'X-GitHub-Api-Version': '2022-11-28'
        })
      })
    )
    expect(f.request.mock.calls[0][1]).not.toHaveProperty('body')
  })
  it('filters public/multiple/wrong/renamed/truncated/oversize/invalid-time metadata without fetching raw content', async () => {
    const f = setup(),
      publicRow = { ...row(), public: true },
      renamed = { ...row(), description: 'other' },
      multi = { ...row(), files: { ...row().files, extra: { filename: 'extra', size: 1 } } },
      wrong = {
        ...row(),
        files: { 'relay-backup.json': { filename: 'relay-backup.json', size: 1 } }
      },
      truncated = { ...row(), truncated: true },
      fileTruncated = row(),
      tooBig = row(),
      invalidDate = row()
    Object.assign(fileTruncated.files['clash-party.yaml'], { truncated: true })
    tooBig.files['clash-party.yaml'].size = 1024 * 1024 + 1
    invalidDate.updated_at = '2026-02-31T00:00:00Z'
    f.request.mockResolvedValueOnce(
      response([publicRow, renamed, multi, wrong, truncated, fileTruncated, tooBig, invalidDate])
    )
    const plan = await f.prepare()
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toMatchObject({
      status: 'listed',
      scanned: 8,
      entries: []
    })
    expect(f.request).toHaveBeenCalledOnce()
  })
  it.each([1, 1000])(
    'preserves more-page hints with an empty candidate page at client page %i',
    async (page) => {
      const f = setup()
      f.request.mockResolvedValueOnce(
        response([{ ...row(), description: 'other' }], '<https://evil.invalid/>; rel="next"')
      )
      const plan = await f.prepare(page),
        result = await f.service.execute({ evidenceId: plan.evidenceId })
      expect(result).toMatchObject({
        status: 'listed',
        entries: [],
        moreAvailable: true,
        budgetReached: page === 1000
      })
      if (page === 1000) expect(result).not.toHaveProperty('nextPage')
      else expect(result).toHaveProperty('nextPage', 2)
      expect(f.request.mock.calls.map(([url]) => url)).toEqual([plan.endpoint])
    }
  )
  it.each(['duplicate', 'rows', 'bytes', 'utf8', 'redirect', 'unauthorized', 'missing-bytes'])(
    'refuses %s response without partial success, fallback or retry',
    async (kind) => {
      const f = setup(),
        bad = response([])
      if (kind === 'duplicate') bad.bytes = response([row(), row()]).bytes
      if (kind === 'rows') bad.bytes = response(Array.from({ length: 101 }, () => row())).bytes
      if (kind === 'bytes') bad.bytes = Buffer.alloc(2 * 1024 * 1024 + 1)
      if (kind === 'utf8') bad.bytes = Buffer.from([0xff])
      if (kind === 'redirect') {
        bad.status = 302
        bad.headers.location = 'https://evil.invalid/PRIVATE'
      }
      if (kind === 'unauthorized') bad.status = 401
      if (kind === 'missing-bytes') bad.bytes = undefined
      f.request.mockResolvedValueOnce(bad)
      const plan = await f.prepare()
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('读取未确认')
      expect(f.request).toHaveBeenCalledOnce()
    }
  )
  it.each([
    'native-context',
    'native-account',
    'credential-context',
    'credential-failure',
    'credential-binding'
  ])('sends nothing after %s is lost', async (kind) => {
    const f = setup(),
      plan = await f.prepare()
    if (kind === 'native-context')
      f.confirm.mockImplementationOnce(async () => {
        f.loseContext()
        return true
      })
    if (kind === 'native-account')
      f.confirm.mockImplementationOnce(async () => {
        f.current.revision = 'b'.repeat(64)
        return true
      })
    if (kind === 'credential-context')
      f.credential.mockImplementationOnce(async () => {
        f.loseContext()
        return { account: structuredClone(f.current), secret: 'PRIVATE-fixture-token' }
      })
    if (kind === 'credential-failure')
      f.credential.mockRejectedValueOnce(new Error('PRIVATE secret storage'))
    if (kind === 'credential-binding')
      f.credential.mockResolvedValueOnce({
        account: { ...f.current, proxyPort: 18192 },
        secret: 'PRIVATE-fixture-token'
      })
    const work = f.service.execute({ evidenceId: plan.evidenceId })
    if (kind.startsWith('credential-') && kind !== 'credential-context')
      await expect(work).rejects.toThrow('读取未确认')
    else expect(await work).toEqual({ status: 'cancelled' })
    expect(f.request).not.toHaveBeenCalled()
    if (kind.startsWith('native-')) expect(f.credential).not.toHaveBeenCalled()
  })
  it('checks capability after the final async metadata recheck microtask, immediately before dispatch', async () => {
    const f = setup(),
      plan = await f.prepare()
    f.read.mockImplementation(async () => {
      if (f.credential.mock.calls.length) queueMicrotask(() => queueMicrotask(f.loseContext))
      return structuredClone(f.current)
    })
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toEqual({
      status: 'cancelled'
    })
    expect(f.request).not.toHaveBeenCalled()
  })
  it('does not dispatch if a synchronous private guard reenters lifecycle invalidation', async () => {
    const f = setup(),
      plan = await f.prepare()
    f.assertIdle.mockImplementation(() => {
      if (f.credential.mock.calls.length) f.service.invalidate()
    })
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toEqual({
      status: 'cancelled'
    })
    expect(f.request).not.toHaveBeenCalled()
  })
  it('rechecks silent renderer loss caused by the final idle guard before dispatching GET', async () => {
    const f = setup(),
      plan = await f.prepare(),
      liveAtDispatch: boolean[] = []
    let afterCredentialReadChecks = 0
    f.assertIdle.mockImplementation(() => {
      if (f.read.mock.calls.length === 4 && ++afterCredentialReadChecks === 2) f.loseContext()
    })
    f.request.mockImplementation(async () => {
      liveAtDispatch.push(f.contextIsLive())
      return response([row()])
    })
    expect(await f.service.execute({ evidenceId: plan.evidenceId })).toEqual({
      status: 'cancelled'
    })
    expect(liveAtDispatch).toEqual([])
    expect(f.request).not.toHaveBeenCalled()
  })
  it.each(['', 'short', 'PRIVATE space', 'PRIVATE\nheader', 'PRIVATE-中文'])(
    'rejects an unavailable or malformed saved Token without anonymous fallback',
    async (secret) => {
      const f = setup(),
        plan = await f.prepare()
      f.credential.mockResolvedValueOnce({ account: structuredClone(f.current), secret })
      await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('读取未确认')
      expect(f.request).not.toHaveBeenCalled()
    }
  )
  it('sanitizes request failure and never retries a failed read', async () => {
    const f = setup(),
      plan = await f.prepare()
    f.request.mockRejectedValueOnce(new Error('PRIVATE-token-and-response'))
    await expect(f.service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow(
      '运行Gist候选读取未确认；请核对账号、权限及代理，不会自动重试。'
    )
    expect(f.request).toHaveBeenCalledOnce()
  })
  it.each(['expired', 'backward', 'native-expired'])(
    'does not use an %s single-page permission',
    async (kind) => {
      const f = setup(),
        plan = await f.prepare()
      if (kind === 'expired') f.advance(60000)
      if (kind === 'backward') f.advance(-1)
      if (kind === 'native-expired')
        f.confirm.mockImplementationOnce(async () => {
          f.advance(60000)
          return true
        })
      expect(await f.service.execute({ evidenceId: plan.evidenceId })).toEqual({
        status: 'cancelled'
      })
      expect(f.credential).not.toHaveBeenCalled()
      expect(f.request).not.toHaveBeenCalled()
    }
  )
  it('rejects modified execute fields and an old cancel without revoking a newer cloned plan', async () => {
    const f = setup(),
      old = await f.prepare(),
      plan = await f.prepare(2)
    expect(f.service.cancel({ evidenceId: old.evidenceId })).toBe(false)
    await expect(f.service.execute({ evidenceId: plan.evidenceId, page: 1000 })).rejects.toThrow(
      '凭据无效'
    )
    plan.endpoint = 'https://evil.invalid/PRIVATE'
    expect((await f.service.execute({ evidenceId: plan.evidenceId })).status).toBe('listed')
    expect(f.request.mock.calls[0][0]).toBe('https://api.github.com/gists?per_page=100&page=2')
  })
  it.each(['native', 'response'] as const)(
    'keeps busy and waiters until cancelled held %s work actually settles',
    async (phase) => {
      const f = setup(),
        plan = await f.prepare(),
        native = Promise.withResolvers<boolean>(),
        remote = Promise.withResolvers<PluginResponse>()
      if (phase === 'native') f.confirm.mockReturnValueOnce(native.promise)
      else f.request.mockReturnValueOnce(remote.promise)
      const work = f.service.execute({ evidenceId: plan.evidenceId })
      await vi.waitFor(() =>
        expect(phase === 'native' ? f.confirm : f.request).toHaveBeenCalledOnce()
      )
      expect(f.service.cancel({ evidenceId: plan.evidenceId })).toBe(true)
      let idle = false
      const wait = f.service.whenIdle().then(() => {
        idle = true
      })
      await Promise.resolve()
      expect(f.service.isBusy()).toBe(true)
      expect(idle).toBe(false)
      await expect(f.prepare()).rejects.toThrow('请等待')
      if (phase === 'native') native.resolve(true)
      else {
        expect(f.request.mock.calls[0][1].signal?.aborted).toBe(true)
        remote.resolve(response([row()]))
      }
      expect(await work).toEqual({ status: 'cancelled' })
      await wait
      expect(idle).toBe(true)
      expect(f.service.isBusy()).toBe(false)
      expect(f.request).toHaveBeenCalledTimes(phase === 'native' ? 0 : 1)
    }
  )
  it.each(['context', 'account', 'invalidate'] as const)(
    'does not expose a late response after %s loss',
    async (kind) => {
      const f = setup(),
        plan = await f.prepare(),
        held = Promise.withResolvers<PluginResponse>()
      f.request.mockReturnValueOnce(held.promise)
      const work = f.service.execute({ evidenceId: plan.evidenceId })
      await vi.waitFor(() => expect(f.request).toHaveBeenCalledOnce())
      if (kind === 'context') f.loseContext()
      if (kind === 'account') f.current.revision = 'b'.repeat(64)
      if (kind === 'invalidate') f.service.invalidate()
      held.resolve(response([row()]))
      expect(await work).toEqual({ status: 'cancelled' })
      expect(f.request).toHaveBeenCalledOnce()
    }
  )
})
