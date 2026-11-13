import { describe, expect, it, vi } from 'vitest'
import { defaultEditDocument } from '../../../../shared/relay/configuration-edit'
import { createProfileReadQueue, relayProfileRead } from './profile-read-queue'

const selection = { id: '3f7b5f86-d792-467c-b49f-567554b7d727', sha256: 'a'.repeat(64) }
function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('shared profile read queue', () => {
  it('holds source and saved-rule readers until an in-flight TUN preview finishes', async () => {
    const gate = deferred()
    const invoke = vi.fn(async (channel: string) =>
      channel === 'relayConfigEditPreview' ? gate.promise : { channel }
    )
    const read = createProfileReadQueue(invoke)
    const preview = read('relayConfigEditPreview', { ...defaultEditDocument(), profile: selection })
    const sources = read('relaySourceList')
    const rules = read('relayProfileRulesRead', selection)
    await Promise.resolve()
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['relayConfigEditPreview'])
    gate.resolve({ configuration: {}, order: [], dns: {} })
    await preview
    await sources
    await rules
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayConfigEditPreview',
      'relaySourceList',
      'relayProfileRulesRead'
    ])
  })

  it('releases a failed preview once without retrying it or blocking the next page', async () => {
    const gate = deferred(),
      failure = new Error('preview rejected')
    const invoke = vi.fn(async (channel: string) =>
      channel === 'relayConfigEditPreview' ? gate.promise : { sources: [] }
    )
    const read = createProfileReadQueue(invoke)
    const preview = read('relayConfigEditPreview', { ...defaultEditDocument(), profile: selection })
    const rejected = expect(preview).rejects.toBe(failure)
    const sources = read('relaySourceList')
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledTimes(1)
    gate.reject(failure)
    await rejected
    expect(await sources).toEqual({ sources: [] })
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'relayConfigEditPreview',
      'relaySourceList'
    ])
  })

  it('deeply pins and validates the preview profile and document before it waits in the queue', async () => {
    const gate = deferred()
    const invoke = vi
      .fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({ configuration: {}, order: [], dns: {} })
    const read = createProfileReadQueue(invoke)
    const first = read('relayProfileList')
    const request = {
      ...defaultEditDocument(),
      profile: { ...selection },
      globalOverrides: [{ id: 'test', kind: 'yaml' as const, content: 'mode: rule' }],
      controlled: { dns: { nameserver: ['tls://1.1.1.1'] } }
    }
    const expected = structuredClone(request)
    const next = read('relayConfigEditPreview', request)
    request.profile.sha256 = 'b'.repeat(64)
    request.globalOverrides[0].content = 'mode: direct'
    request.controlled.dns.nameserver[0] = 'tls://8.8.8.8'
    await expect(
      Reflect.apply(read, undefined, [
        'relayConfigEditPreview',
        {
          ...request,
          profile: { ...selection, sha256: 'invalid' }
        }
      ])
    ).rejects.toThrow()
    await expect(
      Reflect.apply(read, undefined, [
        'relayConfigEditPreview',
        {
          ...request,
          unexpected: true
        }
      ])
    ).rejects.toThrow()
    await expect(Reflect.apply(read, undefined, ['relayConfigEditSave', request])).rejects.toThrow(
      '仅接受'
    )
    gate.resolve({ profiles: [] })
    await first
    await next
    expect(invoke.mock.calls).toEqual([['relayProfileList'], ['relayConfigEditPreview', expected]])
    expect(request.controlled.dns.nameserver).toEqual(['tls://8.8.8.8'])
  })

  it('serializes concurrently mounted readers in arrival order, preserving their results', async () => {
    const gate = deferred(),
      calls: string[] = []
    let active = 0,
      maxActive = 0
    const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      calls.push(channel)
      maxActive = Math.max(maxActive, ++active)
      try {
        return calls.length === 1 ? await gate.promise : { channel }
      } finally {
        --active
      }
    })
    const read = createProfileReadQueue(invoke)
    const inventory = read('relayProfileList')
    const groups = read('relayProfileGroupsRead', selection)
    const sources = read('relaySourceList')
    await Promise.resolve()
    expect(calls).toEqual(['relayProfileList'])
    gate.resolve({ profiles: [] })
    expect(await inventory).toEqual({ profiles: [] })
    expect(await groups).toEqual({ channel: 'relayProfileGroupsRead' })
    expect(await sources).toEqual({ channel: 'relaySourceList' })
    expect(calls).toEqual(['relayProfileList', 'relayProfileGroupsRead', 'relaySourceList'])
    expect(maxActive).toBe(1)
  })

  it('continues after both rejected and synchronously throwing invocations without retries', async () => {
    const failure = new Error('Main read rejected')
    const invoke = vi
      .fn<(channel: string) => Promise<unknown>>()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => {
        throw failure
      })
      .mockResolvedValueOnce({ groups: [] })
    const read = createProfileReadQueue(invoke)
    const failed = read('relayProfileList'),
      thrown = read('relaySourceList')
    const continued = read('relayProfileGroupsRead', selection)
    await expect(failed).rejects.toBe(failure)
    await expect(thrown).rejects.toBe(failure)
    expect(await continued).toEqual({ groups: [] })
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('pins queued selection without mutating the caller and rejects non-read IPC commands', async () => {
    const gate = deferred()
    const invoke = vi
      .fn<(channel: string, ...args: unknown[]) => Promise<unknown>>()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({ groups: [] })
    const read = createProfileReadQueue(invoke)
    const first = read('relayProfileList')
    const target = { ...selection }
    const next = read('relayProfileGroupsRead', target)
    expect(target).toEqual(selection)
    target.sha256 = 'b'.repeat(64)
    const invalid = Reflect.apply(read, undefined, ['changeCurrentProfile', selection])
    await expect(invalid).rejects.toThrow('仅接受')
    await expect(
      Reflect.apply(read, undefined, ['relaySourceList', { url: 'https://example.invalid' }])
    ).rejects.toThrow('仅接受')
    gate.resolve({ profiles: [] })
    await first
    await next
    expect(invoke.mock.calls).toEqual([['relayProfileList'], ['relayProfileGroupsRead', selection]])
    expect(target.sha256).toBe('b'.repeat(64))
  })

  it('retains the exported singleton queue across callers and reads no window until invocation', async () => {
    const gate = deferred()
    const invoke = vi
      .fn()
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValue({ sources: [] })
    vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
    try {
      const dashboard = relayProfileRead('relayProfileList')
      const remountedPage = relayProfileRead('relaySourceList')
      await Promise.resolve()
      expect(invoke.mock.calls).toEqual([['relayProfileList']])
      gate.resolve({ profiles: [] })
      await dashboard
      await remountedPage
      expect(invoke.mock.calls).toEqual([['relayProfileList'], ['relaySourceList']])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
