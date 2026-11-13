import { randomUUID } from 'crypto'
import {
  type RelayArtifact,
  type RelayArtifactResult,
  type RelayGeneratedArtifacts,
  type RelayPreviewInput,
  type RelayPreviewOutput,
  type RelaySimulationOutput,
  type RelayEdgeProfileOutput,
  type RelayGuardPlanOutput,
  type RelayPreferences,
  type RelayPreferenceSnapshot,
  validateArtifactAction,
  validateGenerateRequest
} from '../../shared/relay/protocol'

export interface RelayArtifactAdapters {
  configuration(input: RelayPreviewInput): Promise<RelayPreviewOutput>
  simulation(): Promise<RelaySimulationOutput>
  edgeProfile(): Promise<RelayEdgeProfileOutput>
  guardPlan(node: string, evidenceId: string): Promise<RelayGuardPlanOutput>
  handoff(): Promise<string>
  readPreferences(): Promise<RelayPreferenceSnapshot>
  savePreferences(preferences: RelayPreferences, revision: string): Promise<RelayPreferenceSnapshot>
  copy(content: string): void
  chooseSave(filename: string): Promise<string | undefined>
  write(destination: string, content: string): Promise<void>
}

// Generated text is retained only for this window session. Export accepts an ID,
// never renderer-supplied content, commands or paths. Cancel means no write.
export function createArtifactService(adapters: RelayArtifactAdapters): {
  generate(raw: unknown): Promise<RelayGeneratedArtifacts>
  action(raw: unknown): Promise<RelayArtifactResult>
  clear(): void
} {
  type Remember = { preferences: RelayPreferences; revision: string }
  const documents = new Map<string, RelayArtifact & { remember?: Remember }>()
  let generation = 0
  let exporting = false
  const artifact = (title: string, filename: string, content: string): RelayArtifact => ({
    id: randomUUID(),
    title,
    filename,
    content
  })
  return {
    async generate(raw) {
      const request = validateGenerateRequest(raw)
      const started = generation
      let result: RelayGeneratedArtifacts
      let remember: Remember | undefined
      let rememberedId: string | undefined
      if (request.kind === 'configuration') {
        const value = await adapters.configuration(request.input)
        result = {
          artifacts: [
            artifact('Settings JSON 草稿', 'claude-settings-draft.json', value.settingsJSON),
            artifact('完整配置方案', 'Claude-Codex-Network-Plan.md', value.plan),
            artifact('域名规则片段', 'ai-domain-rules.yaml', value.rules),
            artifact('DNS 策略片段', 'ai-dns-policy.yaml', value.dns),
            artifact('专用入口片段', 'ai-browser-listener.yaml', value.listeners)
          ],
          warnings: value.warnings
        }
        try {
          const snapshot = await adapters.readPreferences()
          const { httpPort, node, internalExceptions } = request.input
          remember = {
            preferences: { httpPort, node, internalExceptions },
            revision: snapshot.revision
          }
          rememberedId = result.artifacts[1].id
        } catch {
          result.warnings = [
            ...result.warnings,
            '偏好版本未读取，完整方案仍可导出；本次导出不会记住参数。'
          ]
        }
      } else if (request.kind === 'simulation') {
        const value = await adapters.simulation()
        const content = [
          '# Claude 禁止直连：离线策略模拟',
          '',
          '当前未启用真实过滤器。下面只验证策略函数，不代表实际网络已经受保护。',
          '',
          ...value.rows.map(
            (row) =>
              `- ${row.passed ? '通过' : '失败'}：${row.name}；预期 ${row.expected}，结果 ${row.actual}`
          ),
          '',
          ...value.warnings
        ].join('\n')
        result = {
          artifacts: [artifact('离线模拟结果', 'Claude-Guard-Simulation.md', content)],
          warnings: value.warnings
        }
      } else if (request.kind === 'edgeProfile') {
        const value = await adapters.edgeProfile()
        result = {
          artifacts: [
            artifact(
              'Edge 描述文件（尚未安装）',
              'Claude-Edge-Network.mobileconfig',
              value.profileXML
            )
          ],
          warnings: value.warnings
        }
      } else if (request.kind === 'guardPlan') {
        const value = await adapters.guardPlan(request.node, request.evidenceId)
        result = {
          artifacts: [
            artifact('禁止直连待验收部署方案', 'Claude-Guard-Deployment-Plan.md', value.plan)
          ],
          warnings: value.warnings
        }
      } else {
        result = {
          artifacts: [
            artifact(
              '旧版完整交接参考',
              'AI-Network-Handoff-Reference.md',
              await adapters.handoff()
            )
          ],
          warnings: [
            '这是旧版迁移参考，不代表 Relay 当前已实现文档中全部操作。只查看或导出文本，不执行文档内代码。'
          ]
        }
      }
      if (generation !== started) throw new Error('生成结果已过期，请重新生成。')
      for (const document of result.artifacts)
        documents.set(document.id, {
          ...document,
          remember: document.id === rememberedId && remember ? structuredClone(remember) : undefined
        })
      while (documents.size > 32) {
        const oldest = documents.keys().next().value
        if (oldest !== undefined) documents.delete(oldest)
      }
      return result
    },
    async action(raw) {
      const request = validateArtifactAction(raw)
      const document = documents.get(request.id)
      if (!document) throw new Error('生成结果已过期，请重新生成。')
      if (exporting) throw new Error('请先完成或取消当前导出。')
      if (request.action === 'copy') {
        try {
          adapters.copy(document.content)
          return { status: 'copied' }
        } catch {
          throw new Error('未能复制生成结果。')
        }
      }
      exporting = true
      const started = generation
      try {
        const destination = await adapters.chooseSave(document.filename)
        if (!destination) return { status: 'cancelled' }
        if (generation !== started)
          return { status: 'cancelled', warning: '生成结果已过期，请重新生成。' }
        await adapters.write(destination, document.content)
        if (document.remember) {
          if (generation === started) {
            try {
              const { preferences, revision } = document.remember
              const preferenceSnapshot = await adapters.savePreferences(preferences, revision)
              if (generation === started) {
                document.remember.revision = preferenceSnapshot.revision
                return { status: 'saved', preferenceSnapshot }
              }
            } catch {
              // The export has already been written. Report the preference separately.
            }
          }
          return {
            status: 'saved',
            warning: '文本已导出；偏好保存结果未确认，请重新读取后核对。没有应用客户端或网络配置。'
          }
        }
        return { status: 'saved' }
      } catch {
        throw new Error('导出未完成；没有应用网络配置。')
      } finally {
        exporting = false
      }
    },
    clear() {
      generation++
      documents.clear()
    }
  }
}
