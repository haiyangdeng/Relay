import type { RelayObservation, RelayReadOnlyReport } from '../../shared/relay/protocol'
import type { LocalProxyState } from '../../shared/relay/local-proxy'
import type { AiClientAssociation } from '../../shared/relay/ai-clients'
import { localProxyPortsFor } from '../../shared/relay/local-proxy-ports'
import {
  diagnosticBinding,
  type DiagnosticBinding,
  type OwnedDiagnosticObservation,
  type OwnedDiagnosticPorts,
  type OwnedNativeDiagnostic
} from '../../shared/relay/diagnostic-evidence'
import { dedicatedListenersCompatible } from '../../shared/relay/dedicated-listeners'
import type { RelayGuardReadiness } from '../../shared/relay/guard'
import { controlledListeners, validateDedicatedRoute } from './core/dedicated-listeners'
import { ownsHttpListener } from './core/port'
import type { createLocalProxyService } from './core/local-proxy-service'

type Live = Awaited<ReturnType<ReturnType<typeof createLocalProxyService>['inspectLive']>>
const leafTypes = new Set([
  'shadowsocks',
  'shadowsocksr',
  'snell',
  'socks5',
  'http',
  'vmess',
  'vless',
  'trojan',
  'hysteria',
  'hysteria2',
  'tuic',
  'wireguard',
  'ssh',
  'anytls',
  'mieru'
])
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function createOwnedDiagnosticBinding(
  state: LocalProxyState,
  live: Live,
  native: OwnedNativeDiagnostic | undefined,
  architecture: string = process.arch
): DiagnosticBinding | undefined {
  if (
    !live ||
    !native ||
    !state.configurationRevision ||
    !live.coreSHA256 ||
    native.appBuild === 'unpackaged' ||
    native.appVersion === 'unpackaged'
  )
    return undefined
  return diagnosticBinding({
    architecture,
    appVersion: native.appVersion,
    appBuild: native.appBuild,
    coreSHA256: live.coreSHA256,
    configurationRevision: state.configurationRevision
  })
}

export function createOwnedDiagnosticService(adapters: {
  state(): LocalProxyState
  live(): Promise<Live>
  association(): Promise<AiClientAssociation>
  clients(ports: OwnedDiagnosticPorts): Promise<RelayReadOnlyReport>
  guard(): Promise<RelayGuardReadiness>
  evidence(): Promise<Pick<OwnedDiagnosticObservation['external'], 'status' | 'record'>>
  listener?(pid: number, port: number): Promise<boolean>
  now?(): number
  architecture?: string
}) {
  return {
    async observe(): Promise<Pick<RelayObservation, 'parameters' | 'report' | 'owned'>> {
      const before = adapters.state()
      const identity = (state: LocalProxyState): string =>
        JSON.stringify([
          state.phase,
          state.pending,
          state.owned,
          state.uncertain,
          state.traffic,
          state.instanceId,
          state.pid,
          state.configurationRevision,
          state.httpPort,
          state.ports,
          state.dedicated
        ])
      const active =
        before.owned &&
        before.phase === 'running' &&
        before.traffic === 'listening' &&
        !before.pending &&
        !before.uncertain &&
        !!before.pid &&
        !!before.configurationRevision
      let live: Live
      try {
        live = active ? await adapters.live() : undefined
      } catch {
        live = undefined
      }
      const running = !!live && live.instanceId === before.instanceId
      const pid = before.pid
      const ordinary =
        running && before.httpPort ? localProxyPortsFor(before.httpPort, before.ports) : undefined
      const ports: OwnedDiagnosticPorts = {
        systemHTTPPort: ordinary ? ordinary.http || ordinary.mixed : null,
        systemSOCKSPort: ordinary ? ordinary.socks || ordinary.mixed || null : null,
        codeHTTPPort: running ? (before.dedicated?.httpPort ?? null) : null,
        dedicatedSOCKSPort: running ? (before.dedicated?.socksPort ?? null) : null
      }
      const [native, associated, external, guard, ordinaryLive] = await Promise.all([
        adapters.clients(ports),
        adapters.association(),
        adapters.evidence(),
        adapters.guard().catch(() => undefined),
        running && pid && ports.systemHTTPPort
          ? Promise.all(
              [
                ...new Set(
                  [ports.systemHTTPPort, ports.systemSOCKSPort].filter(
                    (port): port is number => port !== null
                  )
                )
              ].map((port) => (adapters.listener ?? ownsHttpListener)(pid, port).catch(() => false))
            ).then((results) => results.every(Boolean))
          : false
      ])
      if (identity(adapters.state()) !== identity(before))
        throw new Error('检测期间 Relay 实例或配置已变化，请重新检测。')
      const report = structuredClone(native)
      delete report.owned
      const snapshot = report.snapshot
      const associationMatches =
        running &&
        associated.owned.running &&
        associated.owned.instanceId === before.instanceId &&
        associated.owned.configurationRevision === before.configurationRevision &&
        associated.owned.pid === before.pid &&
        dedicatedListenersCompatible(associated.owned.dedicated, before.dedicated)
      const httpLive = associationMatches && associated.owned.httpLive
      const socksLive = associationMatches && associated.owned.socksLive
      snapshot.httpReady = httpLive
      snapshot.socksReady = socksLive
      snapshot.systemProxy = snapshot.systemProxy && ordinaryLive
      snapshot.cliConfigured = snapshot.cliConfigured && httpLive
      snapshot.controllerConnected = running
      const liveProxies = live && object(live.proxies.proxies) ? live.proxies.proxies : {}
      snapshot.proxyTypes = Object.fromEntries(
        Object.entries(liveProxies).flatMap(([name, value]) =>
          object(value) && typeof value.type === 'string' ? [[name, value.type]] : []
        )
      )
      snapshot.nodeNames = Object.entries(snapshot.proxyTypes)
        .filter(([, type]) => leafTypes.has(type.toLowerCase()))
        .map(([name]) => name)
        .sort()
      let fixed = false
      try {
        if (live && before.dedicated) {
          const listeners = controlledListeners(live.runtime.listeners)
          validateDedicatedRoute(before.dedicated, live.runtime)
          fixed =
            dedicatedListenersCompatible(listeners, before.dedicated) &&
            snapshot.nodeNames.includes(before.dedicated.route) &&
            (!before.dedicated.httpPort || httpLive) &&
            (!before.dedicated.socksPort || socksLive)
        }
      } catch {
        fixed = false
      }
      const update = (id: string, values: Partial<RelayReadOnlyReport['checks'][number]>): void => {
        const row = report.checks.find((check) => check.id === id)
        if (row) Object.assign(row, values)
      }
      const config = (good: boolean): 'verifiedConfiguration' | 'attention' =>
        good ? 'verifiedConfiguration' : 'attention'
      update('ports', {
        state: config(ordinaryLive && !!before.dedicated && fixed),
        value: `普通 HTTP/混合 ${ports.systemHTTPPort ?? '未运行'}：${ordinaryLive ? '归属已核对' : '未确认'}；专用 HTTP ${ports.codeHTTPPort ?? '未启用'}：${httpLive ? '归属已核对' : '未确认'}；专用 SOCKS ${ports.dedicatedSOCKSPort ?? '未启用'}：${socksLive ? '归属已核对' : '未确认'}`,
        evidence:
          '读取本次 Relay 核心控制接口，并核对监听所属进程；没有连接其他软件的端口或发送外部探针。',
        nextStep: '入口归属与监听不代表远端连通、DNS 无泄漏或客户端请求成功。'
      })
      update('clients', {
        state: config(snapshot.systemProxy && snapshot.cliConfigured && snapshot.browserIntegrated),
        value: `系统普通代理 ${ports.systemHTTPPort ?? '未运行'}：${snapshot.systemProxy ? '匹配' : '未匹配'}；Code 专用 HTTP ${ports.codeHTTPPort ?? '未启用'}：${snapshot.cliConfigured ? '匹配' : '未匹配'}；BROWSER：${snapshot.browserIntegrated ? '匹配' : '未匹配'}`,
        evidence:
          '系统 HTTP/HTTPS 与启用的 SOCKS 分别核对普通监听；Code 四变量核对专用 HTTP。仅检查配置，不证明在用客户端已加载。',
        nextStep: '桌面业务流量使用普通系统代理；专用 Code/浏览器的固定出口不能代替桌面请求验收。'
      })
      update('routing', {
        state: config(fixed),
        title: 'AI 专用监听固定路由',
        value: fixed
          ? `专用监听 → ${before.dedicated?.route}；具体节点与监听归属已核对`
          : '固定节点或专用监听尚未完整确认',
        evidence:
          '核对本次受控运行配置的监听、具体节点与核心实际节点目录；未将普通规则的域名数量当作专用出口证明。',
        nextStep: '只覆盖进入这些专用监听的流量；断线行为仍需独立测试，不代表系统级禁止直连。'
      })
      update('dns-policy', {
        state: 'pending',
        title: '当前 Relay DNS 配置',
        value:
          running && before.resolution
            ? `模式 ${before.resolution.mode}；已配置策略 ${before.resolution.policies} 条；实际解析出口未由配置证明`
            : '当前 DNS 配置未完整确认',
        evidence: '读取本次核心的 DNS 配置摘要；策略条数、开启 DNS 或浏览器限制均不能证明无泄漏。',
        nextStep: '参看对应浏览器的外部探针记录及其覆盖范围；本按钮不进行 DNS 泄漏测试。'
      })
      if (!socksLive || ports.dedicatedSOCKSPort !== 17890)
        update('browser-config', {
          state: 'attention',
          nextStep:
            'Edge 策略使用 SOCKS 17890，当前未确认它是本次专用入口；Chrome 与 Edge 需分别验收。'
        })
      const unavailable =
        guard?.extensionComponent.presence === 'missing' ||
        guard?.extensionComponent.presence === 'notBundled'
      update('guard', {
        title: '系统级禁止直连保护',
        state: 'pending',
        value: unavailable ? '当前安装包未提供系统级防直连组件' : '系统级防直连未确认启用或未验收',
        evidence: '保护构建检查与专用监听隔离测试是不同证据；隔离测试通过不代表系统过滤器已部署。',
        nextStep: '本次不安装或授权系统过滤器，也不将其他应用的保护归属给 Relay。'
      })
      for (const id of ['callback', 'request'])
        update(id, { state: 'pending', value: '未测试（本轮不登录账号、不发送账号请求）' })
      snapshot.summary = running
        ? '已读取当前 Relay 实例；配置核对与历史外部实测分开显示。'
        : '当前 Relay 核心未运行或状态未确认；没有改读其他软件。'
      snapshot.checkedAt = new Date((adapters.now ?? Date.now)()).toISOString()
      snapshot.details = []
      report.warnings = [
        '本按钮只读核对 Relay 当前配置，不访问 Clash 遗留配置，不发送外部请求。',
        '外部探针与隔离测试均有时间和范围限制；不证明全协议无泄漏、系统级防直连或账号请求成功。'
      ]
      const binding = running
        ? createOwnedDiagnosticBinding(before, live, native.owned, adapters.architecture)
        : undefined
      const record = external.record
      const bindingMatches =
        !!binding &&
        !!record &&
        Date.parse(record.recordedAt) <= (adapters.now ?? Date.now)() &&
        JSON.stringify(binding) === JSON.stringify(record.binding)
      const browserMatches =
        record?.tests.map(
          (test) =>
            test.browser === null ||
            native.owned?.browsers.some(
              (browser) => JSON.stringify(browser) === JSON.stringify(test.browser)
            ) === true
        ) ?? []
      return {
        parameters: {
          httpPort: ports.codeHTTPPort ?? 17891,
          node: before.dedicated?.route ?? 'Relay 当前实例',
          internalExceptions: ''
        },
        report,
        owned: {
          ports,
          running,
          ...(fixed ? { route: before.dedicated?.route } : {}),
          ...(binding ? { binding } : {}),
          external: { ...external, bindingMatches, browserMatches }
        }
      }
    }
  }
}
