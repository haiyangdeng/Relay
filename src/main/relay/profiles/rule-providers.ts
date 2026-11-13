import { isIP } from 'net'
import { stripProfileControls } from '../../../shared/relay/profiles'

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const domain = (value: string): boolean => !!value && !/[,:/\\\s#@]/u.test(value)
const cidr = (value: string): boolean => {
  const [address, mask, extra] = value.split('/')
  const family = isIP(address)
  return (
    !!family &&
    !address.includes('%') &&
    extra === undefined &&
    /^\d{1,3}$/u.test(mask ?? '') &&
    Number(mask) <= (family === 4 ? 32 : 128)
  )
}
function classical(value: string): boolean {
  const parts = value.split(',').map((part) => part.trim())
  if (['DOMAIN', 'DOMAIN-SUFFIX', 'DOMAIN-KEYWORD'].includes(parts[0]))
    return parts.length === 2 && domain(parts[1])
  if (
    !['IP-CIDR', 'IP-CIDR6'].includes(parts[0]) ||
    !cidr(parts[1] ?? '') ||
    (parts[0] === 'IP-CIDR6' && isIP(parts[1].split('/')[0]) !== 6)
  )
    return false
  return parts.length === 2 || (parts.length === 3 && parts[2] === 'no-resolve')
}

// Only bounded in-memory sets enter the HTTP projection. Classical entries
// use the same supported domain/CIDR primitives; no nested sets or geodata.
export function supportedInlineRuleProvider(value: unknown): boolean {
  if (
    !object(value) ||
    value.type !== 'inline' ||
    !['domain', 'ipcidr', 'classical'].includes(String(value.behavior)) ||
    Object.keys(value).some((key) => !['type', 'behavior', 'format', 'payload'].includes(key)) ||
    (value.format !== undefined && value.format !== 'yaml') ||
    !Array.isArray(value.payload) ||
    value.payload.length < 1 ||
    value.payload.length > 20000
  )
    return false
  let remaining = 512 * 1024
  for (const line of value.payload) {
    if (
      typeof line !== 'string' ||
      !line.trim() ||
      line !== line.trim() ||
      line.length > 4096 ||
      stripProfileControls(line) !== line
    )
      return false
    remaining -= Buffer.byteLength(line)
    if (remaining < 0) return false
    if (value.behavior === 'domain') {
      if (!domain(line)) return false
    } else if (value.behavior === 'ipcidr') {
      if (!cidr(line)) return false
    } else if (!classical(line)) return false
  }
  return true
}
