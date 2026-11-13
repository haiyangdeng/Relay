interface FloatingTrafficRates {
  readonly up: number
  readonly down: number
  readonly upTotal: number
  readonly downTotal: number
  readonly receivedAt: number
}
export interface RelayOrdinaryTrafficSample extends FloatingTrafficRates {
  readonly instanceId: string
  readonly configurationRevision: string
}
export interface RelayTunTrafficSample extends FloatingTrafficRates {
  readonly kind: 'tun-managed'
  readonly sessionId: string
  readonly evidenceSHA256: string
  readonly runtimeConfigurationSHA256: string
}
export type RelayFloatingTrafficSample = RelayOrdinaryTrafficSample | RelayTunTrafficSample

export type RelayFloatingTrafficSnapshot = { readonly spinFloatingIcon?: boolean } & (
  | { readonly version: 1; readonly status: 'hidden' | 'loading' | 'unavailable' }
  | { readonly version: 1; readonly status: 'ready'; readonly sample: RelayFloatingTrafficSample }
)

export const floatingTrafficFreshMS = 2000
export const relayFloatingArgument = '--relay-floating-readonly-v1'
export const relayFloatingReadonlyHash = 'relay-floating-readonly-v1'
export const relayFloatingTransparentHash = 'relay-floating-readonly-transparent-v1'
export const relayFloatingTrafficChannel = 'relayFloatingTraffic'

function record(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const prototype = Object.getPrototypeOf(raw)
  return prototype === Object.prototype || prototype === null
    ? (raw as Record<string, unknown>)
    : undefined
}

function unsigned(raw: unknown): raw is number {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
}

export function copyFloatingTrafficSample(raw: unknown): RelayFloatingTrafficSample | undefined {
  try {
    const value = record(raw)
    if (!value) return undefined
    const { up, down, upTotal, downTotal, receivedAt } = value
    if (
      !unsigned(up) ||
      !unsigned(down) ||
      !unsigned(upTotal) ||
      !unsigned(downTotal) ||
      !unsigned(receivedAt)
    )
      return undefined
    const uuid = (id: unknown): id is string =>
      typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)
    const digest = (hash: unknown): hash is string =>
      typeof hash === 'string' && /^[a-f0-9]{64}$/u.test(hash)
    if (value.kind === 'tun-managed') {
      const { sessionId, evidenceSHA256, runtimeConfigurationSHA256 } = value
      if (
        Object.keys(value).sort().join(',') !==
          'down,downTotal,evidenceSHA256,kind,receivedAt,runtimeConfigurationSHA256,sessionId,up,upTotal' ||
        !uuid(sessionId) ||
        !digest(evidenceSHA256) ||
        !digest(runtimeConfigurationSHA256)
      )
        return undefined
      return Object.freeze({
        up,
        down,
        upTotal,
        downTotal,
        receivedAt,
        kind: 'tun-managed',
        sessionId,
        evidenceSHA256,
        runtimeConfigurationSHA256
      })
    }
    const { instanceId, configurationRevision } = value
    if (
      Object.keys(value).sort().join(',') !==
        'configurationRevision,down,downTotal,instanceId,receivedAt,up,upTotal' ||
      !uuid(instanceId) ||
      !digest(configurationRevision)
    )
      return undefined
    return Object.freeze({
      up,
      down,
      upTotal,
      downTotal,
      instanceId,
      configurationRevision,
      receivedAt
    })
  } catch {
    return undefined
  }
}

// A display-only value boundary. This grants no Core, path, system or TUN access.
export function parseFloatingTrafficSnapshot(
  raw: unknown
): RelayFloatingTrafficSnapshot | undefined {
  try {
    const value = record(raw)
    if (!value || value.version !== 1 || !Object.hasOwn(value, 'status')) return undefined
    const { spinFloatingIcon, status, ...rest } = value
    const hasSpinPreference = Object.hasOwn(value, 'spinFloatingIcon')
    if (hasSpinPreference && typeof spinFloatingIcon !== 'boolean') return undefined
    const presentation =
      hasSpinPreference && typeof spinFloatingIcon === 'boolean' ? { spinFloatingIcon } : {}
    if (status === 'ready') {
      if (Object.keys(rest).sort().join(',') !== 'sample,version') return undefined
      const sample = copyFloatingTrafficSample(value.sample)
      return sample ? Object.freeze({ version: 1, status, sample, ...presentation }) : undefined
    }
    if (
      (status !== 'hidden' && status !== 'loading' && status !== 'unavailable') ||
      Object.keys(rest).join(',') !== 'version'
    )
      return undefined
    return Object.freeze({ version: 1, status, ...presentation })
  } catch {
    return undefined
  }
}
