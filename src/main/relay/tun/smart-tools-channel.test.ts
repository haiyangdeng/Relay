import { describe, expect, it } from 'vitest'
import { createTunSmartToolsChannel } from './smart-tools-channel'
import type { TunAssetIdentity } from './asset-channel'
const identity: TunAssetIdentity = {
  sessionId: '11111111-2222-3333-4444-555555555555',
  evidenceSHA256: 'a'.repeat(64),
  runtimeConfigurationSHA256: 'b'.repeat(64),
  launchClientSHA256: 'c'.repeat(64),
  installationRevision: 'd'.repeat(64)
}
const { launchClientSHA256: _client, installationRevision: _installation, ...binding } = identity
const definition = {
  configurationRevision: binding.runtimeConfigurationSHA256,
  groups: ['Smart % / 中文']
}
const weights = {
  version: 1,
  kind: 'weights',
  configurationRevision: definition.configurationRevision,
  groups: [
    { name: definition.groups[0], status: 'ready', weights: [{ Name: 'n', Rank: '', Weight: 0 }] }
  ]
}
const acceptance = {
  version: 1,
  kind: 'clear-cache',
  configurationRevision: definition.configurationRevision,
  accepted: true
}
function fixture(
  onWrite?: (frame: Record<string, unknown>, send: (reply: object) => void) => void
) {
  let data = (_: Buffer): void => {},
    gone = (): void => {},
    fault = (): void => {},
    closed = 0
  const sent: Record<string, unknown>[] = []
  const emit = (reply: object): void =>
    data(Buffer.from(JSON.stringify({ ...binding, version: 1, ...reply }) + '\n'))
  const channel = createTunSmartToolsChannel(
    {
      write(frame) {
        const raw = JSON.parse(frame) as Record<string, unknown>
        sent.push(raw)
        if (onWrite) onWrite(raw, emit)
        else
          emit({
            id: raw.id,
            action: raw.action,
            status: raw.action === 'weights' ? 'weights' : 'accepted',
            pending: false,
            snapshot: raw.action === 'weights' ? weights : acceptance
          })
      },
      onData: (fn) => {
        data = fn
      },
      onGone: (fn) => {
        gone = fn
      },
      onFault: (fn) => {
        fault = fn
      },
      close: () => {
        ++closed
      }
    },
    identity,
    definition,
    1000
  )
  emit({
    kind: 'hello',
    capability: 'runtime-smart-tools-v1',
    launchClientSHA256: identity.launchClientSHA256,
    installationRevision: identity.installationRevision
  })
  return { channel, sent, emit, gone: () => gone(), fault: () => fault(), closed: () => closed }
}
describe('independent fixed Smart tools pipe', () => {
  it('uses the separate capability and exact typed read/accepted aliases', async () => {
    const f = fixture()
    expect((await f.channel.weights(new AbortController().signal, () => {})).status).toBe(
      'snapshot'
    )
    expect((await f.channel.clearCache(new AbortController().signal, () => {})).status).toBe(
      'updated'
    )
    expect(f.sent.map((frame) => frame.action)).toEqual(['weights', 'clear-cache'])
    expect(Object.keys(f.sent[1]).sort()).toEqual(
      [
        'version',
        'id',
        'action',
        'sessionId',
        'evidenceSHA256',
        'runtimeConfigurationSHA256'
      ].sort()
    )
    f.channel.invalidate()
  })
  it('refuses valid-looking snapshots from another loaded configuration', async () => {
    const f = fixture((raw, emit) =>
      emit({
        id: raw.id,
        action: raw.action,
        status: 'weights',
        pending: false,
        snapshot: { ...weights, configurationRevision: 'e'.repeat(64) }
      })
    )
    expect((await f.channel.weights(new AbortController().signal, () => {})).status).not.toBe(
      'snapshot'
    )
    expect(f.closed()).toBe(1)
  })
  it('does not accept old asset/state status aliases on the new authority', async () => {
    const f = fixture((raw, emit) =>
      emit({
        id: raw.id,
        action: raw.action,
        status: 'updated',
        pending: false,
        snapshot: acceptance
      })
    )
    expect((await f.channel.clearCache(new AbortController().signal, () => {})).status).toBe(
      'uncertain'
    )
    expect(f.sent.filter((frame) => frame.action === 'clear-cache')).toHaveLength(1)
  })
  it('keeps write loss uncertain without replay and closes only delegated IO', async () => {
    let released!: () => void
    const wrote = new Promise<void>((resolve) => {
      released = resolve
    })
    const f = fixture((raw) => {
      if (raw.action === 'clear-cache') released()
    })
    const result = f.channel.clearCache(new AbortController().signal, () => {})
    await wrote
    f.gone()
    expect((await result).status).toBe('uncertain')
    expect(f.sent.filter((frame) => frame.action === 'clear-cache')).toHaveLength(1)
    expect(f.closed()).toBe(1)
  })
  it('cancels before the first write without submitting a clear', async () => {
    const f = fixture(),
      abort = new AbortController()
    abort.abort()
    expect((await f.channel.clearCache(abort.signal, () => {})).status).toBe('cancelled')
    expect(f.sent).toEqual([])
    f.channel.invalidate()
  })
})
