import { Button, Divider, Input, Switch } from '@heroui/react'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'
import type { ReactNode } from 'react'
import { MdDeleteForever } from 'react-icons/md'
import { useTranslation } from 'react-i18next'

export type SnifferProtocol = 'HTTP' | 'TLS' | 'QUIC'
export type SnifferList = 'skipDomain' | 'forceDomain' | 'skipDstAddress' | 'skipSrcAddress'
export interface SnifferEditorValues {
  enable: boolean
  parsePureIP: boolean
  forceDNSMapping: boolean
  overrideDestination: boolean
  sniff: Partial<
    Record<SnifferProtocol, { ports: (number | string)[]; 'override-destination'?: boolean }>
  >
  skipDomain: string[]
  forceDomain: string[]
  skipDstAddress: string[]
  skipSrcAddress: string[]
}

export function SnifferSettingsView({
  values,
  ports,
  onChange,
  onPortsChange,
  disabled = false,
  showEnable = true
}: {
  values: SnifferEditorValues
  ports: Record<SnifferProtocol, string>
  onChange(value: SnifferEditorValues): void
  onPortsChange(protocol: SnifferProtocol, value: string): void
  disabled?: boolean
  showEnable?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const handleListChange = (type: SnifferList, value: string, index: number): void => {
    const list = [...values[type]]
    if (value.trim()) {
      if (index < list.length) list[index] = value
      else list.push(value)
    } else list.splice(index, 1)
    onChange({ ...values, [type]: list })
  }
  const renderListInputs = (type: SnifferList, placeholder: string): ReactNode => {
    const items = values[type],
      showNewLine = items.every((item) => item.trim() !== '')
    return [...items, ...(showNewLine ? [''] : [])].map((item, index) => (
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
            aria-label={`${t('common.delete')} ${placeholder} ${index + 1}`}
            isDisabled={disabled}
            onPress={() => handleListChange(type, '', index)}
          >
            <MdDeleteForever className="text-lg" />
          </Button>
        )}
      </div>
    ))
  }
  return (
    <SettingCard>
      {showEnable && (
        <SettingItem title={t('sniffer.enable')} divider>
          <Switch
            size="sm"
            aria-label={t('sniffer.enable')}
            isDisabled={disabled}
            isSelected={values.enable}
            onValueChange={(v) => {
              onChange({ ...values, enable: v })
            }}
          />
        </SettingItem>
      )}
      <SettingItem title={t('sniffer.overrideDestination')} divider>
        <Switch
          size="sm"
          aria-label={t('sniffer.overrideDestination')}
          isDisabled={disabled}
          isSelected={values.overrideDestination}
          onValueChange={(v) => {
            onChange({
              ...values,
              overrideDestination: v,
              sniff: {
                ...values.sniff,
                HTTP: {
                  ...values.sniff.HTTP,
                  'override-destination': v,
                  ports: values.sniff.HTTP?.ports || [80, 443]
                }
              }
            })
          }}
        />
      </SettingItem>
      <SettingItem title={t('sniffer.forceDNSMapping')} divider>
        <Switch
          size="sm"
          aria-label={t('sniffer.forceDNSMapping')}
          isDisabled={disabled}
          isSelected={values.forceDNSMapping}
          onValueChange={(v) => {
            onChange({ ...values, forceDNSMapping: v })
          }}
        />
      </SettingItem>
      <SettingItem title={t('sniffer.parsePureIP')} divider>
        <Switch
          size="sm"
          aria-label={t('sniffer.parsePureIP')}
          isDisabled={disabled}
          isSelected={values.parsePureIP}
          onValueChange={(v) => {
            onChange({ ...values, parsePureIP: v })
          }}
        />
      </SettingItem>
      <SettingItem title={t('sniffer.sniff.title')} divider>
        <Input
          size="sm"
          className="w-[50%]"
          placeholder={t('sniffer.sniff.ports.placeholder')}
          aria-label={t('sniffer.sniff.title')}
          isDisabled={disabled}
          value={ports.HTTP}
          onValueChange={(v) => onPortsChange('HTTP', v)}
        />
      </SettingItem>
      <SettingItem title={t('sniffer.sniff.tls')} divider>
        <Input
          size="sm"
          className="w-[50%]"
          placeholder={t('sniffer.sniff.ports.placeholder')}
          aria-label={t('sniffer.sniff.tls')}
          isDisabled={disabled}
          value={ports.TLS}
          onValueChange={(v) => onPortsChange('TLS', v)}
        />
      </SettingItem>
      <SettingItem title={t('sniffer.sniff.quic')} divider>
        <Input
          size="sm"
          className="w-[50%]"
          placeholder={t('sniffer.sniff.ports.placeholder')}
          aria-label={t('sniffer.sniff.quic')}
          isDisabled={disabled}
          value={ports.QUIC}
          onValueChange={(v) => onPortsChange('QUIC', v)}
        />
      </SettingItem>
      <div className="flex flex-col items-stretch">
        <h3>{t('sniffer.skipDomain.title')}</h3>
        {renderListInputs('skipDomain', t('sniffer.skipDomain.placeholder'))}
      </div>
      <Divider className="my-2" />
      <div className="flex flex-col items-stretch">
        <h3 className="mb-2">{t('sniffer.forceDomain.title')}</h3>
        {renderListInputs('forceDomain', t('sniffer.forceDomain.placeholder'))}
      </div>
      <Divider className="my-2" />
      <div className="flex flex-col items-stretch">
        <h3 className="mb-2">{t('sniffer.skipDstAddress.title')}</h3>
        {renderListInputs('skipDstAddress', t('sniffer.skipDstAddress.placeholder'))}
      </div>
      <Divider className="my-2" />
      <div className="flex flex-col items-stretch">
        <h3 className="mb-2">{t('sniffer.skipSrcAddress.title')}</h3>
        {renderListInputs('skipSrcAddress', t('sniffer.skipSrcAddress.placeholder'))}
      </div>
    </SettingCard>
  )
}
