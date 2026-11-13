import {
  localProxyPlan,
  localProxyPlanRecord,
  type LocalProxyPlan,
  type LocalProxyPlanRecord
} from '../../../../shared/relay/local-proxy-plan'

export async function saveLocalProxyPlan(
  record: LocalProxyPlanRecord | undefined,
  document: LocalProxyPlan,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
  current: () => boolean
): Promise<LocalProxyPlanRecord> {
  const check = (): void => {
    if (!current()) throw new Error('启动设置或页面已变化，请重新操作。')
  }
  check()
  if (!record) throw new Error('启动设置尚未读取，不能使用默认值覆盖保存。')
  const previous = localProxyPlanRecord(record),
    expected = localProxyPlan(document)
  const saved = localProxyPlanRecord(
    await invoke('relayLocalProxyPlanSave', {
      document: expected,
      expectedRevision: previous.revision
    })
  )
  check()
  if (!saved.exists || JSON.stringify(saved.document) !== JSON.stringify(expected))
    throw new Error('启动设置保存结果未确认。')
  return saved
}

// The form may receive full saved nodes, but keeps only names. Main validates
// the actual compiled adapter again, including all canonical field aliases.
export function dedicatedNodeOptions(nodes: Record<string, unknown>[]): string[] {
  return nodes.flatMap((node) => {
    if (
      typeof node.name !== 'string' ||
      typeof node.type !== 'string' ||
      ['direct', 'reject', 'dns', 'rematch'].includes(node.type.toLowerCase()) ||
      Object.entries(node).some(
        ([key, value]) =>
          key.replaceAll('_', '-').toLowerCase() === 'dialer-proxy' &&
          value !== undefined &&
          value !== null &&
          value !== ''
      )
    )
      return []
    try {
      localProxyPlan({
        httpPort: 18191,
        resolverMode: 'profile',
        dedicated: { httpPort: 18193, socksPort: 18190, route: node.name }
      })
      return [node.name]
    } catch {
      return []
    }
  })
}
