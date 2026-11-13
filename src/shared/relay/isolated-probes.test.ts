import { describe, expect, it } from 'vitest'
import {
  isolatedProbeRequest,
  probeMeasurementSummary,
  type IsolatedProbeResult
} from './isolated-probes'

describe('Isolated delay request settings', () => {
  const request = {
    profile: { id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) },
    target: 'PROXY',
    kind: 'groupDelay',
    provider: 'ip.sb'
  }
  const delay = {
    url: 'https://www.gstatic.com/generate_204',
    timeout: 5000,
    selections: { PROXY: 'Node A', GLOBAL: 'PROXY' }
  }
  it('retains the legacy request and pins a copied delay selection snapshot', () => {
    expect(isolatedProbeRequest(request)).toEqual(request)
    const result = isolatedProbeRequest({ ...request, delay })
    expect(result).toEqual({ ...request, delay })
    expect(result.delay?.selections).not.toBe(delay.selections)
  })
  it.each(['ip', 'latency'])('does not expand %s requests with delay controls', (kind) => {
    expect(isolatedProbeRequest({ ...request, kind })).toEqual({ ...request, kind })
    expect(() => isolatedProbeRequest({ ...request, kind, delay })).toThrow('测速参数')
  })
  it.each([
    { timeout: 999 },
    { timeout: 10001 },
    { timeout: 1000.5 },
    { timeout: '5000' },
    { url: 'file:///tmp/local' },
    { url: 'https://user:secret@example.com/' },
    { url: 'https://example.com/#token' },
    { url: 'https://bad_label.example.com/' },
    { url: 'https://-bad.example.com/' },
    { url: 'https://bad..example.com/' },
    { url: 'https://example.com/\n' },
    { selections: { PROXY: '' } },
    { selections: { 'bad\nname': 'Node A' } },
    { selections: { PROXY: 'bad\u007fname' } },
    { selections: { PROXY: 3 } },
    { selections: [] },
    { unknown: true }
  ])('rejects malformed delay controls %#', (override) => {
    expect(() => isolatedProbeRequest({ ...request, delay: { ...delay, ...override } })).toThrow()
  })
  it('bounds the selection snapshot and accepts the timeout endpoints', () => {
    const selections = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`G${i}`, 'A']))
    for (const timeout of [1000, 10000])
      expect(
        isolatedProbeRequest({ ...request, delay: { ...delay, timeout, selections } }).delay
      ).toEqual({ ...delay, timeout, selections })
    expect(() =>
      isolatedProbeRequest({
        ...request,
        delay: { ...delay, selections: { ...selections, excess: 'A' } }
      })
    ).toThrow()
  })
  it('defers public-address admission to Main without performing a DNS lookup', () => {
    for (const url of [
      'http://127.0.0.1/check',
      'https://[::1]/check',
      'https://example.com./check'
    ])
      expect(isolatedProbeRequest({ ...request, delay: { ...delay, url } }).delay?.url).toBe(url)
  })
})

describe('Node measurement outcome is distinct from request completion', () => {
  function result(delays: (number | null)[]): IsolatedProbeResult {
    return {
      status: 'completed',
      kind: 'groupDelay',
      isolated: true,
      measurements: delays.map((milliseconds, index) => ({ name: String(index), milliseconds }))
    }
  }
  it('does not present an all-failed completed request as a successful speed test', () => {
    expect(probeMeasurementSummary(result([null]))).toContain('未取得延迟')
    expect(probeMeasurementSummary(result([null]))).not.toContain('测速完成')
    expect(probeMeasurementSummary(result([]))).toContain('未取得延迟')
  })
  it('separates partial results, success and cancellation', () => {
    expect(probeMeasurementSummary(result([40, null]))).toContain('1 项成功、1 项超时')
    expect(probeMeasurementSummary(result([40, 50]))).toContain('测速完成')
    expect(probeMeasurementSummary({ ...result([]), status: 'cancelled' })).toBe('已取消测速。')
  })
  it('distinguishes setup failures from completed network timeouts', () => {
    const failed = { name: 'unsupported', milliseconds: null, error: '节点配置不支持独立测速' }
    expect(probeMeasurementSummary({ ...result([]), measurements: [failed] })).toContain('未能测速')
    expect(
      probeMeasurementSummary({
        ...result([]),
        measurements: [...result([40, null]).measurements, failed]
      })
    ).toContain('1 项成功、1 项超时、1 项无法测试')
  })
})
