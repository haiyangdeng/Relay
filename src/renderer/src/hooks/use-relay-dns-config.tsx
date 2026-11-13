import { useEffect, useRef, useState } from 'react'
import {
  configurationEditDocument,
  type ConfigurationEditRecord,
  type ConfigurationEditPreview
} from '../../../shared/relay/configuration-edit'
import type { RelayProfileInventory, RelayStoredProfile } from '../../../shared/relay/profiles'
import { relayProfileRead } from '../components/relay/profile-read-queue'
import {
  relayDnsDraft,
  relayDnsDocument,
  type RelayDnsDraft,
  type RelayDnsChanges
} from '../utils/relay-dns-config'

interface DnsPreview {
  source: Pick<RelayStoredProfile, 'id' | 'sha256'>
  dns: ConfigurationEditPreview['dns']
  draftRevision: number
}

export function useRelayDnsConfig({
  busy,
  onBusy,
  onChanged
}: {
  busy: boolean
  onBusy(value: boolean): void
  onChanged?(): void
}) {
  const [base, setBase] = useState<ConfigurationEditRecord>(),
    [draft, setDraft] = useState<RelayDnsDraft>(),
    [changes, setChanges] = useState<RelayDnsChanges>({}),
    [profiles, setProfiles] = useState<RelayProfileInventory>(),
    [selected, setSelected] = useState(''),
    [preview, setPreview] = useState<DnsPreview>(),
    [requiresRead, setRequiresRead] = useState(false),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    epoch = useRef(0),
    draftRevision = useRef(0),
    operation = useRef(false),
    mounted = useRef(true),
    onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  useEffect(() => {
    mounted.current = true
    const invalidateEpoch = (): void => {
        epoch.current++
        draftRevision.current++
      },
      invalidate = (): void => {
        invalidateEpoch()
        setBase(undefined)
        setDraft(undefined)
        setChanges({})
        setProfiles(undefined)
        setSelected('')
        setPreview(undefined)
        setRequiresRead(true)
        setNotice('DNS编辑上下文已失效，请重新读取；在途操作等待真实收尾。')
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
  const revokePreview = (): void => {
    draftRevision.current++
    setPreview(undefined)
  }
  const run = async (kind: 'read' | 'save' | 'preview' | 'confirm'): Promise<void> => {
    if (busy || operation.current || (kind !== 'read' && (!base || !draft || requiresRead))) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const generation = epoch.current,
      check = (): boolean => mounted.current && generation === epoch.current
    let mutationSent = false
    try {
      if (kind === 'read') {
        const raw = (await window.electron.ipcRenderer.invoke(
          'relayConfigEditRead'
        )) as ConfigurationEditRecord
        if (!check()) return
        const document = configurationEditDocument(raw.document),
          nextDraft = relayDnsDraft(document),
          nextProfiles = await relayProfileRead('relayProfileList')
        if (!check()) return
        setBase({ ...raw, document })
        setDraft(nextDraft)
        setChanges({})
        setProfiles(nextProfiles)
        setSelected('')
        setRequiresRead(false)
        revokePreview()
        setNotice('已读取DNS受控草稿与来源；不是当前实例的运行设置，尚未应用。')
        return
      }
      if (!base || !draft) return
      const document = relayDnsDocument(base.document, draft, changes),
        profile = profiles?.profiles.find((item) => item.id === selected)
      if (kind === 'preview') {
        if (!profile) throw new Error('请选择来源。')
        const source = { id: profile.id, sha256: profile.sha256 },
          revision = draftRevision.current,
          result = await relayProfileRead('relayConfigEditPreview', {
            profile: source,
            ...document
          })
        if (!check() || revision !== draftRevision.current) return
        setPreview({ source, draftRevision: revision, dns: result.dns })
        setNotice('已按所选来源预览DNS保护；预览没有保存、授权或应用。')
        return
      }
      if (kind === 'confirm') {
        if (
          !profile ||
          !preview ||
          preview.source.id !== profile.id ||
          preview.source.sha256 !== profile.sha256 ||
          preview.draftRevision !== draftRevision.current ||
          !preview.dns.autoDisabled ||
          !preview.dns.fingerprint ||
          !/^[a-f0-9]{64}$/u.test(preview.dns.fingerprint)
        )
          throw new Error('请重新预览此来源。')
        document.confirmedDnsFingerprint = preview.dns.fingerprint
      }
      mutationSent = true
      const saved = (await window.electron.ipcRenderer.invoke('relayConfigEditSave', {
        document: configurationEditDocument(document),
        expectedRevision: base.revision
      })) as ConfigurationEditRecord
      if (!check()) return
      const savedDocument = configurationEditDocument(saved.document),
        savedDraft = relayDnsDraft(savedDocument)
      setBase({ ...saved, document: savedDocument })
      setDraft(savedDraft)
      setChanges({})
      setRequiresRead(false)
      revokePreview()
      onChanged?.()
      setNotice(
        kind === 'confirm'
          ? '已保存此来源DNS内容的明确确认与草稿；没有应用，其他来源仍按各自指纹保护。'
          : 'DNS编辑已保存为合并请求；最终是否生效由来源保护与候选决定，没有热载或修改系统DNS。'
      )
    } catch {
      if (!check()) return
      if (mutationSent) {
        setRequiresRead(true)
        revokePreview()
        setNotice('保存未确认或版本已变化；草稿保留，必须重新读取核对，旧来源确认不能重试。')
      } else if (kind === 'read') {
        setRequiresRead(true)
        revokePreview()
        setNotice('DNS读取或字段投影未通过；没有初始化空草稿，请重新读取核对。')
      } else {
        setPreview(undefined)
        setNotice('DNS草稿或来源预览未通过；草稿保留，没有保存、确认或应用。')
      }
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const sidebarRead = useRef(() => {})
  sidebarRead.current = () => {
    ++epoch.current
    if (Object.values(changes).some(Boolean) || operation.current || busy) {
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
    profiles,
    selected,
    preview,
    pending,
    notice,
    dirty: Object.values(changes).some(Boolean),
    requiresRead,
    locked: busy || pending || !base || requiresRead,
    readLocked: busy || pending,
    read: () => run('read'),
    save: () => run('save'),
    previewSource: () => run('preview'),
    confirmSource: () => run('confirm'),
    update: (next: RelayDnsDraft, delta: RelayDnsChanges) => {
      if (busy || operation.current || !base || requiresRead) return
      setDraft(next)
      setChanges({ ...changes, ...delta })
      revokePreview()
      onChanged?.()
    },
    select: (id: string) => {
      if (busy || operation.current || !base || requiresRead) return
      setSelected(id)
      revokePreview()
    }
  }
}
