import { EventEmitter } from 'events'
import { PassThrough } from 'stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateDesktopAction, validateDesktopResponse } from '../../shared/relay/desktop'
import { createDesktopChannel, openDesktopTransport } from './desktop-transport'
import { desktopResponse } from './__fixtures__/desktop-session'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('child_process', () => ({ spawn: mocks.spawn }))
const context = {
  home: '/fixture/home',
  stateRoot: '/fixture/home/Library/Application Support/Relay-Preview'
}
function harness() {
  let data: (bytes: Buffer) => void = () => {},
    gone: () => void = () => {},
    fault: () => void = () => {}
  const write = vi.fn(),
    end = vi.fn(),
    uncertain = vi.fn()
  const channel = createDesktopChannel(
    {
      write,
      end,
      onData: (callback) => {
        data = callback
      },
      onGone: (callback) => {
        gone = callback
      },
      onFault: (callback) => {
        fault = callback
      }
    },
    context,
    uncertain,
    1000
  )
  const send = (value: unknown) => data(Buffer.from(JSON.stringify(value) + '\n'))
  return {
    channel,
    write,
    end,
    uncertain,
    send,
    bytes: (value: Buffer) => data(value),
    gone: () => gone(),
    fault: () => fault()
  }
}
afterEach(() => {
  vi.useRealTimers()
  mocks.spawn.mockReset()
})
describe('Persistent desktop channel', () => {
  it('frames input, validates the fixed context and assembles split responses', async () => {
    const h = harness()
    expect(JSON.parse(h.write.mock.calls[0][0])).toEqual({ id: 1, action: 'initialize', context })
    const frame = Buffer.from(JSON.stringify(desktopResponse()) + '\n')
    h.bytes(frame.subarray(0, 5))
    h.bytes(frame.subarray(5))
    expect((await h.channel.ready).snapshot.phase).toBe('idle')
    const request = h.channel.request('start')
    expect(JSON.parse(h.write.mock.calls[1][0])).toEqual({ id: 2, action: 'start' })
    h.send(desktopResponse(2, 'active'))
    expect((await request).snapshot.hasRecord).toBe(true)
    h.gone()
    expect(h.uncertain).toHaveBeenCalledTimes(1)
  })
  it('times out without killing or disconnecting an outstanding setter, and accepts a later close handshake', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.send(desktopResponse())
    await h.channel.ready
    const request = h.channel.request('start'),
      rejected = expect(request).rejects.toThrow('未确认')
    await vi.advanceTimersByTimeAsync(1001)
    await rejected
    expect(h.end).not.toHaveBeenCalled()
    const close = h.channel.request('close')
    h.send(desktopResponse(3, 'idle', true))
    expect((await close).closing).toBe(true)
    h.send(desktopResponse(2, 'active')) // Retired response cannot replay work.
    h.gone()
    expect(h.uncertain).toHaveBeenCalledTimes(1)
    expect(h.channel.gone()).toBe(true)
  })
  it('asks native recovery through EOF for malformed output and never exposes raw bytes', async () => {
    const h = harness(),
      rejected = expect(h.channel.ready).rejects.not.toThrow('PRIVATE')
    h.bytes(Buffer.from('PRIVATE malformed\n'))
    await rejected
    expect(h.end).toHaveBeenCalledTimes(1)
    expect(h.uncertain).toHaveBeenCalledTimes(1)
  })
  it('bounds stdout and rejects unsolicited IDs and forged close claims', async () => {
    for (const bytes of [
      Buffer.alloc(65537, 65),
      Buffer.from(JSON.stringify(desktopResponse(2)) + '\n'),
      Buffer.from(JSON.stringify(desktopResponse(1, 'idle', true)) + '\n')
    ]) {
      const h = harness(),
        rejected = expect(h.channel.ready).rejects.toThrow('未确认')
      h.bytes(bytes)
      await rejected
      expect(h.end).toHaveBeenCalledTimes(1)
    }
  })
  it('requests native EOF recovery when a close acknowledgment still contains a record', async () => {
    const h = harness()
    h.send(desktopResponse())
    await h.channel.ready
    const request = h.channel.request('close'),
      rejected = expect(request).rejects.toThrow('未确认'),
      reply = desktopResponse(2, 'recoveryNeeded', true)
    reply.snapshot.canClose = true
    h.send(reply)
    await rejected
    expect(h.end).toHaveBeenCalledTimes(1)
    expect(h.uncertain).toHaveBeenCalledTimes(1)
    h.gone()
    expect(h.uncertain).toHaveBeenCalledTimes(1)
  })
  it('spawns only the fixed native operation with pipes and no shell, kill timer or stderr forwarding', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    mocks.spawn.mockReturnValue(child)
    const uncertain = vi.fn(),
      transport = openDesktopTransport('/fixture/RelayNative', context, uncertain)
    expect(mocks.spawn).toHaveBeenCalledWith('/fixture/RelayNative', ['--desktop-session'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    child.stderr.write('PRIVATE ignored')
    child.stdout.write(JSON.stringify(desktopResponse()) + '\n')
    await transport.ready
    const close = transport.request('close')
    child.stdout.write(JSON.stringify(desktopResponse(2, 'idle', true)) + '\n')
    await close
    child.emit('close', 0)
    expect(uncertain).not.toHaveBeenCalled()
  })
  it('rejects action path injection and inconsistent recovery consent', () => {
    expect(() => validateDesktopAction({ action: 'start', path: '/private' })).toThrow()
    expect(() => validateDesktopAction({ action: 'close' })).toThrow()
    expect(() => validateDesktopAction({ action: { toString: () => 'start' } })).toThrow()
    const value = desktopResponse()
    value.snapshot.requiresRecoveryConsent = true
    expect(() => validateDesktopResponse(value)).toThrow()
  })
})
