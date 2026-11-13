import { isIP } from 'net'
import type { IsolatedProbeIP, ProbeIPProvider } from '../../../shared/relay/isolated-probes'
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
export function providerIP(provider: ProbeIPProvider, input: unknown): IsolatedProbeIP {
  const data = object(input),
    connection = object(data.connection),
    location = object(data.location),
    asn = object(data.asn)
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' &&
    v.length <= 256 &&
    ![...v].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      ? v
      : undefined
  const ip = text(data.ip)
  if (!ip || !isIP(ip)) throw new Error('出口IP未通过验证。')
  const coordinate = (value: unknown, limit: number): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
      ? value
      : undefined
  const asnValue =
    provider === 'ip.sb' ? data.asn : provider === 'ipwho.is' ? connection.asn : asn.asn
  const asnNumber =
    typeof asnValue === 'number'
      ? asnValue
      : typeof asnValue === 'string' && /^(?:AS)?[0-9]{1,10}$/iu.test(asnValue)
        ? Number(asnValue.replace(/^AS/iu, ''))
        : NaN
  const code = text(provider === 'ipapi.is' ? location.country_code : data.country_code)
  // Fixed v2.0.4 network.tsx parseProvider normalization, bounded to useful text.
  return {
    ip,
    countryCode: code && /^[a-z]{2}$/iu.test(code) ? code.toUpperCase() : undefined,
    asn:
      Number.isSafeInteger(asnNumber) && asnNumber > 0 && asnNumber <= 4294967295
        ? `AS${asnNumber}`
        : undefined,
    latitude: coordinate(provider === 'ipapi.is' ? location.latitude : data.latitude, 90),
    longitude: coordinate(provider === 'ipapi.is' ? location.longitude : data.longitude, 180),
    country: text(provider === 'ipapi.is' ? location.country : data.country),
    city: text(provider === 'ipapi.is' ? location.city : data.city),
    region: text(provider === 'ipapi.is' ? location.state : data.region),
    organization: text(
      provider === 'ip.sb'
        ? data.asn_organization
        : provider === 'ipwho.is'
          ? connection.org
          : asn.org
    )
  }
}
