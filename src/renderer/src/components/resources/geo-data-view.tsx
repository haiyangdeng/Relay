import { Button, Input, Switch, Tab, Tabs } from '@heroui/react'
import type { ReactNode } from 'react'
import { IoMdRefresh } from 'react-icons/io'
import { useTranslation } from 'react-i18next'
import SettingCard from '@renderer/components/base/base-setting-card'
import SettingItem from '@renderer/components/base/base-setting-item'

export const geoURLKeys = ['geoip', 'geosite', 'mmdb', 'asn'] as const
export type GeoURLKey = (typeof geoURLKeys)[number]
export type GeoURLs = Record<GeoURLKey, string>
export type GeoMode = 'inherit' | 'db' | 'dat'

// Controlled original form: it owns no configuration hook, downloader or Core IPC.
export function GeoDataView({
  urls,
  onURLChange,
  urlActions,
  urlDisabled,
  mode,
  onModeChange,
  modeDisabled,
  allowInherited = false,
  autoUpdate,
  onAutoChange,
  intervalHours,
  onHoursChange,
  autoDisabled = false,
  onUpdate,
  updating = false,
  updateDisabled = false,
  autoTitle,
  children
}: {
  urls: GeoURLs
  onURLChange(key: GeoURLKey, value: string): void
  urlActions?: Partial<Record<GeoURLKey, ReactNode>>
  urlDisabled?: Partial<Record<GeoURLKey, boolean>>
  mode: GeoMode
  onModeChange(value: GeoMode): void
  modeDisabled?: boolean
  allowInherited?: boolean
  autoUpdate: boolean
  onAutoChange(value: boolean): void
  intervalHours: string
  onHoursChange(value: string): void
  autoDisabled?: boolean
  onUpdate?(): void
  updating?: boolean
  updateDisabled?: boolean
  autoTitle?: string
  children?: ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <SettingCard>
      {geoURLKeys.map((key) => (
        <SettingItem key={key} title={t(`resources.geoData.${key}`)} divider>
          <div className="flex items-center gap-2 w-[70%] min-w-0" data-geo-url-row={key}>
            <Input
              size="sm"
              className="flex-1 min-w-0"
              aria-label={`${key} URL`}
              value={urls[key]}
              isDisabled={urlDisabled?.[key]}
              onValueChange={(value) => onURLChange(key, value)}
            />
            {urlActions?.[key] && <div className="shrink-0">{urlActions[key]}</div>}
          </div>
        </SettingItem>
      ))}
      <SettingItem title={t('resources.geoData.mode')} divider>
        <Tabs
          aria-label="GeoData DB/DAT模式"
          size="sm"
          color="primary"
          selectedKey={mode}
          isDisabled={modeDisabled}
          onSelectionChange={(key) => {
            if (key === 'inherit' || key === 'db' || key === 'dat') onModeChange(key)
          }}
        >
          {allowInherited && <Tab key="inherit" title="继承来源" />}
          <Tab key="db" title="db" />
          <Tab key="dat" title="dat" />
        </Tabs>
      </SettingItem>
      <SettingItem
        title={autoTitle ?? t('resources.geoData.autoUpdate')}
        divider={autoUpdate}
        actions={
          onUpdate && (
            <Button
              aria-label="手动获取当前来源"
              size="sm"
              isIconOnly
              variant="light"
              isDisabled={updateDisabled}
              onPress={onUpdate}
            >
              <IoMdRefresh className={`text-lg ${updating ? 'animate-spin' : ''}`} />
            </Button>
          )
        }
      >
        <Switch
          aria-label={autoTitle ?? t('resources.geoData.autoUpdate')}
          size="sm"
          isDisabled={autoDisabled}
          isSelected={autoUpdate}
          onValueChange={onAutoChange}
        />
      </SettingItem>
      {autoUpdate && (
        <SettingItem title={t('resources.geoData.updateInterval')}>
          <Input
            aria-label="GeoData小时周期"
            size="sm"
            type="number"
            className="w-25"
            value={intervalHours}
            isDisabled={autoDisabled}
            onValueChange={onHoursChange}
          />
        </SettingItem>
      )}
      {children}
    </SettingCard>
  )
}
