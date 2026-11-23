import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { RelayLoginItemState } from '../../../shared/relay/shell'

const exec = promisify(execFile)
const statusScript = `
ObjC.import('Foundation')
ObjC.import('ServiceManagement')
function run(argv) {
  return String($.SMAppService.statusForLegacyURL($.NSURL.fileURLWithPath(argv[0])))
}`
type Approval = RelayLoginItemState['approval']
const statuses: Readonly<Record<string, Approval>> = {
  '0': 'notRegistered',
  '1': 'enabled',
  '2': 'requiresApproval',
  '3': 'notFound'
}

async function readCommand(executable: string, args: string[]): Promise<string> {
  const { stdout } = await exec(executable, args, {
    encoding: 'utf8',
    timeout: 2500,
    maxBuffer: 256 * 1024
  })
  return stdout.trim()
}

export async function readLoginItemApproval(
  path: string,
  uid: number,
  command = readCommand
): Promise<Approval> {
  try {
    const value = await command('/usr/bin/osascript', [
      '-l',
      'JavaScript',
      '-e',
      statusScript,
      path
    ])
    const approval = Object.hasOwn(statuses, value) ? statuses[value] : 'unknown'
    if (approval !== 'enabled') return approval
    // A per-user launchctl override can separately prevent an approved job from loading.
    const overrides = await command('/bin/launchctl', ['print-disabled', `gui/${uid}`])
    const lines = overrides
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.shift() !== 'disabled services = {' || lines.pop() !== '}') return 'unknown'
    for (const line of lines) {
      const entry = /^"([^"]+)"\s*=>\s*(enabled|disabled)$/.exec(line)
      if (!entry || (entry[1] === 'local.relay.network.login' && entry[2] === 'disabled'))
        return 'unknown'
    }
    return 'enabled'
  } catch {
    return 'unknown'
  }
}
