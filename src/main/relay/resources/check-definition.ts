import { zstdDecompressSync } from 'zlib'
import { parseDocument } from 'yaml'
import { resourceDescriptor, type ResourceDescriptor } from '../../../shared/relay/resources'
import { stripProfileControls } from '../../../shared/relay/profiles'
import { isolatedCoreConfiguration } from '../core/configuration'
import { RESOURCE_BYTE_LIMIT, resourceHash } from './source'

export interface ResourceValidationJob {
  descriptor: ResourceDescriptor
  bytes: Buffer
  sha256: string
}
export function resourceCheckDefinition(raw: ResourceDescriptor): {
  configuration: Record<string, unknown>
  filename: string
} {
  const descriptor = resourceDescriptor(raw)
  if (descriptor.kind === 'runtime-file') throw new Error('通用文件需要绑定完整配置后校验。')
  const config = isolatedCoreConfiguration(),
    files = {
      'rule-yaml': 'resource.bin',
      'rule-text': 'resource.bin',
      'rule-mrs': 'resource.bin',
      'geoip-dat': 'GeoIP.dat',
      'geosite-dat': 'GeoSite.dat',
      'country-mmdb': 'Country.mmdb',
      'asn-mmdb': 'ASN.mmdb'
    },
    filename = files[descriptor.kind]
  config['geox-url'] = { geoip: '', geosite: '', mmdb: '', asn: '' }
  if (descriptor.kind.startsWith('rule-')) {
    const format = descriptor.kind.slice(5)
    config['rule-providers'] = {
      resource: { type: 'file', behavior: descriptor.behavior, format, path: filename, interval: 0 }
    }
    config.rules = ['RULE-SET,resource,REJECT', 'MATCH,REJECT']
  } else {
    const type =
      descriptor.kind === 'geosite-dat'
        ? 'GEOSITE'
        : descriptor.kind === 'asn-mmdb'
          ? 'IP-ASN'
          : 'GEOIP'
    config['geodata-mode'] = descriptor.kind === 'geoip-dat'
    config.rules = [
      `${type},${descriptor.selector},REJECT${type === 'GEOSITE' ? '' : ',no-resolve'}`,
      'MATCH,REJECT'
    ]
  }
  return { configuration: config, filename }
}
export function checkResourceJob(job: ResourceValidationJob): void {
  resourceDescriptor(job.descriptor)
  if (
    !Buffer.isBuffer(job.bytes) ||
    !job.bytes.length ||
    job.bytes.length > RESOURCE_BYTE_LIMIT ||
    !/^[a-f0-9]{64}$/u.test(job.sha256) ||
    resourceHash(job.bytes) !== job.sha256
  )
    throw new Error('资源校验工作单摘要或大小无效。')
}
export function resourceRuleEntries(
  job: ResourceValidationJob,
  includeEntries = false
): {
  expected?: number
  needsDependencies: boolean
  entries?: string[]
} {
  checkResourceJob(job)
  if (job.descriptor.kind === 'rule-mrs') {
    if (typeof zstdDecompressSync !== 'function') throw new Error('当前运行时不支持有界MRS预检。')
    const decoded = zstdDecompressSync(job.bytes, { maxOutputLength: 64 * 1024 * 1024 })
    if (decoded.length < 21 || !decoded.subarray(0, 4).equals(Buffer.from([77, 82, 83, 1])))
      throw new Error('MRS头无效。')
    const count = decoded.readBigInt64BE(5),
      extra = decoded.readBigInt64BE(13)
    if (
      decoded[4] !== (job.descriptor.behavior === 'domain' ? 0 : 1) ||
      count < 1n ||
      count > 2000000n ||
      extra < 0n ||
      extra > 1048576n ||
      21n + extra > BigInt(decoded.length)
    )
      throw new Error('MRS行为、数量或扩展长度超过检查预算。')
    let offset = 21 + Number(extra)
    if (decoded[offset++] !== 1) throw new Error('MRS内层版本无效。')
    const vector = (width: number): void => {
      if (offset + 8 > decoded.length) throw new Error('MRS内层长度缺失。')
      const length = decoded.readBigInt64BE(offset)
      offset += 8
      if (length < 1n || length > BigInt(Math.floor((decoded.length - offset) / width)))
        throw new Error('MRS内层分配超过实际数据预算。')
      offset += Number(length) * width
    }
    if (job.descriptor.behavior === 'domain') {
      vector(8)
      vector(8)
      vector(1)
    } else vector(32)
    if (offset !== decoded.length) throw new Error('MRS存在未识别的尾部数据。')
    return { expected: Number(count), needsDependencies: false }
  }
  if (!['rule-yaml', 'rule-text'].includes(job.descriptor.kind)) return { needsDependencies: false }
  if (job.bytes.length > 8 * 1024 * 1024)
    throw new Error('文本规则上限8MiB，二进制地理／MRS资源上限128MiB。')
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(job.bytes)
  if (text.includes('\0')) throw new Error('规则文本包含无效字符。')
  let values: unknown
  if (job.descriptor.kind === 'rule-text')
    values = text
      .replace(/^\ufeff/u, '')
      .split(/\r?\n/u)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#') && !s.startsWith('//'))
  else {
    const doc = parseDocument(text, { uniqueKeys: true, logLevel: 'silent' })
    if (doc.errors.length || doc.warnings.length) throw new Error('规则YAML结构未通过。')
    const root: unknown = doc.toJS({ maxAliasCount: 0 })
    if (
      !root ||
      typeof root !== 'object' ||
      Array.isArray(root) ||
      Object.keys(root).length !== 1 ||
      !['payload', 'rules'].includes(Object.keys(root)[0])
    )
      throw new Error('规则YAML仅接受payload或rules数组。')
    values = (root as Record<string, unknown>)[Object.keys(root)[0]]
  }
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.length > 200000 ||
    values.some(
      (value) =>
        typeof value !== 'string' ||
        !value.trim() ||
        value.length > 4096 ||
        stripProfileControls(value) !== value
    )
  )
    throw new Error('规则列表类型、数量或条目未通过。')
  const lines = values as string[]
  return {
    expected: lines.length,
    ...(includeEntries ? { entries: lines } : {}),
    needsDependencies:
      job.descriptor.behavior === 'classical' &&
      lines.some((s) => /\b(?:GEOSITE|GEOIP|IP-ASN)\s*,/u.test(s.toUpperCase()))
  }
}
