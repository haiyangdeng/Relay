import { setTimeout as delay } from 'timers/promises'
import type { ResourceCheckResult } from '../../../shared/relay/resources'
import { startOwnedCore } from '../core/owned-runtime'
import {
  resourceCheckDefinition,
  resourceRuleEntries,
  type ResourceValidationJob
} from './check-definition'

export type { ResourceCheckResult } from '../../../shared/relay/resources'
export async function checkResourceWithCore(
  resourceRoot: string,
  job: ResourceValidationJob,
  assertLive?: () => void
): Promise<ResourceCheckResult> {
  let cleanup: (() => Promise<void>) | undefined
  const result: ResourceCheckResult = {
    status: 'notVerified',
    resourceSHA256: job.sha256,
    warnings: []
  }
  try {
    assertLive?.()
    const entries = resourceRuleEntries(job)
    if (job.descriptor.kind === 'runtime-file')
      return {
        ...result,
        status: 'requiresResources',
        warnings: ['文件摘要已核对；证书、密钥或其他文件须绑定完整配置后校验，本次未启动核心。']
      }
    if (entries.needsDependencies)
      return {
        ...result,
        status: 'requiresResources',
        warnings: ['规则集依赖地理资源，需在完整配置中连同其缓存验证；本次未启动核心。']
      }
    const config = resourceCheckDefinition(job.descriptor)
    const core = await startOwnedCore(
      resourceRoot,
      JSON.stringify(config.configuration),
      'inert',
      (stop) => {
        cleanup = stop
      },
      job,
      assertLive
    )
    assertLive?.()
    result.coreVersion = core.version
    const live = await core.read('configs', assertLive ? { assertLive } : undefined)
    assertLive?.()
    if (
      live.port !== 0 ||
      live['mixed-port'] !== 0 ||
      !live.tun ||
      typeof live.tun !== 'object' ||
      (live.tun as Record<string, unknown>).enable !== false
    )
      throw new Error()
    if (job.descriptor.kind.startsWith('rule-')) {
      const deadline = performance.now() + 4000
      do {
        const report = await core.read('providers/rules', assertLive ? { assertLive } : undefined),
          providers = report.providers
        assertLive?.()
        const item =
          providers && typeof providers === 'object' && !Array.isArray(providers)
            ? (providers as Record<string, unknown>).resource
            : undefined
        const count =
          item && typeof item === 'object' && !Array.isArray(item)
            ? (item as Record<string, unknown>).ruleCount
            : undefined
        if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
          result.ruleCount = count
          break
        }
        await delay(50)
        assertLive?.()
      } while (performance.now() < deadline)
      if (
        !result.ruleCount ||
        (entries.expected !== undefined && result.ruleCount !== entries.expected)
      )
        throw new Error()
    }
    result.status = 'passed'
    result.warnings = [
      '固定核心已在无代理监听／DNS／TUN的私有检查实例中接受资源。' +
        (job.descriptor.kind === 'rule-mrs'
          ? '验证MRS有界结构与声明计数；'
          : '验证所选类型／条目及完整文本规则数量；') +
        '不代表数据来源可信度、数据库覆盖、外网连通或在用配置已启用。'
    ]
  } catch {
    result.warnings = [
      '资源格式、条目、完整规则数量或隔离核心未确认，未启用；原缓存保留，禁止自动下载依赖。'
    ]
  } finally {
    try {
      await cleanup?.()
    } catch {
      result.status = 'uncertain'
      result.warnings.push('本次检查实例清理未确认，保留证据；未操作其他核心。')
    }
  }
  try {
    assertLive?.()
  } catch {
    if (result.status !== 'uncertain') result.status = 'notVerified'
    result.warnings.push('本次界面范围已失效；未发布可用检查回执。')
  }
  return result
}
