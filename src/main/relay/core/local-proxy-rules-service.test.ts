import { describe, expect, it, vi } from 'vitest'
import { profileRuntimeSource } from '../__fixtures__/profile-runtime'
import { inspectProfile } from '../profiles/inspect'
import { profileHash } from '../profiles/source'
import type {
  LocalProxyRulesSnapshot,
  LocalProxyRuleConfirmation
} from '../../../shared/relay/local-proxy'
import type { OwnedCoreRequestGuards, RelayOwnedCore } from './owned-runtime'
import type { CoreStoreLease, CoreStoreSnapshot } from './store'
import { createLocalProxyService } from './local-proxy-service'
import { localProxyConfiguration } from './local-proxy-runtime'

function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing synthetic fixture value')
  return value
}

function fixture() {
  let live = true,
    port = 18191,
    pid = 1234,
    mode = 'rule',
    version = 'v1.19.33'
  const rules: {
    index: number
    type: string
    payload: string
    proxy: string
    size: number
    extra?: { disabled: boolean; hitCount?: number; missCount?: number }
  }[] = [
    {
      index: 0,
      type: 'DomainSuffix',
      payload: 'fixture.invalid',
      proxy: 'REJECT',
      size: -1,
      extra: { disabled: false, hitCount: 0 }
    },
    { index: 1, type: 'Match', payload: '', proxy: 'REJECT', size: -1, extra: { disabled: false } }
  ]
  const summary = inspectProfile(profileRuntimeSource).summary
  if (!summary) throw new Error('fixture summary')
  const selection = {
      id: '11111111-1111-4111-8111-111111111111',
      sha256: profileHash(profileRuntimeSource)
    },
    stored = {
      profile: { ...selection, name: 'Synthetic', createdAt: '2026-11-01', summary },
      text: profileRuntimeSource,
      revision: 'a'.repeat(64)
    }
  const read = vi.fn(
    async (
      endpoint: Parameters<RelayOwnedCore['read']>[0],
      guards?: OwnedCoreRequestGuards
    ): Promise<Record<string, unknown>> => {
      guards?.assertLive()
      if (endpoint === 'configs')
        return {
          ...JSON.parse(localProxyConfiguration(profileRuntimeSource, 18191).configuration),
          port,
          mode
        }
      if (endpoint === 'version') return { version }
      if (endpoint === 'rules') return { rules: structuredClone(rules) }
      return { proxies: { Group: { type: 'Selector', now: 'Node', all: ['Node', 'DIRECT'] } } }
    }
  )
  const patchRule = vi.fn(
      async (index: number, disabled: boolean, guards: OwnedCoreRequestGuards) => {
        guards.assertLive()
        guards.submitted?.()
        present(rules[index].extra).disabled = disabled
      }
    ),
    stop = vi.fn(async () => {}),
    update = vi.fn(async () => {}),
    release = vi.fn(async () => {})
  const session: RelayOwnedCore = {
    get pid() {
      return pid
    },
    version: 'v1.19.33',
    directory: '/fixture',
    socket: '/fixture/api.sock',
    state: () => 'running',
    read,
    patchRule,
    group: async () => ({}),
    select: async () => {},
    stop
  }
  const adapters = {
    read: vi.fn(async () => structuredClone(stored)),
    inspect: vi.fn(async (): Promise<CoreStoreSnapshot> => ({
      mode: 'rule',
      revision: 'b'.repeat(64),
      lease: 'missing'
    })),
    resources: vi.fn(async () => ({
      executable: '/fixture/core',
      version: 'v1.19.33',
      architecture: 'arm64' as const,
      sha256: 'c'.repeat(64)
    })),
    portAvailable: vi.fn(async () => true),
    acquire: vi.fn(async (): Promise<CoreStoreLease> => ({ update, release })),
    start: vi.fn(async () => session),
    confirmStart: vi.fn(async () => true),
    confirmStop: vi.fn(async () => false),
    confirmRule: vi.fn(async (_report: LocalProxyRuleConfirmation) => true),
    ownsHttpListener: vi.fn(async () => true),
    onRuntimeChanged: vi.fn()
  }
  const service = createLocalProxyService(adapters),
    context = () => {
      if (!live) throw new Error('context lost')
    }
  return {
    service,
    adapters,
    read,
    patchRule,
    rules,
    stop,
    update,
    selection,
    session,
    context,
    alive: (value: boolean) => {
      live = value
    },
    owner: (next: { port?: number; pid?: number; mode?: string; version?: string }) => {
      port = next.port ?? port
      pid = next.pid ?? pid
      mode = next.mode ?? mode
      version = next.version ?? version
    }
  }
}
async function ready(f: ReturnType<typeof fixture>): Promise<LocalProxyRulesSnapshot> {
  const plan = await f.service.prepare({ profile: f.selection, httpPort: 18191 })
  const started = await f.service.action({ action: 'start', evidenceId: plan.evidenceId })
  const result = await f.service.action(
    { action: 'rules', instanceId: started.state.instanceId },
    f.context
  )
  if (!result.rules) throw new Error('snapshot missing')
  f.read.mockClear()
  f.update.mockClear()
  return result.rules
}
const toggle = (snapshot: LocalProxyRulesSnapshot, disabled = true, index = 0) => ({
  action: 'rule',
  instanceId: snapshot.instanceId,
  configurationRevision: snapshot.configurationRevision,
  rulesSHA256: snapshot.rulesSHA256,
  index,
  disabled
})
describe('Owned localProxy temporary rule changes', () => {
  it('reports volatile counters without invalidating a later confirmed toggle', async () => {
    const f = fixture()
    present(f.rules[0].extra).missCount = 10
    const snapshot = await ready(f)
    expect(snapshot.rules[0].statistics).toEqual({ hitCount: 0, missCount: 10 })
    present(f.rules[0].extra).hitCount = 20
    const next = await f.service.action(
      { action: 'rules', instanceId: snapshot.instanceId },
      f.context
    )
    expect(next.rules?.rulesSHA256).toBe(snapshot.rulesSHA256)
    expect(next.rules?.rules[0].statistics).toEqual({ hitCount: 20, missCount: 10 })
    const changed = await f.service.action(toggle(snapshot), f.context)
    expect(changed.status).toBe('ruleChanged')
    expect(changed.rules?.rules[0].disabled).toBe(true)
    expect(changed.rules?.rules[0].statistics).toEqual({ hitCount: 20, missCount: 10 })
  })
  it('reads an immutable whole table without Native or writes, excluding counters from authority', async () => {
    const f = fixture(),
      snapshot = await ready(f)
    expect(snapshot.rules[0].disabled).toBe(false)
    expect(JSON.stringify(snapshot)).not.toContain('hitCount')
    expect(f.adapters.confirmRule).not.toHaveBeenCalled()
    expect(f.patchRule).not.toHaveBeenCalled()
    present(f.rules[0].extra).hitCount = 999
    const next = await f.service.action(
      { action: 'rules', instanceId: snapshot.instanceId },
      f.context
    )
    expect(next.rules).toEqual(snapshot)
    expect(present(f.rules[0].extra).disabled).toBe(false)
  })
  it('confirms one index, verifies the entire expected table, and can explicitly re-enable it', async () => {
    const f = fixture(),
      snapshot = await ready(f)
    const changed = await f.service.action(toggle(snapshot), f.context)
    expect(changed.status).toBe('ruleChanged')
    expect(changed.rules?.rules[0].disabled).toBe(true)
    expect(f.adapters.confirmRule.mock.calls[0][0]).toMatchObject({
      rule: { index: 0, disabled: false },
      disabled: true
    })
    expect(changed.rules?.configurationRevision).toBe(snapshot.configurationRevision)
    expect((await f.service.action(toggle(present(changed.rules), false), f.context)).status).toBe(
      'ruleChanged'
    )
    expect(f.patchRule).toHaveBeenCalledTimes(2)
    expect(f.stop).not.toHaveBeenCalled()
    expect(f.update).not.toHaveBeenCalled()
  })
  it('does not obtain consent or write when the observed target is already desired', async () => {
    const f = fixture(),
      snapshot = await ready(f)
    const result = await f.service.action(toggle(snapshot, false), f.context)
    expect(result.status).toBe('refreshed')
    expect(result.rules).toEqual(snapshot)
    expect(f.adapters.confirmRule).not.toHaveBeenCalled()
    expect(f.patchRule).not.toHaveBeenCalled()
  })
  it('defaults unavailable/cancelled Native confirmation to zero writes', async () => {
    const f = fixture(),
      snapshot = await ready(f)
    f.adapters.confirmRule.mockResolvedValue(false)
    expect((await f.service.action(toggle(snapshot), f.context)).status).toBe('cancelled')
    expect(f.patchRule).not.toHaveBeenCalled()
  })
  it('rejects a stale configuration before reads and a full-table drift before Native', async () => {
    const f = fixture(),
      snapshot = await ready(f)
    expect(
      (
        await f.service.action(
          { ...toggle(snapshot), configurationRevision: 'f'.repeat(64) },
          f.context
        )
      ).status
    ).toBe('cancelled')
    expect(f.read).not.toHaveBeenCalled()
    f.rules[1].payload = 'changed elsewhere'
    expect((await f.service.action(toggle(snapshot), f.context)).status).toBe('cancelled')
    expect(f.adapters.confirmRule).not.toHaveBeenCalled()
    expect(f.patchRule).not.toHaveBeenCalled()
  })
  it('keeps absent disabled metadata readable but never writable', async () => {
    const f = fixture()
    delete f.rules[0].extra
    const snapshot = await ready(f)
    expect(snapshot.rules[0]).not.toHaveProperty('disabled')
    expect((await f.service.action(toggle(snapshot), f.context)).status).toBe('cancelled')
    expect(f.adapters.confirmRule).not.toHaveBeenCalled()
    expect(f.patchRule).not.toHaveBeenCalled()
  })
  it('requires a private live context and rejects silent microtask context loss after Native', async () => {
    const f = fixture(),
      snapshot = await ready(f)
    expect((await f.service.action(toggle(snapshot))).status).toBe('cancelled')
    f.adapters.confirmRule.mockImplementation(async () => {
      queueMicrotask(() => f.alive(false))
      return true
    })
    expect((await f.service.action(toggle(snapshot), f.context)).status).toBe('cancelled')
    expect(f.patchRule).not.toHaveBeenCalled()
  })
  it.each([{ pid: 9999 }, { port: 18192 }, { version: 'changed' }, { mode: 'global' }])(
    'rechecks owner/config/version/port after Native: %j',
    async (owner) => {
      const f = fixture(),
        snapshot = await ready(f)
      f.adapters.confirmRule.mockImplementation(async () => {
        f.owner(owner)
        return true
      })
      expect((await f.service.action(toggle(snapshot), f.context)).status).toBe('cancelled')
      expect(f.patchRule).not.toHaveBeenCalled()
      expect(f.stop).not.toHaveBeenCalled()
    }
  )
  it('rechecks listener ownership and the entire table after Native', async () => {
    const f = fixture(),
      snapshot = await ready(f)
    f.adapters.confirmRule.mockImplementationOnce(async () => {
      f.adapters.ownsHttpListener.mockResolvedValue(false)
      return true
    })
    expect((await f.service.action(toggle(snapshot), f.context)).status).toBe('cancelled')
    f.adapters.ownsHttpListener.mockResolvedValue(true)
    f.adapters.confirmRule.mockImplementationOnce(async () => {
      present(f.rules[1].extra).disabled = true
      return true
    })
    expect((await f.service.action(toggle(snapshot), f.context)).status).toBe('cancelled')
    expect(f.patchRule).not.toHaveBeenCalled()
  })
  it.each(['unchanged', 'other-row'] as const)(
    'does not trust a successful PATCH acknowledgement: %s',
    async (behavior) => {
      const f = fixture(),
        snapshot = await ready(f)
      f.patchRule.mockImplementation(async (index, disabled, guards) => {
        guards.assertLive()
        guards.submitted?.()
        if (behavior === 'other-row') {
          present(f.rules[index].extra).disabled = disabled
          present(f.rules[1].extra).disabled = true
        }
      })
      const result = await f.service.action(toggle(snapshot), f.context)
      expect(result.status).toBe('unconfirmed')
      expect(result.rules).toBeUndefined()
      expect(f.patchRule).toHaveBeenCalledTimes(1)
      expect(f.stop).not.toHaveBeenCalled()
    }
  )
  it('reports a submitted failure without a follow-up GET, retry, rollback or stop', async () => {
    const f = fixture(),
      snapshot = await ready(f)
    let readsAtPatch = 0
    f.patchRule.mockImplementation(async (_index, _disabled, guards) => {
      guards.assertLive()
      guards.submitted?.()
      readsAtPatch = f.read.mock.calls.length
      throw new Error('unknown after dispatch')
    })
    const result = await f.service.action(toggle(snapshot), f.context)
    expect(result.status).toBe('unconfirmed')
    expect(f.read).toHaveBeenCalledTimes(readsAtPatch)
    expect(f.patchRule).toHaveBeenCalledTimes(1)
    expect(f.stop).not.toHaveBeenCalled()
  })
  it('keeps Native and submitted work busy until true settlement despite invalidation', async () => {
    const f = fixture(),
      snapshot = await ready(f),
      native = Promise.withResolvers<boolean>()
    f.adapters.confirmRule.mockImplementationOnce(() => native.promise)
    const pending = f.service.action(toggle(snapshot), f.context)
    await vi.waitFor(() => expect(f.adapters.confirmRule).toHaveBeenCalledOnce())
    let idle = false
    const waiting = f.service.whenIdle().then(() => {
      idle = true
    })
    f.service.invalidatePending()
    expect(f.service.state().pending).toBe(true)
    expect(idle).toBe(false)
    native.resolve(true)
    expect((await pending).status).toBe('cancelled')
    await waiting
    expect(f.patchRule).not.toHaveBeenCalled()
    const fresh = await f.service.action(
      { action: 'rules', instanceId: snapshot.instanceId },
      f.context
    )
    const wire = Promise.withResolvers<void>()
    f.patchRule.mockImplementationOnce(async (_index, _disabled, guards) => {
      guards.assertLive()
      guards.submitted?.()
      f.alive(false)
      await wire.promise
    })
    const submitted = f.service.action(toggle(present(fresh.rules)), f.context)
    await vi.waitFor(() => expect(f.patchRule).toHaveBeenCalledOnce())
    expect(f.service.state().pending).toBe(true)
    wire.resolve()
    expect((await submitted).status).toBe('unconfirmed')
    expect(f.service.state().pending).toBe(false)
  })
})
