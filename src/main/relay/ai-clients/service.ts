// AI client association service for the owned local proxy.
//
// This wires the three AI client configs to Relay's owned dedicated
// listeners:
//   - Claude Code (CLI): ~/.claude/settings.json env is written by the native
//     Code transaction. Here we only gate the chosen httpPort: it must be the
//     owned instance's live fixed-node dedicated HTTP listener,
//     otherwise we refuse to stage/apply the Code configuration. "SOCKS入口
//     不可用时拒绝启动" extended to the HTTP listener.
//   - Codex: reports the existence of ~/.codex/config.toml. Its network
//     protection is managed separately by Relay Guard.
//   - Claude Code browser: resolves the owned dedicated HTTP listener.
//     Desktop Edge login additionally requires the dedicated SOCKS 17890.
//     Both use Relay's authenticated binding channel, never an arbitrary port.
//
// The service performs no native, file or network mutation. All live checks
// reuse the owned child PID port-ownership probe.
import { ownsHttpListener } from '../core/port'
import type { LocalProxyState, LocalProxyPreparation } from '../../../shared/relay/local-proxy'
import type { DedicatedListenerSummary } from '../../../shared/relay/dedicated-listeners'
import type { AiClientAssociation } from '../../../shared/relay/ai-clients'
export type { AiClientAssociation } from '../../../shared/relay/ai-clients'

export function createAiClientService(adapters: {
  state(): LocalProxyState
  // Read-only existence probe for ~/.codex/config.toml.
  readCodexConfig?(): Promise<{ exists: boolean }>
  // Live port-ownership probe against the owned child PID. Defaults to the
  // lsof-backed implementation; tests inject a stub.
  liveListener?(pid: number, port: number): Promise<boolean>
}) {
  const liveListener = adapters.liveListener ?? ownsHttpListener
  const matches = (expected: LocalProxyState): boolean => {
    const current = adapters.state()
    return (
      current.owned &&
      !!current.instanceId &&
      !!current.configurationRevision &&
      !current.pending &&
      !current.uncertain &&
      current.phase === 'running' &&
      current.traffic === 'listening' &&
      current.pid === expected.pid &&
      current.instanceId === expected.instanceId &&
      current.configurationRevision === expected.configurationRevision &&
      current.httpPort === expected.httpPort &&
      JSON.stringify(current.dedicated) === JSON.stringify(expected.dedicated)
    )
  }
  const livePort = async (state: LocalProxyState, port: number | undefined): Promise<boolean> => {
    if (!port || !state.pid || !matches(state)) return false
    // The probe resolves to true only when the owned child PID owns the port;
    // a rejection (lsof unavailable or foreign pid) is treated as not-live.
    return (await liveListener(state.pid, port).catch(() => false)) && matches(state)
  }
  return {
    async inspect(request?: { claudeCodePort?: number }): Promise<AiClientAssociation> {
      const state = adapters.state()
      const dedicated = state.dedicated
      const running = matches(state) && !!state.pid
      const [httpLive, socksLive, codex] = await Promise.all([
        livePort(state, dedicated?.httpPort),
        livePort(state, dedicated?.socksPort),
        adapters.readCodexConfig?.().catch(() => ({ exists: false }))
      ])
      const requestedPort = request?.claudeCodePort
      const listenerLive = await (async () => {
        if (requestedPort === undefined) return false
        if (dedicated?.httpPort === requestedPort) return httpLive
        return false
      })()
      const warnings: string[] = []
      if (requestedPort !== undefined && !listenerLive)
        warnings.push(
          'Claude Code需要本次实例的指定节点专用HTTP入口；普通规则端口或其他软件端口不能用于此关联。'
        )
      if (!dedicated?.httpPort)
        warnings.push(
          '请在内核设置开启 AI 专用 HTTP 监听并选择具体节点；桌面 Edge 登录还需专用 SOCKS 17890。'
        )
      return {
        owned: {
          instanceId: state.instanceId,
          configurationRevision: state.configurationRevision,
          running: running && matches(state),
          pid: state.pid,
          httpPort: state.httpPort,
          dedicated,
          httpLive: httpLive && matches(state),
          socksLive: socksLive && matches(state)
        },
        claudeCode: {
          requestedPort,
          listenerLive: listenerLive && matches(state),
          refusesIfNotLive: true
        },
        codex: {
          configPath: '~/.codex/config.toml',
          exists: !!codex?.exists,
          neverWrites: true
        },
        browserProxy: {
          httpPort: dedicated?.httpPort,
          ownedLive: !!dedicated?.httpPort && httpLive && matches(state),
          note: 'Claude Code 的专用浏览器使用本次指定节点 HTTP 入口；桌面 Edge 登录另行核对专用 SOCKS 17890 与 Edge 策略。'
        },
        loopbackDirect: {
          containsLoopback: true,
          regression:
            '登录回调走127.0.0.1，由OS直接路由；客户端NO_PROXY合并始终包含127.0.0.1与localhost，专用监听不捕获回环。'
        },
        warnings
      }
    },
    // Gate used by the Code preparation/apply path. Throws when the requested
    // Claude Code httpPort is not a live owned entry, so the user is never
    // pointed at a listener that is not actually listening.
    async verifyClaudeCodePort(
      httpPort: number,
      expected?: LocalProxyState,
      route?: string
    ): Promise<void> {
      const state = adapters.state()
      if (state.phase !== 'running' || !state.pid || !matches(expected ?? state))
        throw new Error('请先明确启动本次自有HTTP代理实例。')
      const dedicated = state.dedicated
      const isDedicated = dedicated?.httpPort === httpPort
      if (!isDedicated) throw new Error('请求关联的Claude Code端口不属于本次指定节点专用HTTP监听。')
      if (route !== undefined && route !== dedicated?.route)
        throw new Error('Claude Code节点与本次专用监听不一致，请使用当前指定节点。')
      if (!(await livePort(state, httpPort)))
        throw new Error('关联的监听入口当前未监听；不写入Code配置，请重新启动或选择可用入口。')
    },
    async ownedBrowserBinding(): Promise<{
      instanceId: string
      configurationRevision: string
      pid: number
      httpPort: number
      socksPort?: number
      route: string
    }> {
      const state = adapters.state()
      const dedicated = state.dedicated
      if (
        !state.instanceId ||
        !state.configurationRevision ||
        !state.pid ||
        !dedicated?.httpPort ||
        !matches(state) ||
        !(await livePort(state, dedicated.httpPort))
      )
        throw new Error('Relay指定节点HTTP入口未就绪；未使用其他软件或直连。')
      const socksLive = await livePort(state, dedicated.socksPort)
      if (!matches(state)) throw new Error('Relay代理实例已变化，请重新启动专用浏览器。')
      return {
        instanceId: state.instanceId,
        configurationRevision: state.configurationRevision,
        pid: state.pid,
        httpPort: dedicated.httpPort,
        ...(socksLive ? { socksPort: dedicated.socksPort } : {}),
        route: dedicated.route
      }
    }
  }
}

// Helper for tests/IPC: derive the association from a freshly prepared
// LocalProxyPreparation (before the core is running) — used so the renderer can
// show which listener the Code config will be associated with once started.
export function preparedAssociation(preparation: LocalProxyPreparation): {
  dedicated: DedicatedListenerSummary | undefined
  httpPort: number
} {
  return { dedicated: preparation.dedicated, httpPort: preparation.httpPort }
}
