import type { DedicatedListenerPlan } from './dedicated-listeners'

// Ordinary rule-based inbound ports. Zero disables an inbound. httpPort in the
// older protocol remains the HTTP-capable entry (HTTP, or mixed when HTTP is off).
export interface LocalProxyPorts {
  http: number
  socks: number
  mixed: number
  redir: number
}

function port(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    (value !== 0 && (value < 1024 || value > 65535))
  )
    throw new Error('监听端口须为 0（关闭）或 1024 到 65535 的整数。')
  return value
}

export function localProxyPorts(raw: unknown, fallbackHttpPort = 18191): LocalProxyPorts {
  if (raw === undefined) {
    const http = port(fallbackHttpPort)
    if (!http) throw new Error('请保留一个 HTTP 或混合端口。')
    return { http, socks: 0, mixed: 0, redir: 0 }
  }
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== 'http,mixed,redir,socks'
  )
    throw new Error('普通监听端口设置无效。')
  const value = raw as Record<string, unknown>
  const ports = {
    http: port(value.http),
    socks: port(value.socks),
    mixed: port(value.mixed),
    redir: port(value.redir)
  }
  if (!ports.http && !ports.mixed)
    throw new Error('Relay 的系统代理和管理请求需要保留至少一个 HTTP 或混合端口。')
  const enabled = enabledLocalProxyPorts(ports)
  if (new Set(enabled).size !== enabled.length) throw new Error('已启用的监听端口不能重复。')
  return ports
}

export function localProxyHTTPPort(ports: LocalProxyPorts): number {
  return ports.http || ports.mixed
}

export function localProxyPortsFor(httpPort: number, raw?: unknown): LocalProxyPorts {
  const ports = localProxyPorts(raw, httpPort)
  if (localProxyHTTPPort(ports) !== httpPort)
    throw new Error('HTTP 可用入口与普通监听端口设置不一致。')
  return ports
}

export function enabledLocalProxyPorts(ports: LocalProxyPorts): number[] {
  return [ports.http, ports.socks, ports.mixed, ports.redir].filter((value) => value > 0)
}

export function localProxyPortsMatch(
  config: Record<string, unknown>,
  ports: LocalProxyPorts
): boolean {
  return (
    config.port === ports.http &&
    config['socks-port'] === ports.socks &&
    config['mixed-port'] === ports.mixed &&
    config['redir-port'] === ports.redir
  )
}

export function localProxyPortsCompatible(a: LocalProxyPorts, b: LocalProxyPorts): boolean {
  return a.http === b.http && a.socks === b.socks && a.mixed === b.mixed && a.redir === b.redir
}

export function validateDedicatedPortConflicts(
  ports: LocalProxyPorts,
  dedicated: DedicatedListenerPlan | undefined
): void {
  if (!dedicated) return
  const ordinary = enabledLocalProxyPorts(ports)
  if ([dedicated.httpPort, dedicated.socksPort].some((value) => value && ordinary.includes(value)))
    throw new Error('AI 专用监听端口不能与普通监听端口重复。')
}
