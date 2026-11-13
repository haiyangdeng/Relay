import { describe, expect, it, vi } from 'vitest'
import { createTrayTrafficFrameGate } from './tray-traffic-frame'

function header(width = 156, height = 36): string {
  const bytes = Buffer.alloc(33)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return `data:image/png;base64,${bytes.toString('base64')}`
}

describe('Tray traffic render reply admission', () => {
  it('forwards only the current frame once with a bounded fixed-size PNG header', () => {
    const gate = createTrayTrafficFrameGate(() => 100),
      paint = vi.fn()
    const old = gate.request(paint),
      id = gate.request(paint)
    gate.receive({ id: old, png: header() })
    gate.receive({ id, png: header(157) })
    gate.receive({ id, png: header() })
    expect(paint).not.toHaveBeenCalled()
    const next = gate.request(paint)
    gate.receive({ id: next, png: header() })
    gate.receive({ id: next, png: header() })
    expect(paint).toHaveBeenCalledOnce()
    expect(paint.mock.calls[0][0]).toHaveLength(33)
  })

  it('drops replies across timeout, clock rollback and visibility cancellation', () => {
    let now = 1000
    const gate = createTrayTrafficFrameGate(() => now),
      paint = vi.fn()
    const expired = gate.request(paint)
    now += 950
    gate.receive({ id: expired, png: header() })
    const rollback = gate.request(paint)
    now--
    gate.receive({ id: rollback, png: header() })
    const hidden = gate.request(paint)
    gate.cancel()
    gate.receive({ id: hidden, png: header() })
    expect(paint).not.toHaveBeenCalled()
  })
})
