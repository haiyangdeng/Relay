import { isIP } from 'net'
import { sourceSchedule } from '../subscriptions/source-options'
import { isForbiddenHost } from '../../resolve/plugin/net-guard'
import { profileSelection } from '../../../shared/relay/runtime'
import type { SubStoreAdvancedStart } from '../../../shared/relay/substore'
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export function subStoreAdvancedStart(raw: unknown): SubStoreAdvancedStart {
  if (
    !object(raw) ||
    Object.keys(raw).sort().join(',') !==
      'allowLan,backendURL,downloadCron,mode,profile,syncCron,target,uploadCron' ||
    !['local', 'remote'].includes(String(raw.mode)) ||
    typeof raw.allowLan !== 'boolean' ||
    typeof raw.target !== 'string' ||
    !raw.target ||
    raw.target.length > 256 ||
    [...raw.target].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    typeof raw.backendURL !== 'string' ||
    raw.backendURL.length > 2048
  )
    throw new Error('Sub-Store独立启动设置无效。')
  const cron = (value: unknown): string => {
    if (typeof value !== 'string' || value.length > 256) throw new Error('Sub-Store定时规则无效。')
    if (!value) return ''
    const result = sourceSchedule({ kind: 'cron', expression: value })
    if (result.kind !== 'cron') throw new Error('Sub-Store定时规则无效。')
    return result.expression
  }
  const result: SubStoreAdvancedStart = {
    profile: profileSelection(raw.profile),
    target: raw.target,
    mode: raw.mode as 'local' | 'remote',
    allowLan: raw.allowLan,
    backendURL: raw.backendURL,
    syncCron: cron(raw.syncCron),
    downloadCron: cron(raw.downloadCron),
    uploadCron: cron(raw.uploadCron)
  }
  if (result.mode === 'remote') {
    const url = new URL(result.backendURL)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== result.backendURL ||
      isForbiddenHost(url.hostname) ||
      (!isIP(url.hostname) && !url.hostname.includes('.')) ||
      /\/(?:\.|%2e)(?:\.|%2e)?(?:\/|$)/iu.test(url.pathname) ||
      url.pathname.includes('//') ||
      /%(?:2f|5c|00)/iu.test(url.pathname)
    )
      throw new Error('自定义后端仅接受规范公网HTTPS基址，不接受用户信息、查询或跳转。')
    if (result.allowLan || result.syncCron || result.downloadCron || result.uploadCron)
      throw new Error('自定义后端的监听和任务由其宿主管理。')
  } else if (result.backendURL) throw new Error('本地后端不接受额外后端地址。')
  return result
}
