export interface RelayBrowserBinding {
  instanceId: string
  configurationRevision: string
  pid: number
  httpPort: number
  socksPort?: number
  route: string
}

export function validateBrowserBinding(value: unknown): RelayBrowserBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('浏览器代理归属未确认。')
  const binding = value as Record<string, unknown>
  if (
    ![
      'configurationRevision,httpPort,instanceId,pid,route',
      'configurationRevision,httpPort,instanceId,pid,route,socksPort'
    ].includes(Object.keys(binding).sort().join(',')) ||
    typeof binding.instanceId !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(binding.instanceId) ||
    typeof binding.configurationRevision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(binding.configurationRevision) ||
    typeof binding.pid !== 'number' ||
    !Number.isSafeInteger(binding.pid) ||
    binding.pid <= 0 ||
    binding.pid > 2147483647 ||
    typeof binding.httpPort !== 'number' ||
    !Number.isInteger(binding.httpPort) ||
    binding.httpPort < 1024 ||
    binding.httpPort > 65535 ||
    (binding.socksPort !== undefined &&
      (typeof binding.socksPort !== 'number' ||
        !Number.isInteger(binding.socksPort) ||
        binding.socksPort < 1024 ||
        binding.socksPort > 65535 ||
        binding.socksPort === binding.httpPort)) ||
    typeof binding.route !== 'string' ||
    !binding.route.trim() ||
    binding.route.length > 256 ||
    Array.from(binding.route).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    ['DIRECT', 'REJECT', 'REJECT-DROP', 'COMPATIBLE', 'PASS', 'GLOBAL'].includes(binding.route)
  )
    throw new Error('浏览器代理归属未确认。')
  return {
    instanceId: binding.instanceId,
    configurationRevision: binding.configurationRevision,
    pid: binding.pid,
    httpPort: binding.httpPort,
    ...(binding.socksPort === undefined ? {} : { socksPort: binding.socksPort as number }),
    route: binding.route
  }
}
