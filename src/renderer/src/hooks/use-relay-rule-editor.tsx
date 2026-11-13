import { useEffect, useRef, useState } from 'react'
import type {
  RelayProfileInventory,
  RelayProfileRules,
  RelayStoredProfile,
  RelayProfilePreparation,
  RelayProfileSaveResult
} from '../../../shared/relay/profiles'
import {
  configurationEditDocument,
  profileRulePatchFor,
  type ConfigurationEditRecord
} from '../../../shared/relay/configuration-edit'
import type { RuntimeRulePatch } from '../../../main/relay/configuration/merge'
import {
  ruleRows,
  rulePatchDocument,
  saveRuleCopy,
  type RelayRuleRow
} from '../utils/relay-rule-editor'
import { relayProfileRead } from '../components/relay/profile-read-queue'

interface ActivityProps {
  busy: boolean
  onBusy(value: boolean): void
}
export function useRuleActivity(props: ActivityProps, onInvalidate: () => void) {
  const [pending, setPending] = useState(false),
    operation = useRef(false),
    epoch = useRef(0),
    mounted = useRef(true),
    invalidateRef = useRef(onInvalidate),
    busyRef = useRef(props.busy)
  invalidateRef.current = onInvalidate
  busyRef.current = props.busy
  useEffect(() => {
    mounted.current = true
    const nextEpoch = (): void => {
        epoch.current++
      },
      invalidate = (): void => {
        nextEpoch()
        invalidateRef.current()
      }
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', invalidate),
      restored = window.electron.ipcRenderer.on('relayDataRestored', invalidate)
    return () => {
      mounted.current = false
      nextEpoch()
      remove()
      restored()
    }
  }, [])
  const run = async (
    work: (check: () => void) => Promise<void>,
    onError: () => void
  ): Promise<void> => {
    if (busyRef.current || operation.current || !mounted.current) return
    operation.current = true
    setPending(true)
    props.onBusy(true)
    const generation = epoch.current,
      check = (): void => {
        if (!mounted.current || generation !== epoch.current) throw new Error('规则上下文已失效。')
      }
    try {
      await work(check)
    } catch {
      if (mounted.current && generation === epoch.current) onError()
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      props.onBusy(false)
    }
  }
  return {
    pending,
    locked: props.busy || pending,
    blocked: () => busyRef.current || operation.current || !mounted.current,
    run
  }
}

export function useRelayProfileRules(profile: RelayStoredProfile, props: ActivityProps) {
  const [data, setData] = useState<RelayProfileRules>(),
    [rows, setRows] = useState<RelayRuleRow[]>([]),
    [baseline, setBaseline] = useState(''),
    [proof, setProof] = useState<RelayProfilePreparation>(),
    [notice, setNotice] = useState(''),
    [requiresRead, setRequiresRead] = useState(false),
    [readEpoch, setReadEpoch] = useState(0)
  const activity = useRuleActivity(props, () => {
    setData(undefined)
    setRows([])
    setProof(undefined)
    setRequiresRead(true)
    setNotice('配置规则上下文已失效，请重新读取；在途另存等待真实收尾。')
  })
  const action = (kind: 'read' | 'prepare' | 'save' | 'copy'): Promise<void> => {
    let saveSubmitted = false
    const invoke = (channel: string, request: unknown): Promise<unknown> => {
      if (channel === 'relayProfileSave') saveSubmitted = true
      return window.electron.ipcRenderer.invoke(channel, request)
    }
    return activity.run(
      async (check) => {
        const current = proof
        setProof(undefined)
        const selection = { id: profile.id, sha256: profile.sha256 }
        if (kind === 'read') {
          const result = await relayProfileRead('relayProfileRulesRead', selection)
          check()
          if (result.profile.id !== selection.id || result.profile.sha256 !== selection.sha256)
            throw new Error('来源已变化。')
          setData(result)
          setRows(ruleRows(result.rules))
          setBaseline(JSON.stringify(result.rules))
          setRequiresRead(false)
          setReadEpoch((n) => n + 1)
          setNotice(
            '已读取完整规则草稿；类型、目标、规则集和子规则来自此来源，没有获取外部资源或改变运行实例。'
          )
        } else {
          let candidate = current
          if (kind === 'prepare') {
            if (!data || requiresRead) throw new Error('请重新读取。')
            candidate = (await window.electron.ipcRenderer.invoke('relayProfileRulesPrepare', {
              profile: selection,
              rules: rows.map((row) => row.value)
            })) as RelayProfilePreparation
            check()
            setProof(candidate)
            setNotice('规则已检查；可确认另存副本。')
            return
          }
          if (requiresRead || (kind === 'copy' ? !data : !candidate))
            throw new Error('请重新读取。')
          const result =
            kind === 'copy'
              ? await saveRuleCopy(
                  invoke,
                  selection,
                  rows.map((row) => row.value),
                  check
                )
              : ((await invoke('relayProfileSave', {
                  evidenceId: candidate?.evidenceId
                })) as RelayProfileSaveResult)
          check()
          if (result.status === 'saved') {
            setBaseline(JSON.stringify(rows.map((row) => row.value)))
            setNotice(
              `规则草稿已另存新UUID副本 ${result.profile?.id ?? ''}；原配置和当前实例不变，未自动选择或启用，可刷新配置列表核对。`
            )
          } else if (result.status === 'cancelled')
            setNotice('Native已取消另存；规则草稿保留，没有新副本。')
          else {
            setRequiresRead(true)
            setNotice('另存结果未确认；草稿保留，请读取配置列表核对，不会自动重试或启用。')
          }
        }
      },
      () => {
        setProof(undefined)
        if (kind === 'read') {
          setData(undefined)
          setRequiresRead(true)
        }
        if (saveSubmitted) setRequiresRead(true)
        setNotice(
          '规则操作未通过；请核对规则结构、引用、数量和来源修订，草稿保留，没有自动重试或应用。'
        )
      }
    )
  }
  return {
    ...activity,
    data,
    rows,
    proof,
    notice,
    requiresRead,
    readEpoch,
    dirty: !!data && JSON.stringify(rows.map((row) => row.value)) !== baseline,
    read: () => action('read'),
    prepare: () => action('prepare'),
    save: () => action('save'),
    saveCopy: () => action('copy'),
    change: (next: RelayRuleRow[]): boolean => {
      if (activity.blocked() || !data || requiresRead) return false
      setRows(next)
      setProof(undefined)
      return true
    }
  }
}

type Group = 'prepend' | 'append' | 'delete'
function patchRows(patch: RuntimeRulePatch): Record<Group, RelayRuleRow[]> {
  return {
    prepend: ruleRows(patch.prepend ?? []),
    append: ruleRows(patch.append ?? []),
    delete: ruleRows(patch.delete ?? [])
  }
}
export function useRelayRulePatch(props: ActivityProps & { onChanged?(): void }) {
  const [base, setBase] = useState<ConfigurationEditRecord>(),
    [profiles, setProfiles] = useState<RelayProfileInventory>(),
    [scope, setScope] = useState(''),
    [contextId, setContextId] = useState(''),
    [context, setContext] = useState<RelayProfileRules>(),
    [patch, setPatch] = useState<RuntimeRulePatch>({}),
    [rows, setRows] = useState(patchRows({})),
    [preview, setPreview] = useState<string[]>(),
    [notice, setNotice] = useState(''),
    [requiresRead, setRequiresRead] = useState(false),
    [readEpoch, setReadEpoch] = useState(0)
  const activity = useRuleActivity(props, () => {
    setBase(undefined)
    setProfiles(undefined)
    setContext(undefined)
    setScope('')
    setContextId('')
    setPatch({})
    setRows(patchRows({}))
    setPreview(undefined)
    setRequiresRead(true)
    setNotice('规则补丁上下文已失效，请重新读取；在途保存等待真实收尾。')
  })
  const original = base
      ? ((scope ? profileRulePatchFor(base.document, scope) : base.document.rulePatch) ?? {})
      : {},
    dirty = JSON.stringify(patch) !== JSON.stringify(original),
    selected = profiles?.profiles.find((item) => item.id === (scope || contextId))
  const action = (kind: 'read' | 'context' | 'save' | 'preview'): Promise<void> =>
    activity.run(
      async (check) => {
        let mutationSent = false
        try {
          setPreview(undefined)
          if (kind === 'read') {
            const raw = (await window.electron.ipcRenderer.invoke(
              'relayConfigEditRead'
            )) as ConfigurationEditRecord
            check()
            const document = configurationEditDocument(raw.document),
              inventory = await relayProfileRead('relayProfileList')
            check()
            const next = document.rulePatch ?? {}
            setBase({ ...raw, document })
            setProfiles(inventory)
            setScope('')
            setContextId('')
            setContext(undefined)
            setPatch(next)
            setRows(patchRows(next))
            setReadEpoch((n) => n + 1)
            setRequiresRead(false)
            setNotice('已读取全局规则补丁与来源；补丁不等于当前运行规则开关。')
          } else {
            if (!base || requiresRead) throw new Error('请重新读取。')
            if (kind === 'context') {
              if (!selected) throw new Error('请选择来源。')
              const result = await relayProfileRead('relayProfileRulesRead', {
                id: selected.id,
                sha256: selected.sha256
              })
              check()
              if (result.profile.id !== selected.id || result.profile.sha256 !== selected.sha256)
                throw new Error('来源已变化。')
              setContext(result)
              setNotice(
                '已读取此来源规则上下文；目标在此来源有效不代表所有来源均有效，未获取规则集正文。'
              )
            } else {
              const document = rulePatchDocument(base.document, scope || undefined, patch)
              if (kind === 'preview') {
                if (!selected) throw new Error('请选择来源。')
                const result = await relayProfileRead('relayConfigEditPreview', {
                  profile: { id: selected.id, sha256: selected.sha256 },
                  ...document
                })
                check()
                const rules = result.configuration.rules ?? []
                if (!Array.isArray(rules) || rules.some((rule) => typeof rule !== 'string'))
                  throw new Error('候选规则不可展示。')
                setPreview(rules)
                setNotice('已按现合并器预览最终规则；未保存或应用，不代表运行临时disabled状态。')
              } else {
                mutationSent = true
                const raw = (await window.electron.ipcRenderer.invoke('relayConfigEditSave', {
                  document,
                  expectedRevision: base.revision
                })) as ConfigurationEditRecord
                check()
                const nextDoc = configurationEditDocument(raw.document),
                  nextPatch =
                    (scope ? profileRulePatchFor(nextDoc, scope) : nextDoc.rulePatch) ?? {}
                setBase({ ...raw, document: nextDoc })
                setPatch(nextPatch)
                setRows(patchRows(nextPatch))
                setReadEpoch((n) => n + 1)
                props.onChanged?.()
                setNotice(
                  '所选范围规则补丁已保存；其他范围、覆写顺序、DNS和Sniffer保留，没有热载或更改运行禁用位。'
                )
              }
            }
          }
        } catch (error) {
          if (mutationSent) setRequiresRead(true)
          throw error
        }
      },
      () =>
        setNotice(
          '规则补丁读取、候选或保存未通过；草稿保留。写入未确认时必须重新读取，不会重基重试或应用。'
        )
    )
  const resetContext = (): void => {
    setContext(undefined)
    setPreview(undefined)
  }
  return {
    ...activity,
    base,
    profiles,
    scope,
    contextId,
    context,
    selected,
    rows,
    preview,
    notice,
    dirty,
    requiresRead,
    readEpoch,
    read: () => action('read'),
    readContext: () => action('context'),
    save: () => action('save'),
    makePreview: () => action('preview'),
    selectScope: (id: string) => {
      if (activity.blocked() || !base || requiresRead) return
      const next = (id ? profileRulePatchFor(base.document, id) : base.document.rulePatch) ?? {}
      setScope(id)
      setPatch(next)
      setRows(patchRows(next))
      setReadEpoch((n) => n + 1)
      resetContext()
    },
    selectContext: (id: string) => {
      if (activity.blocked() || !base || requiresRead) return
      setContextId(id)
      resetContext()
    },
    change: (group: Group, next: RelayRuleRow[]): boolean => {
      if (activity.blocked() || !base || requiresRead) return false
      setRows({ ...rows, [group]: next })
      setPatch({ ...patch, [group]: next.map((row) => row.value) })
      setPreview(undefined)
      props.onChanged?.()
      return true
    }
  }
}
