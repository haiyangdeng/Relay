import type { IncomingHttpHeaders } from 'http'
import { performance } from 'node:perf_hooks'
import {
  sourceRequestTimeoutSeconds,
  type SourceMetadata,
  type SourceOptions,
  type SourceRequestTuning,
  type SourceTransferResult
} from '../../../shared/relay/subscription-sources'
import { subscriptionRequest } from '../../../shared/relay/subscription'
import { stripProfileControls } from '../../../shared/relay/profiles'
import { requestOnce } from '../../resolve/plugin/http-client'
import { isAgeArmored, parseAgeSecretKeys } from '../../utils/age'
import { profileHash } from '../profiles/source'
import { inspectProfile, PROFILE_BYTE_LIMIT } from '../profiles/inspect'
import { sourceOptions, sourceMetadata, sourceRequestTuning } from './source-options'

const textHeader = (headers: IncomingHttpHeaders, key: string): string | undefined => {
  const value = headers[key]
  return typeof value === 'string' && value.length <= 1024 && stripProfileControls(value) === value
    ? value
    : undefined
}
async function decryptSource(text: string, identity: string): Promise<string> {
  if (!isAgeArmored(text)) return text
  const identities = parseAgeSecretKeys(identity)
  if (!identities.length) throw new Error()
  const age = await import('age-encryption'),
    decrypter = new age.Decrypter()
  identities.forEach((key) => decrypter.addIdentity(key))
  // The library's text mode strips a UTF-8 BOM. Read bytes and decode strictly
  // so decryption neither drops source bytes nor replaces invalid credentials.
  const bytes = await decrypter.decrypt(age.armor.decode(text))
  if (bytes.byteLength > PROFILE_BYTE_LIMIT) throw new Error()
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
}
export function responseMetadata(
  headers: IncomingHttpHeaders,
  url: string,
  status: 200 | 304,
  previous?: SourceMetadata
): SourceMetadata {
  const result: SourceMetadata = {
    ...(status === 304 ? previous : undefined),
    checkedAt: new Date().toISOString(),
    status,
    resourceSHA256: profileHash(url)
  }
  const etag = textHeader(headers, 'etag'),
    lastModified = textHeader(headers, 'last-modified')
  if (etag !== undefined) result.etag = etag
  if (lastModified !== undefined) result.lastModified = lastModified
  const quota = textHeader(headers, 'subscription-userinfo')
  if (quota) {
    const parsed: NonNullable<SourceMetadata['quota']> = {}
    for (const pair of quota.split(';')) {
      const [key, value] = pair.trim().split('=')
      if (
        ['upload', 'download', 'total', 'expire'].includes(key) &&
        /^\d+$/u.test(value ?? '') &&
        Number.isSafeInteger(Number(value))
      )
        parsed[key as keyof typeof parsed] = Number(value)
    }
    if (Object.keys(parsed).length) result.quota = parsed
  }
  const hours = Number(textHeader(headers, 'profile-update-interval'))
  if (Number.isFinite(hours) && hours > 0)
    result.intervalMinutes = Math.min(35791, Math.max(1, Math.ceil(hours * 60)))
  const disposition = textHeader(headers, 'content-disposition')
  if (disposition) {
    const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1],
      plain = /filename=["']?([^;"']+)/iu.exec(disposition)?.[1]
    try {
      const name = encoded ? decodeURIComponent(encoded) : plain
      if (name && name.length <= 120 && stripProfileControls(name) === name) result.filename = name
    } catch {
      /* Ignore malformed optional filename metadata. */
    }
  }
  const home = textHeader(headers, 'profile-web-page-url')
  if (home) {
    try {
      const u = new URL(home)
      if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) {
        result.homeOrigin = u.origin
        result.homeURL = u.toString()
      }
    } catch {
      /* Optional homepage is never opened. */
    }
  }
  return sourceMetadata(result)
}
// This bounded redirect loop never delegates route choice or retries to the
// upstream updater. Every hop keeps the same explicit local HTTP proxy.
export async function transferSubscriptionSource(
  url: string,
  proxyPort: number,
  signal: AbortSignal,
  rawOptions?: SourceOptions,
  cache?: SourceMetadata,
  rawTuning?: SourceRequestTuning
): Promise<SourceTransferResult> {
  try {
    const request = subscriptionRequest({ name: 'Transfer', url, proxyPort }),
      options = sourceOptions(rawOptions),
      tuning = sourceRequestTuning(rawTuning),
      timeout = (tuning?.timeoutSeconds ?? sourceRequestTimeoutSeconds) * 1000,
      customUserAgent =
        tuning?.userAgent !== undefined && !Object.hasOwn(options.headers, 'user-agent'),
      startedWall = Date.now(),
      startedMono = performance.now(),
      visited = new Set<string>(),
      original = new URL(request.url)
    if (cache) cache = sourceMetadata(cache)
    let lastWall = startedWall,
      lastMono = startedMono
    // Reuse the app-update transport's whole-operation dual-clock budget.
    // Neither a redirect nor a partial wall-clock rollback grants more time.
    const remaining = (): number => {
      const wall = Date.now(),
        mono = performance.now()
      if (
        signal.aborted ||
        ![startedWall, startedMono, wall, mono].every(Number.isFinite) ||
        wall < lastWall ||
        mono < lastMono ||
        wall - startedWall >= timeout ||
        mono - startedMono >= timeout
      )
        throw new Error()
      lastWall = wall
      lastMono = mono
      return Math.max(1, Math.ceil(timeout - Math.max(wall - startedWall, mono - startedMono)))
    }
    let target = original,
      forwardPrivateHeaders = true
    for (let hop = 0; hop <= 5; hop++) {
      const address = target.toString()
      if (
        visited.has(address) ||
        (target.protocol === 'https:' && process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
      )
        throw new Error()
      visited.add(address)
      const headers: Record<string, string> = {
          // Match pinned upstream's explicit-source, selected default, built-in order.
          'user-agent':
            (forwardPrivateHeaders ? tuning?.userAgent : undefined) ?? 'clash.meta/Relay',
          'accept-encoding': 'identity',
          ...(forwardPrivateHeaders ? options.headers : {})
        },
        conditional =
          !customUserAgent &&
          cache?.resourceSHA256 === profileHash(address) &&
          !!(cache.etag || cache.lastModified)
      if (conditional && cache) {
        if (cache.etag) headers['if-none-match'] = cache.etag
        else if (cache.lastModified) headers['if-modified-since'] = cache.lastModified
      }
      const response = await requestOnce(address, {
        method: 'GET',
        headers,
        timeout: remaining(),
        maxBytes: PROFILE_BYTE_LIMIT,
        proxy: { host: '127.0.0.1', port: request.proxyPort },
        signal,
        captureRedirects: true
      })
      remaining()
      if (response.status === 304) {
        if (!conditional || !cache) throw new Error()
        const metadata = responseMetadata(response.headers, address, 304, cache)
        remaining()
        return { status: 'notModified', metadata }
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = textHeader(response.headers, 'location')
        if (options.redirects === 'none' || !location || hop === 5) throw new Error()
        const nextRequest = subscriptionRequest({
            name: 'Redirect',
            url: new URL(location, target).toString(),
            proxyPort
          }),
          next = new URL(nextRequest.url),
          cross = next.origin !== target.origin
        if (
          (target.protocol === 'https:' && next.protocol !== 'https:') ||
          (cross && (options.redirects !== 'https' || next.protocol !== 'https:'))
        )
          throw new Error()
        if (cross) forwardPrivateHeaders = false
        target = next
        continue
      }
      if (
        response.status !== 200 ||
        (response.headers['content-encoding'] !== undefined &&
          response.headers['content-encoding'] !== 'identity') ||
        response.body.includes('\ufffd') ||
        response.body.includes('\0')
      )
        throw new Error()
      const text = await decryptSource(response.body, options.ageSecretKey),
        inspected = inspectProfile(text),
        s = inspected.summary
      if (
        Buffer.byteLength(text) > PROFILE_BYTE_LIMIT ||
        inspected.structure !== 'passed' ||
        !s ||
        !(s.proxies || s.groups || s.proxyProviders)
      )
        throw new Error()
      const metadata = responseMetadata(response.headers, address, 200)
      // A temporary User-Agent may select a different representation. Do not
      // reuse its conditional validators on a later normal or scheduled run.
      if (customUserAgent) {
        delete metadata.etag
        delete metadata.lastModified
      }
      remaining()
      return {
        status: 'downloaded',
        text,
        metadata
      }
    }
    throw new Error()
  } catch {
    throw new Error('订阅请求／重定向／缓存／解密或结构检查未通过；未重试、直连或保存。')
  }
}
