// Dedicated listener plan for the owned local proxy core.
//
// The owned HTTP mixed port remains the main controlled entry. In addition,
// Relay can open dedicated HTTP/SOCKS listeners whose traffic is pinned to a
// single fixed proxy node (the AI client route). This is the structural peer
// of the old assistant's fixed SOCKS 17890 / HTTP 17891 entries: traffic that
// enters a dedicated listener is forced through the named node and never falls
// back to DIRECT or a shared group selection. P6 forbids treating a shared
// group's DIRECT selection as a fallback; here DIRECT is rejected outright and
// only concrete proxy nodes may be named as the route.
export interface DedicatedListenerPlan {
  // Dedicated HTTP listener port (e.g. 17891). Optional but at least one of
  // httpPort / socksPort is required.
  httpPort?: number
  // Dedicated SOCKS listener port (e.g. 17890).
  socksPort?: number
  // Fixed proxy node name. Must be a concrete node in the compiled catalogue;
  // DIRECT, REJECT, group names and unknown names are rejected.
  route: string
}

export interface DedicatedListenerSummary extends DedicatedListenerPlan {
  // Names Relay assigns; the runtime only accepts these exact entries.
  httpName: 'relay-ai-http'
  socksName: 'relay-ai-socks'
}

export const dedicatedListenerNames = ['relay-ai-http', 'relay-ai-socks'] as const
export type DedicatedListenerName = (typeof dedicatedListenerNames)[number]

const RESERVED = new Set(['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'GLOBAL'])

function portNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label}必须是整数。`)
  if (value < 1024 || value > 65535) throw new Error(`${label}必须在1024到65535之间。`)
  return value
}

function routeName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    // Reject control characters and the leading-dot / slash forms that would
    // leak a path or selector into the listener proxy field.
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0)
      return code < 32 || (code >= 127 && code <= 159)
    }) ||
    value.includes('/') ||
    value.startsWith('.')
  )
    throw new Error('专用监听路由必须是有效节点名称。')
  if (RESERVED.has(value)) throw new Error('专用监听路由不能使用保留目标或DIRECT。')
  return value
}

// Parse and validate a dedicated listener plan coming from the renderer /
// main-process caller. Returns a normalized plan with at least one listener.
export function dedicatedListeners(value: unknown): DedicatedListenerPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('专用监听方案格式无效。')
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort().join(',')
  if (!['route', 'httpPort,route', 'route,socksPort', 'httpPort,route,socksPort'].includes(keys))
    throw new Error('专用监听方案只接受固定端口与路由节点。')
  const httpPort =
    input.httpPort === undefined ? undefined : portNumber(input.httpPort, '专用HTTP端口')
  const socksPort =
    input.socksPort === undefined ? undefined : portNumber(input.socksPort, '专用SOCKS端口')
  if (httpPort === undefined && socksPort === undefined)
    throw new Error('专用监听至少需要HTTP或SOCKS端口。')
  if (httpPort !== undefined && socksPort !== undefined && httpPort === socksPort)
    throw new Error('专用HTTP与SOCKS端口不能相同。')
  return httpPort === undefined
    ? { socksPort: socksPort as number, route: routeName(input.route) }
    : socksPort === undefined
      ? { httpPort, route: routeName(input.route) }
      : { httpPort, socksPort, route: routeName(input.route) }
}

// Two plans are port/route compatible for hot reload: mihomo's force=false
// keeps compatible listeners, so changing the dedicated entry set would require
// a restart. Relay refuses that and keeps the live entries unchanged.
export function dedicatedListenersCompatible(
  current: DedicatedListenerPlan | undefined,
  candidate: DedicatedListenerPlan | undefined
): boolean {
  if (!current && !candidate) return true
  if (!current || !candidate) return false
  return (
    current.httpPort === candidate.httpPort &&
    current.socksPort === candidate.socksPort &&
    current.route === candidate.route
  )
}

export function dedicatedListenerSummary(
  plan: DedicatedListenerPlan | undefined
): DedicatedListenerSummary | undefined {
  if (!plan) return undefined
  return { ...plan, httpName: 'relay-ai-http', socksName: 'relay-ai-socks' }
}
