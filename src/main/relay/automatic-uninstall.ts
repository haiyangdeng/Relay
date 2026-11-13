import { execFile } from 'child_process'
import { watch } from 'fs'
import { lstat } from 'fs/promises'

export const automaticUninstallDirectory = '/Library/Application Support/Relay/Uninstall'
export const automaticUninstallNative = `${automaticUninstallDirectory}/RelayNative`
export const automaticUninstallSupervisor = `${automaticUninstallDirectory}/RelayUninstallSupervisor`

export async function automaticUninstallExecutableTrusted(executable: string): Promise<boolean> {
  if (![automaticUninstallNative, automaticUninstallSupervisor].includes(executable)) return false
  try {
    for (const path of [
      '/Library',
      '/Library/Application Support',
      '/Library/Application Support/Relay',
      automaticUninstallDirectory,
      executable
    ]) {
      const info = await lstat(path)
      if (info.uid !== 0 || info.isSymbolicLink() || (info.mode & 0o7022) !== 0) return false
      if (path === executable) {
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o755) return false
      } else if (!info.isDirectory()) return false
    }
    return true
  } catch {
    return false
  }
}

// Never run a resource from the moved application or an executable named by a
// user-writable request. The installed native program validates the manifest,
// intent generation, UID/home and its own digest before acknowledging intent.
export async function automaticUninstallRequested(): Promise<boolean> {
  try {
    if (!(await automaticUninstallExecutableTrusted(automaticUninstallNative))) return false
    const output = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        automaticUninstallNative,
        ['--automatic-uninstall-status'],
        { timeout: 3000, maxBuffer: 4096, encoding: 'utf8' },
        (error, stdout) => (error ? reject(error) : resolve(stdout))
      )
      child.stdin?.end()
    })
    const status: unknown = JSON.parse(output)
    if (!status || typeof status !== 'object' || Array.isArray(status)) return false
    const value = status as Record<string, unknown>
    return (
      Object.keys(value).sort().join(',') === 'nativeExecutable,requested' &&
      value.requested === true &&
      value.nativeExecutable === automaticUninstallNative
    )
  } catch {
    // Missing, unreadable or invalid installation/intent is not removal consent.
    return false
  }
}

export async function prepareAutomaticUninstall(options: {
  platform: NodeJS.Platform
  packaged: boolean
  uid: number | undefined
  args: string[]
  disableLoginItem(): void
  loginItemEnabled(): boolean
  probe?: () => Promise<boolean>
}): Promise<boolean> {
  if (
    options.platform !== 'darwin' ||
    !options.packaged ||
    !Number.isSafeInteger(options.uid) ||
    (options.uid ?? 0) <= 0 ||
    options.args.length !== 1 ||
    options.args[0] !== '--relay-uninstall-prepare'
  )
    return false
  try {
    if (!(await (options.probe ?? automaticUninstallRequested)())) return false
    options.disableLoginItem()
    return options.loginItemEnabled() === false
  } catch {
    return false
  }
}

type IntentWatcher = { close(): void }
type AutomaticUninstallOptions = {
  platform: NodeJS.Platform
  packaged: boolean
  onRequested(nativeExecutable: string): void | Promise<void>
  probe?: () => Promise<boolean>
  watchIntent?: (changed: () => void, failed: () => void) => IntentWatcher
}

export function startAutomaticUninstallMonitor(options: AutomaticUninstallOptions): {
  stop(): void
} {
  if (options.platform !== 'darwin' || !options.packaged) return { stop: () => {} }
  const probe = options.probe ?? automaticUninstallRequested
  const watchIntent =
    options.watchIntent ??
    ((changed, failed) => {
      const watcher = watch(automaticUninstallDirectory, { persistent: false }, changed)
      watcher.on('error', failed)
      watcher.on('close', failed)
      return watcher
    })
  let stopped = false,
    pending = false,
    watchGeneration = 0,
    watcher: IntentWatcher | undefined
  const check = async (): Promise<void> => {
    if (stopped || pending) return
    pending = true
    try {
      if (!watcher) {
        try {
          const generation = ++watchGeneration
          watcher = watchIntent(
            () => void check(),
            () => {
              if (generation !== watchGeneration) return
              ++watchGeneration
              const previous = watcher
              watcher = undefined
              previous?.close()
            }
          )
        } catch {
          // The legacy installer has no directory. Polling also discovers an
          // installation published after startup without watching user paths.
        }
      }
      if ((await probe()) && !stopped) await options.onRequested(automaticUninstallNative)
    } catch {
      // A failed drain retains ownership/recovery records. A later authenticated
      // intent check may retry; never turn an error into a force-quit.
    } finally {
      pending = false
    }
  }
  // Watch notifications can be coalesced/lost and directories can be replaced.
  // This bounded, unreferenced fallback also retries incomplete owned cleanup.
  const timer = setInterval(() => void check(), 2000)
  timer.unref()
  void check()
  return {
    stop: () => {
      stopped = true
      ++watchGeneration
      clearInterval(timer)
      const previous = watcher
      watcher = undefined
      previous?.close()
    }
  }
}
