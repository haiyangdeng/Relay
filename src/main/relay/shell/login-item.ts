import type { RelayLoginItemResult, RelayLoginItemState } from '../../../shared/relay/shell'

// Only the current packaged app is addressed. No legacy login-item cleanup,
// executable path, startup arguments or persisted grant is accepted from IPC.
export function createLoginItemService(adapters: {
  identity(): { supported: boolean; executable: string }
  read(): { openAtLogin: boolean }
  state(): Promise<RelayLoginItemState>
  write(enabled: boolean): void
  confirm(enabled: boolean): Promise<boolean>
  assertIdle(): void
  now?(): number
}) {
  let pending = false
  const waiters: (() => void)[] = [],
    now = adapters.now ?? Date.now
  const identity = (): string => {
    const value = adapters.identity()
    if (!value.supported || !value.executable) throw new Error('登录项仅支持已打包的macOS Relay。')
    return value.executable
  }
  const read = (): boolean => {
    const value = adapters.read().openAtLogin
    if (typeof value !== 'boolean') throw new Error('系统登录项状态未确认。')
    return value
  }
  const assertReadable = (): void => {
    if (pending) throw new Error('登录项操作尚未结束。')
    identity()
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    read(): boolean {
      assertReadable()
      return read()
    },
    state(): Promise<RelayLoginItemState> {
      assertReadable()
      return adapters.state()
    },
    async set(enabled: boolean): Promise<RelayLoginItemResult> {
      if (typeof enabled !== 'boolean') throw new Error('登录项开关无效。')
      if (pending) throw new Error('登录项操作尚未结束。')
      adapters.assertIdle()
      const executable = identity()
      pending = true
      try {
        const before = read(),
          preparedAt = now()
        if (before === enabled) return { status: 'unchanged', openAtLogin: before, warnings: [] }
        if (!(await adapters.confirm(enabled)))
          return { status: 'cancelled', openAtLogin: read(), warnings: [] }
        adapters.assertIdle()
        if (identity() !== executable || now() < preparedAt || now() - preparedAt > 60000)
          throw new Error('确认期间应用身份或有效期已变化，请重新操作。')
        if (read() !== before) throw new Error('系统登录项已被其他操作修改，请重新读取。')
        let acknowledged = true
        try {
          adapters.write(enabled)
        } catch {
          acknowledged = false
        }
        // Service Management may require separate OS approval. Never infer
        // enabled from a successful setter or retry an uncertain mutation.
        try {
          const actual = read()
          if (actual === enabled)
            return {
              status: 'applied',
              openAtLogin: actual,
              warnings: acknowledged ? [] : ['写入回执中断，已重新读取确认登录项状态。']
            }
          return {
            status: 'uncertain',
            openAtLogin: actual,
            warnings: ['系统尚未确认目标登录项状态，请在系统设置中核对；没有自动重试。']
          }
        } catch {
          return { status: 'uncertain', warnings: ['登录项写入后状态无法读取，请手动核对。'] }
        }
      } finally {
        pending = false
        waiters.splice(0).forEach((resolve) => resolve())
      }
    }
  }
}
