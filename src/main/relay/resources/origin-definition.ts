import { resourceDescriptor } from '../../../shared/relay/resources'
import { subscriptionRequest } from '../../../shared/relay/subscription'
import {
  geoOriginSelection,
  isGeoResourceKind,
  type GeoOriginDefinition,
  type GeoOriginSaveRequest
} from '../../../shared/relay/geo-origins'
import { sourceSchedule } from '../subscriptions/source-options'
import { providerHeaders } from '../subscriptions/transfer'

function object(raw: unknown, fields?: string): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    (fields !== undefined && Object.keys(raw).sort().join(',') !== fields)
  )
    throw new Error('地理资源来源字段无效。')
  return raw as Record<string, unknown>
}

// Reuse the existing descriptor, single-proxy HTTP, header and schedule
// contracts. Keep Node-only validators out of the renderer's type module.
export function geoOriginDefinition(raw: unknown): GeoOriginDefinition {
  const value = object(raw, 'autoIntent,descriptor,expectedSHA256,source'),
    descriptor = resourceDescriptor(value.descriptor),
    source = object(value.source, 'headers,kind,proxyPort,url'),
    intent = object(value.autoIntent, 'requested,schedule')
  if (!isGeoResourceKind(descriptor.kind) || descriptor.behavior !== null)
    throw new Error('此来源仅接受四类地理资源。')
  if (
    Buffer.byteLength(descriptor.selector, 'utf8') > 256 ||
    Buffer.from(descriptor.selector, 'utf8').toString('utf8') !== descriptor.selector ||
    /[\u0080-\u009f]/u.test(descriptor.selector)
  )
    throw new Error('地理资源选择器超过核心字节预算或包含控制字符。')
  if (
    source.kind !== 'http' ||
    typeof value.expectedSHA256 !== 'string' ||
    (value.expectedSHA256 !== '' && !/^[a-f0-9]{64}$/u.test(value.expectedSHA256)) ||
    typeof intent.requested !== 'boolean'
  )
    throw new Error('地理资源HTTP来源、期望摘要或自动更新意图无效。')
  const request = subscriptionRequest({
      name: descriptor.name,
      url: source.url,
      proxyPort: source.proxyPort
    }),
    headers = object(source.headers),
    entries = Object.entries(headers)
  if (request.url.length > 4096) throw new Error('规范化地理资源地址超过预算。')
  if (entries.some(([, item]) => typeof item !== 'string'))
    throw new Error('地理资源私有请求头无效。')
  const checkedHeaders = providerHeaders(
      Object.fromEntries(entries.map(([key, item]) => [key, [item]]))
    ),
    schedule = sourceSchedule(intent.schedule)
  if (
    Object.keys(checkedHeaders).some((key) =>
      ['if-none-match', 'if-modified-since', 'range'].includes(key)
    )
  )
    throw new Error('地理资源只获取完整正文，不接受条件或范围请求头。')
  if (intent.requested && schedule.kind === 'manual')
    throw new Error('自动更新意图需要有效的周期调度。')
  return {
    descriptor: { ...descriptor, kind: descriptor.kind, behavior: null },
    source: {
      kind: 'http',
      url: request.url,
      proxyPort: request.proxyPort,
      headers: checkedHeaders
    },
    expectedSHA256: value.expectedSHA256,
    autoIntent: { requested: intent.requested, schedule }
  }
}

export function geoOriginSaveRequest(raw: unknown): GeoOriginSaveRequest {
  const value = object(raw, 'definition,origin')
  return {
    origin: value.origin === null ? null : geoOriginSelection(value.origin),
    definition: geoOriginDefinition(value.definition)
  }
}
