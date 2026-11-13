import { Button, Switch } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { showErrorSync } from '@renderer/utils/error-display'
import { DnsSettingsView } from '@renderer/components/dns/dns-settings-view'
import { useRelayInitialRead } from '@renderer/hooks/use-relay-initial-read'
import { useRelayDnsConfig } from '@renderer/hooks/use-relay-dns-config'
import type { RelayDnsDraft } from '@renderer/utils/relay-dns-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { mihomoHotReloadConfig } from '@renderer/utils/ipc'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_CONTROL_DNS,
  DEFAULT_MIHOMO_DNS_CONFIG,
  DEFAULT_USE_NAMESERVER_POLICY
} from '../../../shared/appConfig'

const DNS: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { appConfig, patchAppConfig } = useAppConfig()
  const {
    nameserverPolicy,
    useNameserverPolicy = DEFAULT_USE_NAMESERVER_POLICY,
    controlDns = DEFAULT_CONTROL_DNS,
    disableDnsOverrideGuard = false,
    operationMode = 'standard'
  } = appConfig || {}
  const { dns, hosts } = controledMihomoConfig || {}
  const {
    enable = DEFAULT_MIHOMO_DNS_CONFIG.enable,
    ipv6 = DEFAULT_MIHOMO_DNS_CONFIG.ipv6,
    'fake-ip-range': fakeIPRange = DEFAULT_MIHOMO_DNS_CONFIG['fake-ip-range'],
    'fake-ip-filter': fakeIPFilter = DEFAULT_MIHOMO_DNS_CONFIG['fake-ip-filter'],
    'fake-ip-filter-mode': fakeIPFilterMode = 'blacklist',
    'enhanced-mode': enhancedMode = DEFAULT_MIHOMO_DNS_CONFIG['enhanced-mode'],
    'use-hosts': useHosts = DEFAULT_MIHOMO_DNS_CONFIG['use-hosts'],
    'use-system-hosts': useSystemHosts = DEFAULT_MIHOMO_DNS_CONFIG['use-system-hosts'],
    'respect-rules': respectRules = DEFAULT_MIHOMO_DNS_CONFIG['respect-rules'],
    'default-nameserver': defaultNameserver = DEFAULT_MIHOMO_DNS_CONFIG['default-nameserver'],
    nameserver = DEFAULT_MIHOMO_DNS_CONFIG.nameserver,
    'proxy-server-nameserver': proxyServerNameserver = DEFAULT_MIHOMO_DNS_CONFIG[
      'proxy-server-nameserver'
    ],
    'direct-nameserver': directNameserver = DEFAULT_MIHOMO_DNS_CONFIG['direct-nameserver'],
    fallback = DEFAULT_MIHOMO_DNS_CONFIG.fallback,
    'fallback-filter': fallbackFilter = DEFAULT_MIHOMO_DNS_CONFIG['fallback-filter']
  } = dns || {}
  const simpleNameserverPolicy = (dns?.['nameserver-policy'] ||
    {}) as IAppConfig['nameserverPolicy']
  const effectiveNameserverPolicy =
    operationMode === 'simple' ? simpleNameserverPolicy : nameserverPolicy
  const effectiveUseNameserverPolicy =
    operationMode === 'simple'
      ? Object.keys(simpleNameserverPolicy).length > 0
      : useNameserverPolicy
  const [changed, setChanged] = useState(false)
  const [values, originSetValues] = useState({
    enable,
    ipv6,
    useHosts,
    enhancedMode,
    fakeIPRange,
    fakeIPFilter,
    fakeIPFilterMode,
    useSystemHosts,
    respectRules,
    defaultNameserver,
    nameserver,
    proxyServerNameserver,
    directNameserver,
    fallback,
    fallbackGeoip: (fallbackFilter?.geoip ||
      DEFAULT_MIHOMO_DNS_CONFIG['fallback-filter']?.geoip ||
      true) as boolean,
    fallbackGeoipCode:
      fallbackFilter?.['geoip-code'] ||
      DEFAULT_MIHOMO_DNS_CONFIG['fallback-filter']?.['geoip-code'] ||
      'CN',
    fallbackIpcidr:
      fallbackFilter?.ipcidr || DEFAULT_MIHOMO_DNS_CONFIG['fallback-filter']?.ipcidr || [],
    fallbackDomain:
      fallbackFilter?.domain || DEFAULT_MIHOMO_DNS_CONFIG['fallback-filter']?.domain || [],
    useNameserverPolicy: effectiveUseNameserverPolicy,
    nameserverPolicy: Object.entries(effectiveNameserverPolicy || {}).map(([domain, value]) => ({
      domain,
      value
    })),
    hosts: Object.entries(hosts || {}).map(([domain, value]) => ({ domain, value }))
  })

  const setValues = (v: typeof values): void => {
    originSetValues(v)
    setChanged(true)
  }

  const getNameserverPolicy = (): IAppConfig['nameserverPolicy'] => {
    if (!values.useNameserverPolicy) return {}

    return Object.fromEntries(
      values.nameserverPolicy.flatMap(({ domain, value }) => {
        const key = domain.trim()
        const nextValue = Array.isArray(value)
          ? value.map((item) => item.trim()).filter(Boolean)
          : value.trim()

        if (!key || (Array.isArray(nextValue) ? nextValue.length === 0 : !nextValue)) return []
        return [[key, nextValue]]
      })
    )
  }

  const onSave = async (patch: Partial<IMihomoConfig>): Promise<void> => {
    const nextNameserverPolicy = getNameserverPolicy()
    if (operationMode !== 'simple') {
      await patchAppConfig({
        nameserverPolicy: nextNameserverPolicy,
        useNameserverPolicy: values.useNameserverPolicy
      })
    }
    try {
      setChanged(false)
      await patchControledMihomoConfig({
        ...patch,
        dns: patch.dns ? { ...patch.dns, 'nameserver-policy': nextNameserverPolicy } : patch.dns
      })
      if (operationMode !== 'simple' && controlDns) {
        await mihomoHotReloadConfig()
      }
    } catch (e) {
      showErrorSync(e, t('common.error.dnsConfigSaveFailed'))
    }
  }

  return (
    <BasePage
      title={t('dns.title')}
      header={
        changed && (
          <Button
            size="sm"
            className="app-nodrag"
            color="primary"
            onPress={() => {
              const dnsConfig = {
                enable: values.enable,
                ipv6: values.ipv6,
                'fake-ip-range': values.fakeIPRange,
                'fake-ip-filter': values.fakeIPFilter,
                'fake-ip-filter-mode': values.fakeIPFilterMode,
                'enhanced-mode': values.enhancedMode,
                'use-hosts': values.useHosts,
                'use-system-hosts': values.useSystemHosts,
                'respect-rules': values.respectRules,
                'default-nameserver': values.defaultNameserver,
                nameserver: values.nameserver,
                'proxy-server-nameserver': values.proxyServerNameserver,
                'direct-nameserver': values.directNameserver,
                fallback: values.fallback,
                'fallback-filter': {
                  ...(values.fallbackGeoip ? { geoip: values.fallbackGeoip } : {}),
                  'geoip-code': values.fallbackGeoipCode,
                  ipcidr: values.fallbackIpcidr,
                  domain: values.fallbackDomain
                }
              }
              if (values.useNameserverPolicy) {
                dnsConfig['nameserver-policy'] = Object.fromEntries(
                  values.nameserverPolicy.map(({ domain, value }) => [domain, value])
                )
              }
              const result = { dns: dnsConfig }
              if (values.useHosts) {
                result['hosts'] = Object.fromEntries(
                  values.hosts.map(({ domain, value }) => [domain, value])
                )
              }
              onSave(result)
            }}
          >
            {operationMode === 'simple' || controlDns ? t('common.save') : t('dns.saveOnly')}
          </Button>
        )
      }
    >
      <DnsSettingsView
        values={
          {
            ...values,
            controlDns,
            disableDnsOverrideGuard,
            fallbackGeoip: !!values.fallbackGeoip,
            fallbackGeoipCode:
              typeof values.fallbackGeoipCode === 'string' ? values.fallbackGeoipCode : '',
            fallbackIpcidr: Array.isArray(values.fallbackIpcidr) ? values.fallbackIpcidr : [],
            fallbackDomain: Array.isArray(values.fallbackDomain) ? values.fallbackDomain : []
          } as RelayDnsDraft
        }
        onChange={(next) => setValues(next)}
        showEnable={operationMode !== 'simple'}
        onGuardChange={(value) => {
          void patchAppConfig({ disableDnsOverrideGuard: value })
        }}
      />
    </BasePage>
  )
}

export default DNS

export function RelayDnsManager(props: {
  active?: boolean
  busy: boolean
  onBusy(value: boolean): void
  onChanged?(): void
}): React.JSX.Element {
  const config = useRelayDnsConfig(props)
  useRelayInitialRead(props.active ?? true, !!config.draft, config.readLocked, config.read)
  return (
    <section className="relay-panel" aria-label="结构化DNS管理">
      <div className="relay-heading">
        <h2>DNS 设置</h2>
        <span className="text-xs text-default-500">
          {config.dirty ? '有未保存修改' : config.draft ? '已保存设置' : '正在读取'}
        </span>
      </div>
      <div className="relay-action">
        <button disabled={config.readLocked} onClick={() => void config.read()}>
          {config.dirty ? '放弃修改并刷新' : '刷新'}
        </button>
        <button disabled={config.locked || !config.dirty} onClick={() => void config.save()}>
          保存设置
        </button>
      </div>
      <p className="text-xs" role="status">
        {config.notice}
      </p>
      {config.dirty && <p>当前草稿尚未保存；重新读取会放弃这些未保存修改。</p>}
      {config.draft ? (
        <>
          <DnsSettingsView
            values={config.draft}
            onChange={config.update}
            disabled={config.locked}
            showGuard={false}
          />
          <details className="mt-4">
            <summary>高级：覆写与来源保护</summary>
            <Switch
              aria-label="禁用来源DNS保护（全局）"
              isSelected={config.draft.disableDnsOverrideGuard}
              isDisabled={config.locked}
              onValueChange={(value) => {
                if (config.draft)
                  config.update(
                    { ...config.draft, disableDnsOverrideGuard: value },
                    { disableDnsOverrideGuard: true }
                  )
              }}
            >
              禁用来源 DNS 保护
            </Switch>
            <Switch
              aria-label="请求合并受控DNS与hosts"
              isSelected={config.draft.controlDns}
              isDisabled={config.locked}
              onValueChange={(value) => {
                if (config.draft)
                  config.update({ ...config.draft, controlDns: value }, { controlDns: true })
              }}
            >
              请求合并受控DNS与hosts
            </Switch>
            <p>
              关闭受控策略只忽略这份nameserver-policy，来源原有策略可能仍保留。关闭自定义hosts或策略开关不会删除已保存内容。
              DNS
              IPv6只修改dns.ipv6，其他顶层设置保留。保存正文可包含当前可见模板默认值，未显示的已支持字段保留。
            </p>
            <section aria-label="来源DNS保护确认">
              <h3>来源DNS保护确认</h3>
              <p>
                保存合并请求不代表已生效。全局“禁用来源DNS保护”会绕过所有来源保护，和下面仅针对所选来源内容的明确确认不同。
              </p>
              <label>
                DNS保护预览来源
                <select
                  aria-label="DNS保护预览来源"
                  value={config.selected}
                  disabled={config.locked}
                  onChange={(event) => config.select(event.target.value)}
                >
                  <option value="">请选择已保存来源</option>
                  {config.profiles?.profiles.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={config.locked || !config.selected}
                onClick={() => void config.previewSource()}
              >
                预览此来源DNS保护
              </button>
              {config.preview && (
                <div>
                  <p>
                    所选来源 {config.preview.source.id}：请求合并{' '}
                    {String(config.preview.dns.requested)}，当前候选有效{' '}
                    {String(config.preview.dns.effective)}，来源保护已阻止{' '}
                    {String(config.preview.dns.autoDisabled)}。预览没有保存或应用。
                  </p>
                  {config.preview.dns.autoDisabled && config.preview.dns.fingerprint && (
                    <>
                      <p>
                        原来源包含受保护DNS字段。确认仅适用于这份来源及当前受保护内容；改变来源或草稿需重新预览。
                      </p>
                      <button disabled={config.locked} onClick={() => void config.confirmSource()}>
                        确认覆盖此来源DNS并保存草稿
                      </button>
                    </>
                  )}
                </div>
              )}
            </section>
          </details>
        </>
      ) : (
        <p>正在读取保存的 DNS 设置；读取失败时可点刷新。</p>
      )}
      {config.requiresRead && <p>请重新读取核对版本；没有自动重基或重试旧确认。</p>}
      <p className="text-xs">保存后用于下次应用配置，当前连接不变。</p>
    </section>
  )
}
