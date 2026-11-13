import { get } from 'http'
import { describe, expect, it } from 'vitest'
import { defaultPacScript, type SystemProxySettings } from '../../../shared/relay/system-proxy'
import { startPacServer } from './pac'
import { verifyProxyTarget } from './target'

const settings: SystemProxySettings = {
  mode: 'pac',
  host: '127.0.0.1',
  port: 18191,
  socks: false,
  bypass: [],
  excludeSimple: true,
  serviceIDs: ['A'],
  pacScript: defaultPacScript
}
const request = (url: string, method = 'GET'): Promise<{ status?: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = get(url, { method, agent: false, timeout: 2000 }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
  })
describe('Owned loopback PAC service', () => {
  it('serves only the unguessable path, replaces explicit placeholders and never adds direct fallback', async () => {
    const server = await startPacServer({ ...settings, host: '::1' })
    try {
      const response = await request(server.url)
      expect(response.status).toBe(200)
      expect(response.body).toContain('PROXY [::1]:18191;')
      expect(response.body).not.toContain('DIRECT')
      expect((await request(new URL('/pac', server.url).href)).status).toBe(404)
      expect((await request(server.url, 'POST')).status).toBe(404)
      expect((await request(server.url, 'HEAD')).body).toBe('')
      await verifyProxyTarget({ ...settings, port: Number(new URL(server.url).port) })
    } finally {
      await server.close()
      await server.close()
    }
    await expect(request(server.url)).rejects.toThrow()
  })
  it('checks syntax without executing PAC code in the main process', async () => {
    const server = await startPacServer({
      ...settings,
      pacScript:
        'throw new Error("must never execute"); function FindProxyForURL(){ return "DIRECT"; }'
    })
    try {
      expect((await request(server.url)).body).toContain('must never execute')
    } finally {
      await server.close()
    }
    await expect(startPacServer({ ...settings, pacScript: 'function {' })).rejects.toThrow()
  })
})
