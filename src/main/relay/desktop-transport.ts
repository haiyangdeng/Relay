import { spawn } from 'child_process'
import { validateDesktopResponse, type RelayDesktopResponse } from '../../shared/relay/desktop'
import type { RelayStateContext } from './context'

type Action = 'initialize' | 'status' | 'start' | 'restore' | 'cancel' | 'close'
export interface RelayDesktopTransport {
  ready: Promise<RelayDesktopResponse>
  request(action: Exclude<Action, 'initialize'>): Promise<RelayDesktopResponse>
  gone(): boolean
}
export interface RelayDesktopIO {
  write(data: string): void
  end(): void
  onData(listener: (data: Buffer) => void): void
  onGone(listener: () => void): void
  onFault(listener: () => void): void
}

export function createDesktopChannel(
  io: RelayDesktopIO,
  context: RelayStateContext,
  onUncertain: () => void,
  timeout = 30000
): RelayDesktopTransport {
  let nextID = 0,
    ended = false,
    faulted = false,
    normalClose = false,
    buffer = Buffer.alloc(0)
  const retired = new Set<number>()
  const pending = new Map<
    number,
    {
      action: Action
      resolve(value: RelayDesktopResponse): void
      reject(error: Error): void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  const error = (): Error =>
    new Error('桌面会话结果未确认；保留窗口并核对恢复记录，没有自动重试或强制停止后台进程。')
  const fail = (): void => {
    if (faulted) return
    faulted = true
    onUncertain()
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error())
    }
    pending.clear()
    // EOF asks the native host to recover. Never kill an outstanding setter.
    try {
      io.end()
    } catch {
      /* already disconnected */
    }
  }
  io.onFault(fail)
  io.onGone(() => {
    ended = true
    if (!normalClose) fail()
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error())
    }
    pending.clear()
  })
  io.onData((chunk) => {
    if (faulted) return
    buffer = Buffer.concat([buffer, chunk])
    while (true) {
      const newline = buffer.indexOf(10)
      if (newline < 0) break
      if (newline > 65536) {
        fail()
        return
      }
      const line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      try {
        const response = validateDesktopResponse(JSON.parse(line.toString('utf8')))
        const entry = pending.get(response.id)
        if (!entry) {
          if (retired.delete(response.id)) continue
          throw error()
        }
        if (response.closing && entry.action !== 'close') throw error()
        if (
          entry.action === 'initialize' &&
          (response.snapshot.phase !== 'idle' ||
            response.snapshot.hasRecord ||
            response.snapshot.busy)
        )
          throw error()
        pending.delete(response.id)
        clearTimeout(entry.timer)
        if (response.closing) normalClose = true
        entry.resolve(response)
      } catch {
        fail()
        return
      }
    }
    if (buffer.length > 65536) fail()
  })
  const request = (action: Action): Promise<RelayDesktopResponse> =>
    new Promise((resolve, reject) => {
      if (ended || faulted || normalClose || pending.size >= 16) {
        reject(error())
        return
      }
      const id = ++nextID
      const timer = setTimeout(() => {
        pending.delete(id)
        retired.add(id)
        onUncertain()
        reject(error())
        if (retired.size > 32) fail()
      }, timeout)
      pending.set(id, { action, resolve, reject, timer })
      try {
        io.write(
          JSON.stringify({ id, action, ...(action === 'initialize' ? { context } : {}) }) + '\n'
        )
      } catch {
        fail()
      }
    })
  return { ready: request('initialize'), request, gone: () => ended }
}

export function openDesktopTransport(
  executable: string,
  context: RelayStateContext,
  onUncertain: () => void
): RelayDesktopTransport {
  const child = spawn(executable, ['--desktop-session'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  child.stderr.resume()
  return createDesktopChannel(
    {
      write: (data) => {
        child.stdin.write(data)
      },
      end: () => {
        child.stdin.end()
      },
      onData: (listener) => {
        child.stdout.on('data', listener)
      },
      onGone: (listener) => {
        child.on('close', listener)
      },
      onFault: (listener) => {
        child.on('error', listener)
        child.stdin.on('error', listener)
        child.stdout.on('error', listener)
      }
    },
    context,
    onUncertain
  )
}
