import { afterEach, describe, expect, it, vi } from 'vitest'
import { stopOwnedChild } from './shutdown'

afterEach(() => vi.useRealTimers())

describe('Shutdown policy for a held owned child handle', () => {
  it('accepts a confirmed polite exit without a force signal or pending timer', async () => {
    vi.useFakeTimers()
    let closed!: () => void
    const acknowledgement = new Promise<void>((resolve) => {
      closed = resolve
    })
    const child = {
      kill: vi.fn(() => {
        closed()
        return true
      })
    }
    await stopOwnedChild(child, acknowledgement, 'localProxy')
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('retains an unconfirmed traffic instance without SIGKILL even after its deadline', async () => {
    vi.useFakeTimers()
    const child = { kill: vi.fn(() => true) }
    const result = stopOwnedChild(child, new Promise<void>(() => {}), 'localProxy')
    const rejection = expect(result).rejects.toThrow('未强制结束')
    await vi.advanceTimersByTimeAsync(3000)
    await rejection
    await vi.advanceTimersByTimeAsync(30000)
    expect(child.kill.mock.calls).toEqual([['SIGTERM']])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('allows the previous scoped force fallback only for an inert owned child', async () => {
    vi.useFakeTimers()
    let closed!: () => void
    const acknowledgement = new Promise<void>((resolve) => {
      closed = resolve
    })
    const child = {
      kill: vi.fn((signal: 'SIGTERM' | 'SIGKILL') => {
        if (signal === 'SIGKILL') closed()
        return true
      })
    }
    const result = stopOwnedChild(child, acknowledgement, 'inert')
    await vi.advanceTimersByTimeAsync(3000)
    await result
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })
  it('reports an unconfirmed inert exit rather than assuming its signals succeeded', async () => {
    vi.useFakeTimers()
    const child = { kill: vi.fn(() => false) }
    const result = stopOwnedChild(child, new Promise<void>(() => {}), 'inert')
    const rejection = expect(result).rejects.toThrow('退出未确认')
    await vi.advanceTimersByTimeAsync(5000)
    await rejection
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']])
  })
})
