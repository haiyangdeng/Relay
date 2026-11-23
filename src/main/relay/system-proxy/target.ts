import { createConnection } from 'net'
import type { SystemProxySettings } from '../../../shared/relay/system-proxy'

// Only checks the user-selected endpoint. It neither changes configuration nor
// treats a reachable port as proof of the process, protocol or no-direct guard.
export function verifyProxyTarget(
  settings: Pick<SystemProxySettings, 'host' | 'port'>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: settings.host, port: settings.port })
    let done = false
    const finish = (error?: Error): void => {
      if (done) return
      done = true
      socket.destroy()
      error ? reject(new Error('所选代理端口未就绪；没有修改系统代理。')) : resolve()
    }
    socket.setTimeout(2000, () => finish(new Error('timeout')))
    socket.once('error', (error) => finish(error))
    socket.once('connect', () => finish())
  })
}
