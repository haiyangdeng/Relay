import { Button, Tab, Input, Switch, Tabs, Divider } from '@heroui/react'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import { MdDeleteForever } from 'react-icons/md'
import type { Key, ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { RelayDnsDraft, RelayDnsChanges } from '../../utils/relay-dns-config'

type DnsList =
  | 'fakeIPFilter'
  | 'defaultNameserver'
  | 'nameserver'
  | 'proxyServerNameserver'
  | 'directNameserver'
  | 'fallback'
  | 'fallbackIpcidr'
  | 'fallbackDomain'
type DnsRows = 'nameserverPolicy' | 'hosts'
export function DnsSettingsView({
  values,
  onChange,
  disabled = false,
  showEnable = true,
  showGuard = true,
  onGuardChange
}: {
  values: RelayDnsDraft
  onChange(value: RelayDnsDraft, changes: RelayDnsChanges): void
  disabled?: boolean
  showEnable?: boolean
  showGuard?: boolean
  onGuardChange?(value: boolean): void
}): React.JSX.Element {
  const { t } = useTranslation()
  const setValues = (next: RelayDnsDraft): void => {
    const changes: RelayDnsChanges = {}
    for (const key of Object.keys(next) as (keyof RelayDnsDraft)[]) {
      if (next[key] === values[key]) continue
      if (
        key === 'hosts' ||
        key === 'controlDns' ||
        key === 'useNameserverPolicy' ||
        key === 'disableDnsOverrideGuard'
      )
        changes[key] = true
      else changes.dns = true
    }
    onChange(next, changes)
  }
  const handleListChange = (type: DnsList, value: string, index: number): void => {
    const list = [...values[type]]
    if (value.trim()) {
      if (index < list.length) list[index] = value
      else list.push(value)
    } else list.splice(index, 1)
    setValues({ ...values, [type]: list })
  }
  const renderListInputs = (type: DnsList, placeholder: string): ReactNode => {
    const items = values[type]
    return [...items, ...(items.every((item) => item.trim() !== '') ? [''] : [])].map(
      (item, index) => (
        <div key={index} className="mt-2 flex">
          <Input
            fullWidth
            size="sm"
            placeholder={placeholder}
            aria-label={`${placeholder} ${index + 1}`}
            value={item}
            isDisabled={disabled}
            onValueChange={(value) => handleListChange(type, value, index)}
          />
          {index < items.length && (
            <Button
              className="ml-2"
              size="sm"
              variant="flat"
              color="warning"
              aria-label={`删除 ${placeholder} ${index + 1}`}
              isDisabled={disabled}
              onPress={() => handleListChange(type, '', index)}
            >
              <MdDeleteForever className="text-lg" />
            </Button>
          )}
        </div>
      )
    )
  }
  const handleRowDomain = (type: DnsRows, domain: string, index: number): void => {
    const list = [...values[type]],
      row = list[index] ?? { domain: '', value: '' }
    list[index] = { ...row, domain }
    setValues({ ...values, [type]: list })
  }
  const handleSubkeyChange = (
    type: DnsRows,
    domain: string,
    value: string,
    index: number
  ): void => {
    const list = [...values[type]],
      parts = value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
    list[index] = {
      domain,
      value: type === 'hosts' ? parts : parts.length > 1 ? parts : value.trim()
    }
    setValues({ ...values, [type]: list })
  }
  const removeRow = (type: DnsRows, index: number): void => {
    const list = [...values[type]]
    list.splice(index, 1)
    setValues({ ...values, [type]: list })
  }
  return (
    <>
      <SettingCard>
        {showEnable && (
          <SettingItem title={t('dns.enable')} divider>
            <Switch
              size="sm"
              aria-label="DNS启用"
              isDisabled={disabled}
              isSelected={values.enable}
              onValueChange={(v) => {
                setValues({ ...values, enable: v })
              }}
            />
          </SettingItem>
        )}
        {showEnable && showGuard && (
          <SettingItem title={t('dns.overrideGuard.disable')} divider>
            <Switch
              size="sm"
              aria-label="禁用来源DNS保护（全局）"
              isDisabled={disabled}
              isSelected={values.disableDnsOverrideGuard}
              onValueChange={(v) => {
                if (onGuardChange) onGuardChange(v)
                else setValues({ ...values, disableDnsOverrideGuard: v })
              }}
            />
          </SettingItem>
        )}
        <SettingItem title={t('dns.enhancedMode.title')} divider>
          <Tabs
            size="sm"
            color="primary"
            classNames={{ tab: 'w-[4.5rem]' }}
            aria-label="DNS增强模式"
            isDisabled={disabled}
            selectedKey={values.enhancedMode}
            onSelectionChange={(key: Key) => {
              if (key === 'fake-ip' || key === 'redir-host' || key === 'normal')
                setValues({ ...values, enhancedMode: key })
            }}
          >
            <Tab key="fake-ip" title={t('dns.enhancedMode.fakeIp')} />
            <Tab key="redir-host" title={t('dns.enhancedMode.redirHost')} />
            <Tab key="normal" title={t('dns.enhancedMode.normal')} />
          </Tabs>
        </SettingItem>
        {values.enhancedMode === 'fake-ip' ? (
          <>
            <SettingItem title={t('dns.fakeIp.range')} divider>
              <Input
                size="sm"
                className="w-[50%]"
                aria-label="Fake-IP范围"
                isDisabled={disabled}
                value={values.fakeIPRange}
                placeholder={t('dns.fakeIp.rangePlaceholder')}
                onValueChange={(v) => {
                  setValues({ ...values, fakeIPRange: v })
                }}
              />
            </SettingItem>
            <SettingItem title={t('dns.fakeIp.filterMode')} divider>
              <Tabs
                size="sm"
                color="primary"
                classNames={{ tab: 'w-[3.5rem]' }}
                aria-label="Fake-IP过滤模式"
                isDisabled={disabled}
                selectedKey={values.fakeIPFilterMode}
                onSelectionChange={(key: Key) =>
                  setValues({ ...values, fakeIPFilterMode: key as FilterMode })
                }
              >
                <Tab key="blacklist" title={t('dns.fakeIp.filterMode.blacklist')} />
                <Tab key="whitelist" title={t('dns.fakeIp.filterMode.whitelist')} />
                <Tab key="rule" title={t('dns.fakeIp.filterMode.rule')} />
              </Tabs>
            </SettingItem>
            <div className="flex flex-col items-stretch">
              <h3>{t('dns.fakeIp.filter')}</h3>
              {renderListInputs(
                'fakeIPFilter',
                values.fakeIPFilterMode === 'rule'
                  ? t('dns.fakeIp.filterPlaceholder.rule')
                  : t('dns.fakeIp.filterPlaceholder')
              )}
            </div>
            <Divider className="my-2" />
          </>
        ) : null}
        <SettingItem title="IPv6" divider>
          <Switch
            size="sm"
            aria-label="DNS IPv6"
            isDisabled={disabled}
            isSelected={values.ipv6}
            onValueChange={(v) => {
              setValues({ ...values, ipv6: v })
            }}
          />
        </SettingItem>
        <SettingItem title={t('dns.respectRules')} divider>
          <Switch
            size="sm"
            aria-label="DNS遵循规则"
            isDisabled={disabled}
            isSelected={values.respectRules}
            onValueChange={(v) => {
              setValues({ ...values, respectRules: v })
            }}
          />
        </SettingItem>

        <div className="flex flex-col items-stretch">
          <h3>{t('dns.defaultNameserver')} (default-nameserver)</h3>
          {renderListInputs('defaultNameserver', t('dns.defaultNameserverPlaceholder'))}
        </div>
        <Divider className="my-2" />
        <div className="flex flex-col items-stretch">
          <h3>{t('dns.proxyServerNameserver')} (proxy-server-nameserver)</h3>
          {renderListInputs('proxyServerNameserver', t('dns.proxyServerNameserverPlaceholder'))}
        </div>
        <Divider className="my-2" />
        <div className="flex flex-col items-stretch">
          <h3>{t('dns.nameserver')} (nameserver)</h3>
          {renderListInputs('nameserver', t('dns.nameserverPlaceholder'))}
        </div>
        <Divider className="my-2" />
        <div className="flex flex-col items-stretch">
          <h3>{t('dns.directNameserver')} (direct-nameserver)</h3>
          {renderListInputs('directNameserver', t('dns.directNameserverPlaceholder'))}
        </div>
        <Divider className="my-2" />
        <SettingItem title={t('dns.nameserverPolicy.title')} divider>
          <Switch
            size="sm"
            aria-label="合并受控域名DNS策略"
            isDisabled={disabled}
            isSelected={values.useNameserverPolicy}
            onValueChange={(v) => {
              setValues({ ...values, useNameserverPolicy: v })
            }}
          />
        </SettingItem>
        {values.useNameserverPolicy && (
          <div className="flex flex-col items-stretch">
            <div className="flex flex-col items-stretch">
              <h3 className="mb-2">{t('dns.nameserverPolicy.list')}</h3>
              {[...values.nameserverPolicy, { domain: '', value: '' }].map(
                ({ domain, value }, index) => (
                  <div key={index} className="flex mb-2">
                    <div className="flex-4">
                      <Input
                        size="sm"
                        fullWidth
                        placeholder={t('dns.nameserverPolicy.domainPlaceholder')}
                        aria-label={`策略域名 ${index + 1}`}
                        isDisabled={disabled}
                        value={domain}
                        onValueChange={(v) => handleRowDomain('nameserverPolicy', v, index)}
                      />
                    </div>
                    <span className="mx-2">:</span>
                    <div className="flex-6 flex">
                      <Input
                        size="sm"
                        fullWidth
                        placeholder={t('dns.nameserverPolicy.serverPlaceholder')}
                        aria-label={`策略映射值 ${index + 1}`}
                        isDisabled={disabled}
                        value={Array.isArray(value) ? value.join(',') : value}
                        onValueChange={(v) =>
                          handleSubkeyChange('nameserverPolicy', domain, v, index)
                        }
                      />
                      {index < values.nameserverPolicy.length && (
                        <Button
                          size="sm"
                          color="warning"
                          variant="flat"
                          className="ml-2"
                          aria-label={`删除策略 ${index + 1}`}
                          isDisabled={disabled}
                          onPress={() => removeRow('nameserverPolicy', index)}
                        >
                          <MdDeleteForever className="text-lg" />
                        </Button>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        )}
        <SettingItem title={t('dns.systemHosts.title')} divider>
          <Switch
            size="sm"
            aria-label="使用系统hosts"
            isDisabled={disabled}
            isSelected={values.useSystemHosts}
            onValueChange={(v) => {
              setValues({ ...values, useSystemHosts: v })
            }}
          />
        </SettingItem>
        <SettingItem title={t('dns.customHosts.title')}>
          <Switch
            size="sm"
            aria-label="使用自定义hosts"
            isDisabled={disabled}
            isSelected={values.useHosts}
            onValueChange={(v) => {
              setValues({ ...values, useHosts: v })
            }}
          />
        </SettingItem>
        {values.useHosts && (
          <div className="flex flex-col items-stretch">
            <h3 className="mb-2">{t('dns.customHosts.list')}</h3>
            {[...values.hosts, { domain: '', value: '' }].map(({ domain, value }, index) => (
              <div key={index} className="flex mb-2">
                <div className="flex-4">
                  <Input
                    size="sm"
                    fullWidth
                    placeholder={t('dns.customHosts.domainPlaceholder')}
                    aria-label={`hosts域名 ${index + 1}`}
                    isDisabled={disabled}
                    value={domain}
                    onValueChange={(v) => handleRowDomain('hosts', v, index)}
                  />
                </div>
                <span className="mx-2">:</span>
                <div className="flex-6 flex">
                  <Input
                    size="sm"
                    fullWidth
                    placeholder={t('dns.customHosts.valuePlaceholder')}
                    aria-label={`hosts映射值 ${index + 1}`}
                    isDisabled={disabled}
                    value={Array.isArray(value) ? value.join(',') : value}
                    onValueChange={(v) => handleSubkeyChange('hosts', domain, v, index)}
                  />
                  {index < values.hosts.length && (
                    <Button
                      size="sm"
                      color="warning"
                      variant="flat"
                      className="ml-2"
                      aria-label={`删除hosts ${index + 1}`}
                      isDisabled={disabled}
                      onPress={() => removeRow('hosts', index)}
                    >
                      <MdDeleteForever className="text-lg" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <Divider className="my-2" />
        <div className="flex flex-col items-stretch">
          <h3>{t('dns.fallback')}</h3>
          {renderListInputs('fallback', t('dns.fallbackPlaceholder'))}
        </div>
      </SettingCard>
      <SettingCard title={t('dns.fallbackFilter.title')}>
        <SettingItem title={t('dns.fallbackFilter.geoip')} divider>
          <Switch
            size="sm"
            aria-label="回退GeoIP过滤"
            isDisabled={disabled}
            isSelected={values.fallbackGeoip}
            onValueChange={(v) => {
              setValues({ ...values, fallbackGeoip: v })
            }}
          />
        </SettingItem>
        <SettingItem title={t('dns.fallbackFilter.geoipCode')} divider>
          <Input
            size="sm"
            className="w-25"
            aria-label="回退GeoIP国家代码"
            isDisabled={disabled}
            value={typeof values.fallbackGeoipCode === 'string' ? values.fallbackGeoipCode : ''}
            placeholder="CN"
            onValueChange={(v) => {
              setValues({ ...values, fallbackGeoipCode: v })
            }}
          />
        </SettingItem>
        <div className="flex flex-col items-stretch">
          <h3>{t('dns.fallbackFilter.ipcidr')}</h3>
          {renderListInputs('fallbackIpcidr', t('dns.fallbackFilter.ipcidrPlaceholder'))}
        </div>
        <Divider className="my-2" />
        <div className="flex flex-col items-stretch">
          <h3>{t('dns.fallbackFilter.domain')}</h3>
          {renderListInputs('fallbackDomain', t('dns.fallbackFilter.domainPlaceholder'))}
        </div>
      </SettingCard>
    </>
  )
}
