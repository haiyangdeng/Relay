import { Button, Switch } from '@heroui/react'
import BasePage from '@renderer/components/base/base-page'
import { showErrorSync } from '@renderer/utils/error-display'
import { SnifferSettingsView } from '@renderer/components/sniffer/sniffer-settings-view'
import { useRelayInitialRead } from '@renderer/hooks/use-relay-initial-read'
import { useRelaySnifferConfig } from '@renderer/hooks/use-relay-sniffer-config'
import { useControledMihomoConfig } from '@renderer/hooks/use-controled-mihomo-config'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { mihomoHotReloadConfig } from '@renderer/utils/ipc'
import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_CONTROL_SNIFF, DEFAULT_MIHOMO_SNIFFER_CONFIG } from '../../../shared/appConfig'

const Sniffer: React.FC = () => {
  const { t } = useTranslation()
  const { controledMihomoConfig, patchControledMihomoConfig } = useControledMihomoConfig()
  const { appConfig } = useAppConfig()
  const { controlSniff = DEFAULT_CONTROL_SNIFF, operationMode = 'standard' } = appConfig || {}
  const { sniffer } = controledMihomoConfig || {}
  const {
    enable = DEFAULT_MIHOMO_SNIFFER_CONFIG.enable,
    'parse-pure-ip': parsePureIP = DEFAULT_MIHOMO_SNIFFER_CONFIG['parse-pure-ip'],
    'force-dns-mapping': forceDNSMapping = DEFAULT_MIHOMO_SNIFFER_CONFIG['force-dns-mapping'],
    'override-destination': overrideDestination = DEFAULT_MIHOMO_SNIFFER_CONFIG[
      'override-destination'
    ],
    // QUIC 仅用于设置页编辑（含 keyof 类型推导），不属于默认下发配置
    sniff = { ...DEFAULT_MIHOMO_SNIFFER_CONFIG.sniff, QUIC: { ports: [] } },
    'skip-domain': skipDomain = DEFAULT_MIHOMO_SNIFFER_CONFIG['skip-domain'],
    'force-domain': forceDomain = [],
    'skip-dst-address': skipDstAddress = DEFAULT_MIHOMO_SNIFFER_CONFIG['skip-dst-address'],
    'skip-src-address': skipSrcAddress = []
  } = sniffer || {}
  const [changed, setChanged] = useState(false)
  const [values, originSetValues] = useState({
    enable,
    parsePureIP,
    forceDNSMapping,
    overrideDestination,
    sniff,
    skipDomain,
    forceDomain,
    skipDstAddress,
    skipSrcAddress
  })
  const setValues = (v: typeof values): void => {
    originSetValues(v)
    setChanged(true)
  }

  const onSave = async (patch: Partial<IMihomoConfig>): Promise<void> => {
    try {
      setChanged(false)
      await patchControledMihomoConfig(patch)

      if (operationMode !== 'simple' && controlSniff) {
        await mihomoHotReloadConfig()
      }
    } catch (e) {
      showErrorSync(e, t('common.error.snifferConfigSaveFailed'))
    }
  }

  const handleSniffPortChange = (protocol: keyof typeof sniff, value: string): void => {
    setValues({
      ...values,
      sniff: {
        ...values.sniff,
        [protocol]: {
          ...values.sniff[protocol],
          ports: value.split(',').map((port) => port.trim())
        }
      }
    })
  }

  return (
    <BasePage
      title={t('sniffer.title')}
      header={
        changed && (
          <Button
            size="sm"
            className="app-nodrag"
            color="primary"
            onPress={() =>
              onSave({
                sniffer: {
                  enable: values.enable,
                  'parse-pure-ip': values.parsePureIP,
                  'force-dns-mapping': values.forceDNSMapping,
                  'override-destination': values.overrideDestination,
                  sniff: values.sniff,
                  'skip-domain': values.skipDomain,
                  'force-domain': values.forceDomain,
                  'skip-dst-address': values.skipDstAddress,
                  'skip-src-address': values.skipSrcAddress
                }
              })
            }
          >
            {operationMode === 'simple' || controlSniff ? t('common.save') : t('sniffer.saveOnly')}
          </Button>
        )
      }
    >
      <SnifferSettingsView
        values={values}
        ports={{
          HTTP: values.sniff.HTTP?.ports.join(',') ?? '',
          TLS: values.sniff.TLS?.ports.join(',') ?? '',
          QUIC: values.sniff.QUIC?.ports.join(',') ?? ''
        }}
        onChange={setValues}
        onPortsChange={handleSniffPortChange}
        showEnable={operationMode !== 'simple'}
      />
    </BasePage>
  )
}

export default Sniffer

export function RelaySnifferManager(props: {
  active?: boolean
  busy: boolean
  onBusy(value: boolean): void
  onChanged?(): void
}): React.JSX.Element {
  const config = useRelaySnifferConfig(props)
  useRelayInitialRead(props.active ?? true, !!config.draft, config.readLocked, config.read)
  return (
    <section className="relay-panel" aria-label="结构化嗅探管理">
      <div className="relay-heading">
        <h2>域名嗅探设置</h2>
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
      {config.notice && (
        <p className="text-xs" role="status">
          {config.notice}
        </p>
      )}
      {config.draft ? (
        <SnifferSettingsView
          values={config.draft.values}
          ports={config.draft.ports}
          onChange={config.values}
          onPortsChange={config.ports}
          disabled={config.locked}
        />
      ) : (
        <p>正在读取嗅探设置，读取失败时可点刷新重试。</p>
      )}
      <details className="mt-4">
        <summary>高级：覆写设置</summary>
        <Switch
          aria-label="合并这份受控Sniffer设置"
          isSelected={config.controlSniff}
          isDisabled={config.locked}
          onValueChange={config.control}
        >
          合并这份受控Sniffer设置
        </Switch>
        <p>
          关闭合并只忽略这份覆写，来源配置自身的嗅探设置仍保留。上方“启用域名嗅探”编辑嗅探开关。
        </p>
        <p>修改正文后，保存包含当前可见的常用模板默认设置；仅切换合并不会改动正文。</p>
      </details>
      {config.requiresRead && <p>请重新读取核对保存版本；未自动重基或重试旧草稿。</p>}
      <p className="text-xs">保存后用于下次应用配置，当前连接不变。</p>
    </section>
  )
}
