import { execFile } from 'child_process'
import {
  automaticUninstallExecutableTrusted,
  automaticUninstallSupervisor
} from './automatic-uninstall'

// The installed supervisor revalidates the root-owned uninstall intent and
// bound UID, then proves the dedicated profile, live code and process start
// time before asking that one application to terminate normally. Main never
// supplies a PID, executable, browser name, profile path or force-quit option.
export async function closePrivateBrowserForUninstall(): Promise<void> {
  if (!(await automaticUninstallExecutableTrusted(automaticUninstallSupervisor)))
    throw new Error('Relay 专用浏览器卸载入口未确认，保留恢复记录。')
  await new Promise<void>((resolve, reject) => {
    const child = execFile(
      automaticUninstallSupervisor,
      ['--user-stop-browser'],
      { timeout: 20000, maxBuffer: 4096, encoding: 'utf8' },
      (error) => (error ? reject(error) : resolve())
    )
    child.stdin?.end()
  })
}
