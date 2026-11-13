import { Cron } from 'croner'
import {
  sourceRequestTimeoutSeconds,
  sourceSelection,
  type SourceMetadata,
  type SourceOptions,
  type SourceRequestTuning,
  type SourceSchedule
} from '../../../shared/relay/subscription-sources'
import { subscriptionRequest, type SubscriptionRequest } from '../../../shared/relay/subscription'
import { stripProfileControls } from '../../../shared/relay/profiles'
import { parseAgeSecretKeys } from '../../utils/age'
import { providerHeaders } from './transfer'

const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw &&
  typeof raw === 'object' &&
  !Array.isArray(raw) &&
  Object.getPrototypeOf(raw) === Object.prototype

export function sourceRequestTuning(raw: unknown): SourceRequestTuning | undefined {
  if (raw === undefined) return undefined
  if (
    !object(raw) ||
    Object.keys(raw).some((key) => !['timeoutSeconds', 'userAgent'].includes(key))
  )
    throw new Error('本次订阅请求选项无效。')
  const { timeoutSeconds, userAgent } = raw
  if (
    (Object.hasOwn(raw, 'timeoutSeconds') &&
      (typeof timeoutSeconds !== 'number' ||
        !Number.isSafeInteger(timeoutSeconds) ||
        timeoutSeconds < 1 ||
        timeoutSeconds > sourceRequestTimeoutSeconds)) ||
    (Object.hasOwn(raw, 'userAgent') &&
      (typeof userAgent !== 'string' ||
        userAgent.trim() !== userAgent ||
        !/^[\x20-\x7e]{1,256}$/u.test(userAgent)))
  )
    throw new Error('本次订阅超时或 User-Agent 无效。')
  if (userAgent !== undefined) providerHeaders({ 'user-agent': [userAgent] })
  return {
    ...(typeof timeoutSeconds === 'number' ? { timeoutSeconds } : {}),
    ...(typeof userAgent === 'string' ? { userAgent } : {})
  }
}

export function sourceUpdatePreparation(raw: unknown) {
  if (!object(raw) || !Object.hasOwn(raw, 'requestTuning'))
    return { selected: sourceSelection(raw) }
  if (Object.keys(raw).sort().join(',') !== 'id,requestTuning,revision')
    throw new Error('本次订阅更新准备字段无效。')
  return {
    selected: sourceSelection({ id: raw.id, revision: raw.revision }),
    tuning: sourceRequestTuning(raw.requestTuning)
  }
}
export function sourceSchedule(raw: unknown): SourceSchedule {
  if (!object(raw)) throw new Error('调度格式无效。')
  if (raw.kind === 'manual' && Object.keys(raw).join(',') === 'kind') return { kind: 'manual' }
  if (
    raw.kind === 'interval' &&
    Object.keys(raw).sort().join(',') === 'kind,minutes' &&
    typeof raw.minutes === 'number' &&
    Number.isInteger(raw.minutes) &&
    raw.minutes >= 1 &&
    raw.minutes <= 35791
  )
    return { kind: 'interval', minutes: raw.minutes }
  if (
    raw.kind === 'cron' &&
    Object.keys(raw).sort().join(',') === 'expression,kind' &&
    typeof raw.expression === 'string' &&
    raw.expression.length <= 256 &&
    raw.expression.trim().split(/\s+/u).length === 5 &&
    stripProfileControls(raw.expression) === raw.expression
  ) {
    let cron: Cron | undefined
    try {
      cron = new Cron(raw.expression, { paused: true })
      if (!cron.nextRun()) throw new Error()
      return { kind: 'cron', expression: raw.expression }
    } catch {
      throw new Error('仅支持有效的5段cron。')
    } finally {
      cron?.stop()
    }
  }
  throw new Error('调度不支持：最小1分钟，或有效5段cron。')
}
export function sourceOptions(raw: unknown): SourceOptions {
  if (raw === undefined)
    return {
      headers: {},
      ageSecretKey: '',
      redirects: 'none',
      schedule: { kind: 'manual' },
      useServerInterval: false
    }
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !==
      'ageSecretKey,headers,redirects,schedule,useServerInterval' ||
    !object(raw.headers) ||
    typeof raw.ageSecretKey !== 'string' ||
    raw.ageSecretKey.length > 4096 ||
    !['none', 'same-origin', 'https'].includes(String(raw.redirects)) ||
    typeof raw.useServerInterval !== 'boolean'
  )
    throw new Error('来源高级选项无效。')
  const entries = Object.entries(raw.headers)
  if (entries.some(([, value]) => typeof value !== 'string')) throw new Error('来源请求头无效。')
  const headers = providerHeaders(Object.fromEntries(entries.map(([key, value]) => [key, [value]])))
  if (
    Object.keys(headers).length > 26 ||
    Object.keys(headers).some((key) =>
      ['if-none-match', 'if-modified-since', 'range'].includes(key)
    )
  )
    throw new Error('请求头超出预算，或条件请求头未由缓存模块管理。')
  const identities = raw.ageSecretKey.trim() ? raw.ageSecretKey.trim().split(/[\s,]+/u) : []
  if (
    identities.length > 8 ||
    identities.some((s) => !/^AGE-SECRET-KEY-(?:PQ-)?1[A-Z0-9]+$/u.test(s)) ||
    parseAgeSecretKeys(raw.ageSecretKey).length !== identities.length
  )
    throw new Error('AGE身份格式无效。')
  return {
    headers,
    ageSecretKey: raw.ageSecretKey,
    redirects: raw.redirects as SourceOptions['redirects'],
    schedule: sourceSchedule(raw.schedule),
    useServerInterval: raw.useServerInterval
  }
}
export function sourceRegistration(raw: unknown): {
  request: SubscriptionRequest
  options?: SourceOptions
} {
  if (!object(raw)) throw new Error('来源登记格式无效。')
  if (!Object.hasOwn(raw, 'options')) return { request: subscriptionRequest(raw) }
  if (Object.keys(raw).sort().join(',') !== 'name,options,proxyPort,url')
    throw new Error('来源登记字段无效。')
  return {
    request: subscriptionRequest({ name: raw.name, url: raw.url, proxyPort: raw.proxyPort }),
    options: sourceOptions(raw.options)
  }
}
export function sourceMetadata(raw: unknown): SourceMetadata {
  if (
    !object(raw) ||
    Object.keys(raw).some(
      (k) =>
        ![
          'checkedAt',
          'status',
          'resourceSHA256',
          'etag',
          'lastModified',
          'quota',
          'intervalMinutes',
          'filename',
          'homeOrigin',
          'homeURL'
        ].includes(k)
    ) ||
    typeof raw.checkedAt !== 'string' ||
    !Number.isFinite(Date.parse(raw.checkedAt)) ||
    (raw.status !== 200 && raw.status !== 304) ||
    typeof raw.resourceSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.resourceSHA256)
  )
    throw new Error('订阅响应元数据无效。')
  for (const key of ['etag', 'lastModified', 'filename', 'homeOrigin', 'homeURL']) {
    const value = raw[key]
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        value.length > (key === 'homeURL' ? 4096 : 1024) ||
        stripProfileControls(value) !== value)
    )
      throw new Error('订阅响应文本无效。')
  }
  if (raw.homeOrigin !== undefined) {
    let u: URL
    try {
      u = new URL(String(raw.homeOrigin))
    } catch {
      throw new Error('主页来源无效。')
    }
    if (!['http:', 'https:'].includes(u.protocol) || u.origin !== raw.homeOrigin)
      throw new Error('主页来源无效。')
  }
  if (raw.homeURL !== undefined) {
    let u: URL
    try {
      u = new URL(String(raw.homeURL))
    } catch {
      throw new Error('主页地址无效。')
    }
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.origin !== raw.homeOrigin
    )
      throw new Error('主页地址无效。')
  }
  if (
    raw.intervalMinutes !== undefined &&
    (typeof raw.intervalMinutes !== 'number' ||
      !Number.isInteger(raw.intervalMinutes) ||
      raw.intervalMinutes < 1 ||
      raw.intervalMinutes > 35791)
  )
    throw new Error('响应调度无效。')
  if (
    raw.quota !== undefined &&
    (!object(raw.quota) ||
      Object.entries(raw.quota).some(
        ([key, value]) =>
          !['upload', 'download', 'total', 'expire'].includes(key) ||
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value < 0
      ))
  )
    throw new Error('配额无效。')
  const result: SourceMetadata = {
    checkedAt: raw.checkedAt,
    status: raw.status === 200 ? 200 : 304,
    resourceSHA256: raw.resourceSHA256
  }
  if (typeof raw.etag === 'string') result.etag = raw.etag
  if (typeof raw.lastModified === 'string') result.lastModified = raw.lastModified
  if (typeof raw.filename === 'string') result.filename = raw.filename
  if (typeof raw.homeOrigin === 'string') result.homeOrigin = raw.homeOrigin
  if (typeof raw.homeURL === 'string') result.homeURL = raw.homeURL
  if (typeof raw.intervalMinutes === 'number') result.intervalMinutes = raw.intervalMinutes
  if (object(raw.quota)) {
    result.quota = {}
    for (const key of ['upload', 'download', 'total', 'expire'] as const)
      if (typeof raw.quota[key] === 'number') result.quota[key] = raw.quota[key]
  }
  return result
}
