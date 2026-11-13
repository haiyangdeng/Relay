import { useEffect, useRef, useState } from 'react'
import { DEFAULT_CONTROL_SNIFF, DEFAULT_MIHOMO_SNIFFER_CONFIG } from '../../../shared/appConfig'
import {
  configurationEditDocument,
  snifferSettings,
  type ConfigurationEditDocument,
  type ConfigurationEditRecord
} from '../../../shared/relay/configuration-edit'
import type {
  SnifferEditorValues,
  SnifferProtocol
} from '../components/sniffer/sniffer-settings-view'

export interface RelaySnifferDraft {
  values: SnifferEditorValues
  ports: Record<SnifferProtocol, string>
  editedPorts: SnifferProtocol[]
}

export function snifferDraft(document: ConfigurationEditDocument): RelaySnifferDraft {
  const sniffer = snifferSettings(document.controlled.sniffer ?? {}),
    defaults = DEFAULT_MIHOMO_SNIFFER_CONFIG,
    source = (sniffer.sniff ?? defaults.sniff) as Record<string, unknown>,
    sniff: SnifferEditorValues['sniff'] = {}
  for (const protocol of ['HTTP', 'TLS', 'QUIC'] as const) {
    const config = source[protocol]
    if (!config || typeof config !== 'object' || Array.isArray(config)) continue
    const record = config as Record<string, unknown>
    sniff[protocol] = {
      ports: Array.isArray(record.ports) ? record.ports.map(String) : [],
      ...(typeof record['override-destination'] === 'boolean'
        ? { 'override-destination': record['override-destination'] }
        : {})
    }
  }
  const list = (key: string, fallback: string[] = []): string[] =>
    Array.isArray(sniffer[key]) ? [...(sniffer[key] as string[])] : [...fallback]
  return {
    values: {
      enable: (sniffer.enable as boolean | undefined) ?? defaults.enable,
      parsePureIP: (sniffer['parse-pure-ip'] as boolean | undefined) ?? defaults['parse-pure-ip'],
      forceDNSMapping:
        (sniffer['force-dns-mapping'] as boolean | undefined) ?? defaults['force-dns-mapping'],
      overrideDestination:
        (sniffer['override-destination'] as boolean | undefined) ??
        defaults['override-destination'],
      sniff,
      skipDomain: list('skip-domain', defaults['skip-domain']),
      forceDomain: list('force-domain'),
      skipDstAddress: list('skip-dst-address', defaults['skip-dst-address']),
      skipSrcAddress: list('skip-src-address')
    },
    ports: {
      HTTP: sniff.HTTP?.ports.join(',') ?? '',
      TLS: sniff.TLS?.ports.join(',') ?? '',
      QUIC: sniff.QUIC?.ports.join(',') ?? ''
    },
    editedPorts: []
  }
}

export function snifferDocument(
  base: ConfigurationEditDocument,
  draft: RelaySnifferDraft,
  bodyChanged: boolean,
  controlSniff: boolean,
  controlChanged: boolean
): ConfigurationEditDocument {
  const document = structuredClone(base)
  if (controlChanged) document.controlSniff = controlSniff
  if (!bodyChanged) return configurationEditDocument(document)
  const prior = snifferSettings(base.controlled.sniffer ?? {}),
    { values, ports } = draft,
    sniff: Record<string, unknown> = {}
  for (const protocol of ['HTTP', 'TLS', 'QUIC'] as const) {
    const text = ports[protocol].trim(),
      parsed = text ? text.split(',').map((port) => port.trim()) : []
    if (parsed.some((port) => !port)) throw new Error('端口列表含空项。')
    if (protocol === 'QUIC' && !values.sniff.QUIC && !parsed.length) continue
    if (!values.sniff[protocol] && !parsed.length) continue
    const priorSniff = prior.sniff as Record<string, unknown> | undefined,
      original = priorSniff?.[protocol],
      item =
        original && typeof original === 'object' && !Array.isArray(original)
          ? { ...original }
          : { ports: parsed }
    const override = values.sniff[protocol]?.['override-destination']
    if (override !== undefined) item['override-destination'] = override
    if (draft.editedPorts.includes(protocol)) item.ports = parsed
    sniff[protocol] = item
  }
  const next = {
    ...prior,
    enable: values.enable,
    'parse-pure-ip': values.parsePureIP,
    'force-dns-mapping': values.forceDNSMapping,
    'override-destination': values.overrideDestination,
    sniff,
    'skip-domain': [...values.skipDomain],
    'skip-dst-address': [...values.skipDstAddress],
    ...(Object.hasOwn(prior, 'force-domain') || values.forceDomain.length
      ? { 'force-domain': [...values.forceDomain] }
      : {}),
    ...(Object.hasOwn(prior, 'skip-src-address') || values.skipSrcAddress.length
      ? { 'skip-src-address': [...values.skipSrcAddress] }
      : {})
  }
  document.controlled = { ...document.controlled, sniffer: snifferSettings(next) }
  return configurationEditDocument(document)
}

export function useRelaySnifferConfig({
  busy,
  onBusy,
  onChanged
}: {
  busy: boolean
  onBusy(value: boolean): void
  onChanged?(): void
}) {
  const [base, setBase] = useState<ConfigurationEditRecord>(),
    [draft, setDraft] = useState<RelaySnifferDraft>(),
    [controlSniff, setControlSniff] = useState(DEFAULT_CONTROL_SNIFF),
    [bodyChanged, setBodyChanged] = useState(false),
    [controlChanged, setControlChanged] = useState(false),
    [requiresRead, setRequiresRead] = useState(false),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    epoch = useRef(0),
    operation = useRef(false),
    mounted = useRef(true),
    onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  useEffect(() => {
    mounted.current = true
    const invalidateEpoch = (): void => {
        epoch.current++
      },
      invalidate = (): void => {
        invalidateEpoch()
        setBase(undefined)
        setDraft(undefined)
        setBodyChanged(false)
        setControlChanged(false)
        setControlSniff(DEFAULT_CONTROL_SNIFF)
        setRequiresRead(true)
        setNotice('嗅探编辑上下文已失效，请重新读取；在途操作等待真实收尾。')
        onChangedRef.current?.()
      },
      remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', invalidate),
      restored = window.electron.ipcRenderer.on('relayDataRestored', invalidate)
    return () => {
      mounted.current = false
      invalidateEpoch()
      remove()
      restored()
    }
  }, [])
  const changed = (value: RelaySnifferDraft): void => {
    if (busy || operation.current || !base || requiresRead) return
    setDraft(value)
    setBodyChanged(true)
    onChanged?.()
  }
  const run = async (kind: 'read' | 'save'): Promise<void> => {
    if (busy || operation.current || (kind === 'save' && (!base || !draft || requiresRead))) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const generation = epoch.current
    let sent = false
    try {
      let record: ConfigurationEditRecord
      if (kind === 'read')
        record = (await window.electron.ipcRenderer.invoke(
          'relayConfigEditRead'
        )) as ConfigurationEditRecord
      else {
        if (!base || !draft) return
        const document = snifferDocument(
          base.document,
          draft,
          bodyChanged,
          controlSniff,
          controlChanged
        )
        sent = true
        record = (await window.electron.ipcRenderer.invoke('relayConfigEditSave', {
          document,
          expectedRevision: base.revision
        })) as ConfigurationEditRecord
      }
      if (!mounted.current || generation !== epoch.current) return
      const document = configurationEditDocument(record.document)
      setBase({ ...record, document })
      setDraft(snifferDraft(document))
      setControlSniff(document.controlSniff ?? DEFAULT_CONTROL_SNIFF)
      setBodyChanged(false)
      setControlChanged(false)
      setRequiresRead(false)
      if (kind === 'save') onChanged?.()
      setNotice(
        kind === 'read'
          ? '已读取受控嗅探草稿；这不是当前实例已加载设置。'
          : '嗅探编辑已保存；没有热载或改变当前连接，请沿原流程检查候选并显式应用。'
      )
    } catch {
      if (!mounted.current || generation !== epoch.current) return
      if (sent) {
        setRequiresRead(true)
        setNotice('保存未确认或版本已变化；草稿保留，请重新读取核对，未自动重试或应用。')
      } else setNotice('读取或草稿格式未通过；草稿保留，请核对端口列表后重试。')
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const sidebarRead = useRef(() => {})
  sidebarRead.current = () => {
    ++epoch.current
    if (bodyChanged || controlChanged || operation.current || busy) {
      setRequiresRead(true)
      setNotice('侧栏已更新设置；当前草稿保留，请刷新核对后再保存。')
      onChanged?.()
    } else void run('read')
  }
  useEffect(() => {
    const changed = (): void => sidebarRead.current()
    window.addEventListener('relay-sidebar-settings-changed', changed)
    return () => window.removeEventListener('relay-sidebar-settings-changed', changed)
  }, [])
  return {
    draft,
    controlSniff,
    dirty: bodyChanged || controlChanged,
    pending,
    notice,
    locked: busy || pending || !base || requiresRead,
    readLocked: busy || pending,
    requiresRead,
    read: () => run('read'),
    save: () => run('save'),
    values: (values: SnifferEditorValues) => {
      if (!draft) return
      const ports = { ...draft.ports }
      for (const protocol of ['HTTP', 'TLS', 'QUIC'] as const)
        if (!draft.values.sniff[protocol] && values.sniff[protocol])
          ports[protocol] = values.sniff[protocol].ports.join(',')
      changed({ ...draft, values, ports })
    },
    ports: (protocol: SnifferProtocol, value: string) => {
      if (draft)
        changed({
          ...draft,
          ports: { ...draft.ports, [protocol]: value },
          editedPorts: [...new Set([...draft.editedPorts, protocol])]
        })
    },
    control: (value: boolean) => {
      if (busy || operation.current || !base || requiresRead) return
      setControlSniff(value)
      setControlChanged(true)
      onChanged?.()
    }
  }
}
