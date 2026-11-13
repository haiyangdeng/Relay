import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { Duplex } from 'stream'
import { describe, expect, it } from 'vitest'
import { createTunRuntimeReader } from './runtime-channel'

const executable = resolve('.relay-build/tun-runtime-capture/RelayTunRuntimeCaptureTests-arm64')
const identity = {
  sessionId: '33333333-3333-4333-8333-333333333333',
  evidenceSHA256: 'e'.repeat(64),
  runtimeConfigurationSHA256: 'a'.repeat(64),
  launchClientSHA256: 'c'.repeat(64),
  installationRevision: 'd'.repeat(64)
}

async function fixture(
  run: (f: Awaited<ReturnType<typeof open>>) => Promise<void>,
  options: { wrongSHA?: boolean; dropResponses?: boolean; delayResponses?: boolean } = {}
): Promise<void> {
  const f = await open(options)
  try {
    await run(f)
  } finally {
    f.request.end()
    f.response.destroy()
    f.child.stdin?.end()
    await new Promise<void>((done) => {
      const timer = setTimeout(() => {
        f.child.kill()
        done()
      }, 1000).unref()
      f.child.once('close', () => {
        clearTimeout(timer)
        done()
      })
    })
  }
}
async function open(options: {
  wrongSHA?: boolean
  dropResponses?: boolean
  delayResponses?: boolean
}) {
  const child = spawn(executable, ['--channel-fixture'], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe']
    }),
    request = child.stdio[3],
    response = child.stdio[4]
  if (!(request instanceof Duplex) || !(response instanceof Duplex))
    throw new Error('Missing inherited fixture pipes')
  let writes = 0,
    received = 0,
    output = '',
    delayedOnce = false,
    release: (() => void) | undefined
  let delayed!: () => void
  const responseDelayed = new Promise<void>((done) => {
    delayed = done
  })
  child.stdout?.setEncoding('utf8').on('data', (text: string) => {
    output += text
  })
  const reader = createTunRuntimeReader(
    {
      write: (frame) => {
        ++writes
        request.write(frame)
      },
      onData: (callback) =>
        response.on('data', (chunk: Buffer) => {
          ++received
          if (received > 1 && options.dropResponses) return
          if (received > 1 && options.delayResponses && !delayedOnce) {
            delayedOnce = true
            release = () => callback(chunk)
            delayed()
            return
          }
          callback(chunk)
        }),
      onGone: (callback) => response.on('end', callback),
      onFault: (callback) => {
        request.on('error', callback)
        response.on('error', callback)
      }
    },
    { ...identity, ...(options.wrongSHA ? { launchClientSHA256: 'b'.repeat(64) } : {}) },
    500
  )
  const echo = async (): Promise<void> => {
    const text = `probe-${Date.now()}`
    child.stdin?.write(text + '\n')
    await new Promise<void>((done, reject) => {
      const limit = setTimeout(() => {
        clearInterval(timer)
        reject(new Error('Fixture control pipe did not answer'))
      }, 1000)
      const timer = setInterval(() => {
        if (output.includes('control-alive:' + text)) {
          clearInterval(timer)
          clearTimeout(limit)
          done()
        }
      }, 5)
    })
    expect(child.exitCode).toBeNull()
  }
  return {
    child,
    request,
    response,
    reader,
    echo,
    responseDelayed,
    writes: () => writes,
    release: () => {
      const next = release
      release = undefined
      next?.()
    }
  }
}

// Actual separately compiled Native channel, ordinary UID and inherited pipes.
// Its test-only callback returns metadata; no installation, Core or TUN is used.
describe.skipIf(!existsSync(executable))('TUN TypeScript to Native read channel isolation', () => {
  it('accepts the exact Native hello and captures metadata while control stays usable', async () => {
    await fixture(async (f) => {
      expect(await f.reader.capture(new AbortController().signal)).toEqual({
        status: 'captured',
        snapshot: {
          originalLoadedSHA256: 'a'.repeat(64),
          originalLoadedBytes: 128,
          mode: 'rule',
          ports: [{ kind: 'http', port: 18080, ownership: 'held-child-pcb-v1' }]
        }
      })
      expect(f.writes()).toBe(1)
      await f.echo()
    })
  })
  it('does not send any read or lifecycle command on a mismatched launched client pin', async () => {
    await fixture(
      async (f) => {
        expect(await f.reader.capture(new AbortController().signal)).toEqual({
          status: 'unsupported'
        })
        expect(f.writes()).toBe(0)
        await f.echo()
      },
      { wrongSHA: true }
    )
  })
  it('keeps control alive after read response EOF and sends no fallback command', async () => {
    await fixture(async (f) => {
      expect((await f.reader.capture(new AbortController().signal)).status).toBe('captured')
      f.response.destroy()
      // A local loss notification is the same endpoint signal as real stream EOF.
      f.response.emit('end')
      expect((await f.reader.capture(new AbortController().signal)).status).toBe('unsupported')
      expect(f.writes()).toBe(1)
      await f.echo()
    })
  })
  it('times out a lost response without closing the control pipe or retrying', async () => {
    await fixture(
      async (f) => {
        expect((await f.reader.capture(new AbortController().signal)).status).toBe('unavailable')
        expect(f.writes()).toBe(1)
        await f.echo()
      },
      { dropResponses: true }
    )
  })
  it('retires an aborted response and can capture again on the same live Native host', async () => {
    await fixture(
      async (f) => {
        const abort = new AbortController(),
          pending = f.reader.capture(abort.signal)
        await f.responseDelayed
        abort.abort()
        expect((await pending).status).toBe('unavailable')
        expect((await f.reader.capture(new AbortController().signal)).status).toBe('busy')
        expect(f.writes()).toBe(1)
        f.release()
        await f.echo()
        expect(f.reader.isAvailable()).toBe(true)
        expect((await f.reader.capture(new AbortController().signal)).status).toBe('captured')
        expect(f.writes()).toBe(2)
      },
      { delayResponses: true }
    )
  })
  it('does not terminate Native when the response peer closes before a later write', async () => {
    await fixture(async (f) => {
      expect((await f.reader.capture(new AbortController().signal)).status).toBe('captured')
      f.response.destroy()
      f.request.write(
        JSON.stringify({
          version: 1,
          action: 'capture',
          id: 2,
          sessionId: identity.sessionId,
          evidenceSHA256: identity.evidenceSHA256,
          runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256
        }) + '\n'
      )
      await new Promise((done) => setTimeout(done, 80))
      await f.echo()
    })
  })
})
