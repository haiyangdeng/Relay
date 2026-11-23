import type { Readable, Writable } from 'node:stream'
import type { TunSessionBinding } from './service'
import type { LocalProxyGroup } from '../../../shared/relay/local-proxy'
import { restoreSavedSelectors } from '../core/startup-node'

export type ProxyGroupAction =
  | { action: 'groups' }
  | { action: 'select'; group: string; member: string }
  | { action: 'automatic'; group: string }
export type ProxyTable = Record<string, Record<string, unknown>>
export type ProxyGroupChannel = (action: ProxyGroupAction) => Promise<ProxyTable>

const automaticTypes = ['URLTest', 'Fallback', 'Smart']

// Mihomo exposes the calculated winner in now and a separate manual override in fixed.
export function tunGroupSelections(nodes: ProxyTable) {
  return Object.values(nodes).flatMap((node) => {
    if (node.type !== 'Selector' && !automaticTypes.includes(String(node.type))) return []
    if (
      typeof node.name !== 'string' ||
      !Array.isArray(node.all) ||
      !node.all.every((m): m is string => typeof m === 'string')
    )
      throw new Error('TUN 代理组成员未确认。')
    const current = node.type === 'Selector' ? node.now : node.fixed
    if (
      typeof current !== 'string' ||
      (node.type === 'Selector' && !current) ||
      (current && !node.all.includes(current))
    )
      throw new Error('TUN 代理组的节点选择未确认。')
    return [{ name: node.name, now: current || null, members: node.all }]
  })
}

export async function restoreTunSavedSelectors(
  channel: ProxyGroupChannel | undefined,
  saved: Map<string, string>,
  live: () => void
): Promise<void> {
  if (!channel) throw new Error('此 TUN 组件无法恢复上次选择的节点。')
  const table = await channel({ action: 'groups' })
  live()
  const rows = Object.fromEntries(
    [...saved]
      .filter(([name, member]) => {
        if (!Object.hasOwn(table, name)) return false
        const members = table[name].all
        return Array.isArray(members) && members.includes(member)
      })
      .map(([name]) => [name, table[name]])
  )
  const groups = tunGroupSelections(rows).map(({ name, now, members }): LocalProxyGroup => ({
    name,
    members,
    confirmed: true,
    // The shared restore distinguishes ordinary selectors from manually fixed
    // automatic groups; the latter use fixed even if their current winner matches.
    ...(rows[name].type === 'Selector'
      ? { type: 'select', now: now ?? undefined }
      : { fixed: now ?? undefined })
  }))
  await restoreSavedSelectors(
    {
      select: async (group, member) => {
        await channel({ action: 'select', group, member })
      },
      group: async (name) => {
        const current = await channel({ action: 'groups' })
        return Object.hasOwn(current, name) ? current[name] : {}
      }
    },
    groups,
    saved,
    live
  )
}

export async function applyTunFixedGroups(
  channel: ProxyGroupChannel | undefined,
  groups: readonly { name: string; member: string }[],
  live: () => void
): Promise<void> {
  if (!groups.length) return
  if (!channel) throw new Error('此 TUN 组件无法继承已固定的自动组选项。')
  for (const group of groups) {
    live()
    await channel({ action: 'select', group: group.name, member: group.member })
  }
  live()
  const actual = await channel({ action: 'groups' })
  live()
  for (const { name, member } of groups) {
    const row = actual[name]
    if (!row || !automaticTypes.includes(String(row.type)) || row.fixed !== member)
      throw new Error('TUN 未确认自动组的固定节点。')
  }
}

export function createProxyGroupChannel(
  input: Writable,
  output: Readable,
  binding: TunSessionBinding,
  clientSHA256: string,
  installationRevision: string
): ProxyGroupChannel {
  let ready = false,
    closed = false,
    id = 0,
    size = 0,
    queued = 0
  let chunks: Buffer[] = []
  let pending:
    | {
        action: string
        resolve(value: ProxyTable): void
        reject(reason: Error): void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  const unavailable = (): Error => new Error('TUN 核心的代理组读取或选取未确认，请刷新。')
  const fail = (): void => {
    closed = true
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(unavailable())
      pending = undefined
    }
    chunks = []
    size = 0
  }
  const consume = (frame: Buffer): void => {
    const value = JSON.parse(frame.toString('utf8'))
    if (
      value.version !== 4 ||
      Object.entries(binding).some(([key, expected]) => value[key] !== expected)
    )
      throw unavailable()
    if (!ready) {
      if (
        value.kind !== 'hello' ||
        value.capability !== 'proxy-groups-v1' ||
        value.installationRevision !== installationRevision ||
        value.launchClientSHA256 !== clientSHA256
      )
        throw unavailable()
      ready = true
      return
    }
    const job = pending
    if (!job || value.id !== id || value.action !== job.action) throw unavailable()
    if (value.status === 'groups' && typeof value.groupsBase64 === 'string') {
      const result = JSON.parse(Buffer.from(value.groupsBase64, 'base64').toString('utf8'))
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw unavailable()
      job.resolve(result)
    } else job.reject(unavailable())
    clearTimeout(job.timer)
    pending = undefined
  }
  output.on('data', (buffer: Buffer) => {
    if (closed) return
    try {
      let start = 0
      while (start < buffer.length) {
        const newline = buffer.indexOf(10, start)
        const chunk = buffer.subarray(start, newline < 0 ? buffer.length : newline)
        size += chunk.length
        if (size > 8 * 1024 * 1024) throw unavailable()
        chunks.push(chunk)
        if (newline < 0) break
        consume(Buffer.concat(chunks, size))
        chunks = []
        size = 0
        start = newline + 1
      }
    } catch {
      fail()
    }
  })
  output.on('end', fail)
  output.on('error', fail)
  input.on('error', fail)
  let tail = Promise.resolve()
  return (request) => {
    if (closed || queued >= 16) return Promise.reject(unavailable())
    ++queued
    const result = tail.then(
      () =>
        new Promise<ProxyTable>((resolve, reject) => {
          if (!ready || closed) return reject(unavailable())
          pending = { action: request.action, resolve, reject, timer: setTimeout(fail, 12000) }
          input.write(
            JSON.stringify({ ...binding, version: 4, id: ++id, ...request }) + '\n',
            (error) => {
              if (error) fail()
            }
          )
        })
    )
    tail = result
      .then(
        () => {},
        () => {}
      )
      .finally(() => {
        --queued
      })
    return result
  }
}
