import { describe, expect, it } from 'vitest'
import { createCoreLogBuffer } from './log-buffer'

describe('Bounded owned core output', () => {
  it('preserves UTF-8 across chunks and keeps stdout and stderr partial lines separate', () => {
    const buffer = createCoreLogBuffer(),
      bytes = Buffer.from('你好\n')
    buffer.append(bytes.subarray(0, 2))
    buffer.append(Buffer.from('warning\n'), 'stderr')
    buffer.append(bytes.subarray(2))
    expect(buffer.snapshot()).toEqual(['warning', '你好'])
  })
  it('never exceeds the byte or line budget with large Unicode output and partial lines', () => {
    const buffer = createCoreLogBuffer()
    buffer.append(Buffer.from('旧记录\n'.repeat(1000)))
    buffer.append(Buffer.from('测'.repeat(100000) + '\n'))
    buffer.append(Buffer.from('中'.repeat(30000)))
    buffer.append(Buffer.from('文'.repeat(30000)), 'stderr')
    const lines = buffer.snapshot()
    expect(lines.length).toBeLessThanOrEqual(512)
    expect(lines.reduce((sum, line) => sum + Buffer.byteLength(line), 0)).toBeLessThanOrEqual(65536)
    expect(lines.join('')).toContain('[日志行已截断]')
  })
  it('returns a detached snapshot rather than mutable backing storage', () => {
    const buffer = createCoreLogBuffer()
    buffer.append(Buffer.from('first\n'))
    const first = buffer.snapshot()
    buffer.append(Buffer.from('second\n'))
    expect(first).toEqual(['first'])
    expect(buffer.snapshot()).toEqual(['first', 'second'])
  })
  it('preserves the sequence of partial lines on completion and advances across ring eviction', () => {
    const buffer = createCoreLogBuffer()
    buffer.append(Buffer.from('same\npartial'))
    buffer.append(Buffer.from('stderr'), 'stderr')
    const cleared = buffer.sequencedSnapshot()
    buffer.append(Buffer.from(' done\nsame\n'))
    buffer.append(Buffer.from(' done\n'), 'stderr')
    const next = buffer.sequencedSnapshot()
    expect(next.lines.filter((line) => line.sequence > cleared.sequence)).toEqual([
      { sequence: 4, text: 'same' }
    ])
    expect(next.lines.find((line) => line.sequence === 2)?.text).toBe('partial done')
    expect(cleared.lines.find((line) => line.sequence === 2)?.text).toBe('partial')
    buffer.append(Buffer.from('again\n'.repeat(512)))
    expect(buffer.sequencedSnapshot().lines[0]).toEqual({ sequence: 5, text: 'again' })
  })
  it('retains fresh large output even when a cleared partial line fills the remaining byte budget', () => {
    const buffer = createCoreLogBuffer()
    buffer.append(Buffer.from('old'.repeat(10000)), 'stderr')
    const latest = 'n'.repeat(60000)
    buffer.append(Buffer.from(`${latest}\n`))
    expect(buffer.sequencedSnapshot()).toEqual({
      sequence: 2,
      lines: [{ sequence: 2, text: latest }]
    })
  })
})
