import { randomUUID } from 'node:crypto'
import {
  trayTrafficFrameHeight,
  trayTrafficFrameLimit,
  trayTrafficFrameWidth,
  trayTrafficPNGPrefix
} from '../../../shared/relay/tray-traffic-frame'

const frameLeaseMS = 950
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function framePNG(value: unknown): Buffer | undefined {
  if (
    typeof value !== 'string' ||
    value.length > trayTrafficFrameLimit ||
    !value.startsWith(trayTrafficPNGPrefix)
  )
    return undefined
  const encoded = value.slice(trayTrafficPNGPrefix.length)
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) return undefined
  const bytes = Buffer.from(encoded, 'base64')
  if (
    bytes.length < 33 ||
    !bytes.subarray(0, 8).equals(pngSignature) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString('ascii', 12, 16) !== 'IHDR' ||
    bytes.readUInt32BE(16) !== trayTrafficFrameWidth ||
    bytes.readUInt32BE(20) !== trayTrafficFrameHeight
  )
    return undefined
  return bytes
}

export function createTrayTrafficFrameGate(now = (): number => performance.now()) {
  let pending: { id: string; issued: number; paint(bytes: Buffer): void } | undefined
  return {
    request(paint: (bytes: Buffer) => void): string {
      const id = randomUUID()
      pending = { id, issued: now(), paint }
      return id
    },
    cancel(): void {
      pending = undefined
    },
    receive(raw: unknown): void {
      if (!pending || !raw || typeof raw !== 'object' || Array.isArray(raw)) return
      const { id, png } = raw as Record<string, unknown>
      if (id !== pending.id || Object.keys(raw).length !== 2) return
      const current = pending
      pending = undefined
      const age = now() - current.issued
      if (!Number.isFinite(age) || age < 0 || age >= frameLeaseMS) return
      const bytes = framePNG(png)
      if (bytes) current.paint(bytes)
    }
  }
}
