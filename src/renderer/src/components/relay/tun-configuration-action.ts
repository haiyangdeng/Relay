import type { RelayProfileInventory } from '../../../../shared/relay/profiles'
import type {
  CompleteConfigurationPlan,
  CompleteConfigurationResult
} from '../../../../shared/relay/configuration'

export async function readTunProfileId(
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
): Promise<string> {
  const config = (await invoke('getProfileConfig', true)) as IProfileConfig
  if (config.current) return config.current
  const inventory = (await invoke('relayProfileList')) as RelayProfileInventory
  const id = inventory.profiles[0]?.id
  if (!id) throw new Error('没有可用配置，请先导入或选择配置。')
  return id
}

export async function prepareCurrentTunConfiguration(
  profileId: string,
  options: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>
    current(): boolean
  }
): Promise<string> {
  const check = (): void => {
    if (!options.current()) throw new Error('当前配置已变化或页面已关闭，请重新开启。')
  }
  check()
  const inventory = (await options.invoke('relayProfileList')) as RelayProfileInventory
  check()
  const profile = inventory.profiles.find((item) => item.id === profileId)
  if (!profile) throw new Error('没有可用配置，请先导入或选择配置。')
  const plan = (await options.invoke('relayTunConfigurationPrepare', {
    intent: 'enable',
    profile: { id: profile.id, sha256: profile.sha256 }
  })) as CompleteConfigurationPlan
  check()
  if (plan.profileId !== profile.id || !plan.readyForParserCheck)
    throw new Error(plan.warnings.join(' ') || '当前配置缺少资源，请在高级配置中绑定后重试。')
  const checked = (await options.invoke('relayCompleteConfigurationCheck', {
    evidenceId: plan.evidenceId
  })) as CompleteConfigurationResult
  check()
  if (checked.status !== 'passed' || checked.configurationSHA256 !== plan.configurationSHA256)
    throw new Error(checked.warnings.join(' ') || '当前配置检查未通过，未启用虚拟网卡。')
  return plan.evidenceId
}
