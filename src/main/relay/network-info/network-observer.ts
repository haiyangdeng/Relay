import { execFile } from 'child_process'
import { lstat, realpath } from 'fs/promises'
import { basename, isAbsolute } from 'path'
import { readBinaryResource, resourceHash } from '../resources/source'

export interface ProbeNetworkObservation {
  networkSHA256: string
  protectionSHA256: string
  existingTunnel: boolean
}

export function probeNetworkObservation(raw: unknown, uid: number): ProbeNetworkObservation {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('只读网络观察结果无效。')
  const report = raw as Record<string, unknown>
  if (
    !Number.isSafeInteger(uid) ||
    uid <= 0 ||
    Object.keys(report).sort().join(',') !==
      'existingTunnel,networkSHA256,protectionSHA256,role,uid,version' ||
    report.version !== 1 ||
    report.role !== 'probe-network-observer' ||
    report.uid !== uid ||
    typeof report.existingTunnel !== 'boolean' ||
    ![report.networkSHA256, report.protectionSHA256].every(
      (value) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
    )
  )
    throw new Error('只读网络观察身份或摘要未确认。')
  return {
    networkSHA256: report.networkSHA256 as string,
    protectionSHA256: report.protectionSHA256 as string,
    existingTunnel: report.existingTunnel
  }
}

type Identity = Awaited<ReturnType<typeof lstat>>
function sameFile(a: Identity, b: Identity): boolean {
  return ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].every(
    (key) => a[key as keyof Identity] === b[key as keyof Identity]
  )
}

// Only Main supplies this fixed bundled path. No installed helper, root path,
// caller pathname, authorization prompt or mutation command is used.
export async function inspectProbeNetwork(executable: string): Promise<ProbeNetworkObservation> {
  const uid = process.getuid?.()
  if (
    process.platform !== 'darwin' ||
    !uid ||
    process.geteuid?.() !== uid ||
    !isAbsolute(executable) ||
    basename(executable) !== 'RelayNetworkObserver'
  )
    throw new Error('只读网络观察仅接受本次应用随包的普通用户组件。')
  const identity = await lstat(executable)
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.nlink !== 1 ||
    ![0, uid].includes(identity.uid) ||
    identity.mode & 0o7022 ||
    !(identity.mode & 0o111) ||
    identity.size < 1 ||
    identity.size > 16 * 1024 * 1024 ||
    (await realpath(executable)) !== executable
  )
    throw new Error('随包只读网络观察组件的路径或权限无效。')
  const digest = resourceHash(await readBinaryResource(executable))
  if (!sameFile(identity, await lstat(executable))) throw new Error('随包只读网络观察组件已变化。')
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      ['--inspect'],
      {
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 2048,
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        windowsHide: true
      },
      (error, output) => {
        if (error) reject(new Error('只读网络状态未能完整读取；本次测速未继续。'))
        else resolve(output)
      }
    )
  })
  if (
    !sameFile(identity, await lstat(executable)) ||
    resourceHash(await readBinaryResource(executable)) !== digest ||
    !sameFile(identity, await lstat(executable))
  )
    throw new Error('读取期间只读网络观察组件已变化。')
  return probeNetworkObservation(JSON.parse(stdout), uid)
}
