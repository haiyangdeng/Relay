import { describe, expect, it, vi } from 'vitest'
import type { LocalProxyState, LocalProxyPreparation } from '../../../shared/relay/local-proxy'
import type { DedicatedListenerSummary } from '../../../shared/relay/dedicated-listeners'
import { createAiClientService, preparedAssociation } from './service'

function state(overrides: Partial<LocalProxyState> = {}): LocalProxyState {
  return {
    phase: 'running',
    pending: false,
    owned: true,
    instanceId: 'owned-instance',
    configurationRevision: 'owned-revision',
    hasRecord: true,
    uncertain: false,
    httpPort: 17800,
    pid: 4242,
    traffic: 'listening',
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: [],
    ...overrides
  }
}
const dedicated: DedicatedListenerSummary = {
  httpPort: 17891,
  socksPort: 17890,
  route: 'NodeA',
  httpName: 'relay-ai-http',
  socksName: 'relay-ai-socks'
}
const alwaysLive = vi.fn(async () => true)
const neverLive = vi.fn(async () => false)

describe('AI client association inspect', () => {
  it('reports live dedicated listeners when the port-ownership probe succeeds', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: alwaysLive
    })
    const report = await service.inspect({ claudeCodePort: 17891 })
    expect(report.owned.httpLive).toBe(true)
    expect(report.owned.socksLive).toBe(true)
    expect(report.claudeCode.listenerLive).toBe(true)
    expect(report.codex.neverWrites).toBe(true)
    expect(report.browserProxy.httpPort).toBe(17891)
    expect(report.browserProxy.ownedLive).toBe(true)
    expect(report.loopbackDirect.containsLoopback).toBe(true)
  })
  it('refuses Claude Code association to a port that is neither main nor dedicated', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: alwaysLive
    })
    const report = await service.inspect({ claudeCodePort: 9999 })
    expect(report.claudeCode.listenerLive).toBe(false)
    expect(report.claudeCode.refusesIfNotLive).toBe(true)
    expect(report.warnings.some((w) => w.includes('不能'))).toBe(true)
  })
  it('refuses the ordinary rule port as a fixed-node Claude Code association target', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: alwaysLive
    })
    const report = await service.inspect({ claudeCodePort: 17800 })
    expect(report.claudeCode.listenerLive).toBe(false)
  })
  it('marks a port not live when the probe reports it down', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: neverLive
    })
    const report = await service.inspect({ claudeCodePort: 17891 })
    expect(report.owned.httpLive).toBe(false)
    expect(report.claudeCode.listenerLive).toBe(false)
  })
  it('reports Codex as read-only and never writes its config', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: alwaysLive,
      readCodexConfig: async () => ({ exists: true })
    })
    const report = await service.inspect()
    expect(report.codex.exists).toBe(true)
    expect(report.codex.neverWrites).toBe(true)
  })
  it('warns when no dedicated HTTP listener is configured', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated: undefined }),
      liveListener: alwaysLive
    })
    const report = await service.inspect()
    expect(report.browserProxy.ownedLive).toBe(false)
    expect(report.warnings.some((w) => w.includes('AI 专用 HTTP'))).toBe(true)
  })
})

describe('Claude Code port gate', () => {
  it('throws when no owned instance is running', async () => {
    const service = createAiClientService({
      state: () => state({ phase: 'idle', pid: undefined, owned: false }),
      liveListener: alwaysLive
    })
    await expect(service.verifyClaudeCodePort(17891)).rejects.toThrow('请先明确启动')
  })
  it('throws for a foreign port', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: alwaysLive
    })
    await expect(service.verifyClaudeCodePort(9999)).rejects.toThrow('不属于')
  })
  it('throws when the listener is not live', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: neverLive
    })
    await expect(service.verifyClaudeCodePort(17891)).rejects.toThrow('当前未监听')
  })
  it('passes for the live dedicated HTTP listener', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: alwaysLive
    })
    await expect(service.verifyClaudeCodePort(17891)).resolves.toBeUndefined()
  })
  it('refuses a draft that names a different fixed node', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: alwaysLive
    })
    await expect(service.verifyClaudeCodePort(17891, undefined, 'AnotherNode')).rejects.toThrow(
      '节点与本次专用监听不一致'
    )
  })
  it('refuses an old prepared association after its owned instance has stopped', async () => {
    const expected = state({ dedicated, instanceId: 'prepared-instance' })
    const service = createAiClientService({
      state: () => state({ phase: 'idle', owned: false, pid: undefined }),
      liveListener: alwaysLive
    })
    await expect(service.verifyClaudeCodePort(17891, expected)).rejects.toThrow()
  })
  it('does not apply a successful port probe after the configuration changes in flight', async () => {
    let current = state({ dedicated, configurationRevision: 'before' })
    const service = createAiClientService({
      state: () => current,
      liveListener: async () => {
        current = state({ dedicated, configurationRevision: 'after' })
        return true
      }
    })
    await expect(service.verifyClaudeCodePort(17891)).rejects.toThrow('未监听')
  })
  it('refuses port ownership while an owned operation is pending or uncertain', async () => {
    for (const override of [{ pending: true }, { uncertain: true }, { owned: false }]) {
      const probe = vi.fn(async () => true)
      const service = createAiClientService({
        state: () => state({ dedicated, ...override }),
        liveListener: probe
      })
      await expect(service.verifyClaudeCodePort(17891)).rejects.toThrow()
      expect(probe).not.toHaveBeenCalled()
    }
  })
})

describe('browser binding', () => {
  it('returns only the verified owned fixed-node entry, allowing custom ports', async () => {
    const service = createAiClientService({
      state: () => state({ dedicated: { ...dedicated, httpPort: 18193, socksPort: 18190 } }),
      liveListener: alwaysLive
    })
    expect(await service.ownedBrowserBinding()).toMatchObject({
      instanceId: 'owned-instance',
      httpPort: 18193,
      socksPort: 18190,
      route: 'NodeA'
    })
  })
  it('rejects a missing dedicated entry even when a normal proxy is running', async () => {
    const service = createAiClientService({ state: () => state(), liveListener: alwaysLive })
    await expect(service.ownedBrowserBinding()).rejects.toThrow('未就绪')
  })
  it('omits SOCKS when 17890 is not owned by the current Relay core', async () => {
    const probe = vi.fn(async (_pid: number, port: number) => port !== 17890)
    const service = createAiClientService({
      state: () => state({ dedicated }),
      liveListener: probe
    })
    expect(await service.ownedBrowserBinding()).not.toHaveProperty('socksPort')
    expect(probe).toHaveBeenCalledWith(expect.any(Number), 17890)
  })
  it('does not publish another instance after ownership changes during the probe', async () => {
    let current = state({ dedicated })
    const service = createAiClientService({
      state: () => current,
      liveListener: async () => {
        current = state({ dedicated, instanceId: 'replacement' })
        return true
      }
    })
    await expect(service.ownedBrowserBinding()).rejects.toThrow('未就绪')
  })
  it('requires a complete runtime identity and a listening state', async () => {
    for (const override of [
      { instanceId: undefined },
      { configurationRevision: undefined },
      { traffic: 'inactive' as const }
    ]) {
      const service = createAiClientService({
        state: () => state({ dedicated, ...override }),
        liveListener: alwaysLive
      })
      await expect(service.ownedBrowserBinding()).rejects.toThrow('未就绪')
    }
  })
})

describe('prepared association helper', () => {
  it('surfaces the dedicated plan and main port from a preparation', () => {
    const preparation = {
      httpPort: 17800,
      dedicated
    } as unknown as LocalProxyPreparation
    expect(preparedAssociation(preparation)).toEqual({ dedicated, httpPort: 17800 })
  })
})
