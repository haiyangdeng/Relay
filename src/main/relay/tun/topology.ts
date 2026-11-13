import { createHash } from 'crypto'

const hash = (value: string[]): string =>
  createHash('sha256').update(JSON.stringify(value.sort())).digest('hex')
export interface TunTopologyRevision {
  interfacesSHA256: string
  routesSHA256: string
}

// Read-only acceptance evidence. Preserve address-to-interface and route-family
// identity; omit neighbor-cache entries and expiration counters, which change
// with ordinary traffic and are not network configuration restoration targets.
export function parseTunTopology(interfaces: string, routes: string): TunTopologyRevision {
  if (
    [interfaces, routes].some(
      (value) =>
        typeof value !== 'string' ||
        !value.length ||
        value.includes('\0') ||
        Buffer.byteLength(value) > 1048576
    )
  )
    throw new Error('网络拓扑输出格式或大小未确认。')
  const devices: string[] = [],
    paths: string[] = []
  let currentInterface: string | undefined, family: 'inet' | 'inet6' | undefined
  for (const line of interfaces.split('\n')) {
    const header = /^([a-zA-Z0-9._-]+): flags=\d+<[^>]+> mtu \d+/u.exec(line)
    if (header) {
      currentInterface = header[1]
      devices.push(line.trim())
    } else if (/^[^\s]/u.test(line) && line.trim()) currentInterface = undefined
    else if (/^\s+(?:inet6? |status:)/u.test(line)) {
      if (!currentInterface) throw new Error('网络地址缺少已确认的接口归属。')
      devices.push(currentInterface + ': ' + line.trim())
    }
  }
  for (const line of routes.split('\n')) {
    const value = line.trim()
    if (value === 'Internet:') family = 'inet'
    else if (value === 'Internet6:') family = 'inet6'
    else if (/^[A-Za-z][A-Za-z0-9 ]*:$/u.test(value)) family = undefined
    else {
      const parts = value.split(/\s+/u)
      if (family && parts.length >= 4 && /^U[A-Za-z]*$/u.test(parts[2]) && !parts[2].includes('L'))
        paths.push(family + ' ' + parts.slice(0, 4).join(' '))
    }
  }
  if (!devices.length || !paths.some((line) => /^inet6? default /u.test(line)))
    throw new Error('接口或默认路由基线未确认。')
  return { interfacesSHA256: hash(devices), routesSHA256: hash(paths) }
}
