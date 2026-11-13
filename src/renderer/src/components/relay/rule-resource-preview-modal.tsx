import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import {
  RULE_RESOURCE_PREVIEW_INPUT_LIMIT,
  RULE_RESOURCE_PREVIEW_TEXT_LIMIT,
  type RuleResourcePreview
} from '../../../../shared/relay/resources'

// Monaco belongs to the browser view. The static maintenance preview can load
// this module without loading the editor or opening a rule resource.
const ResourceViewerView = lazy(() =>
  import('../resources/viewer').then(({ ResourceViewerView }) => ({ default: ResourceViewerView }))
)

export interface RuleResourcePreviewModalProps {
  selection: RuleResourcePreview['resource']
  title?: string
  onClose(): void
  onBusy(value: boolean): void
}

export function RuleResourcePreviewModal({
  selection,
  title = '规则缓存',
  onClose,
  onBusy
}: RuleResourcePreviewModalProps): React.JSX.Element {
  const [preview, setPreview] = useState<RuleResourcePreview>(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string>(),
    initial = useRef({ ...selection }),
    current = useRef(selection),
    callbacks = useRef({ onClose, onBusy }),
    request = useRef<Promise<RuleResourcePreview> | undefined>(undefined),
    mounted = useRef(false),
    closed = useRef(false),
    epoch = useRef(0)
  current.current = selection
  callbacks.current = { onClose, onBusy }
  const close = (): void => {
    closed.current = true
    ++epoch.current
    setPreview(undefined)
    callbacks.current.onClose()
  }
  useEffect(() => {
    mounted.current = true
    const generation = epoch.current,
      selected = initial.current,
      nextEpoch = (): void => {
        ++epoch.current
      },
      live = (): boolean =>
        mounted.current &&
        !closed.current &&
        generation === epoch.current &&
        selected.id === current.current.id &&
        selected.sha256 === current.current.sha256 &&
        document.visibilityState !== 'hidden',
      invalidate = (): void => {
        closed.current = true
        nextEpoch()
        setPreview(undefined)
        callbacks.current.onClose()
      },
      visibility = (): void => {
        if (document.visibilityState === 'hidden') invalidate()
      }
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', invalidate),
      restored = window.electron.ipcRenderer.on('relayDataRestored', invalidate)
    window.addEventListener('hashchange', invalidate)
    window.addEventListener('popstate', invalidate)
    window.addEventListener('pagehide', invalidate)
    document.addEventListener('visibilitychange', visibility)
    if (!request.current && live()) {
      const ownBusy = callbacks.current.onBusy
      ownBusy(true)
      request.current = (async () => {
        try {
          return (await window.electron.ipcRenderer.invoke('relayResourcePreview', {
            id: selected.id,
            sha256: selected.sha256
          })) as RuleResourcePreview
        } finally {
          // Closing this view discards text, not the in-flight Node worker.
          ownBusy(false)
        }
      })()
    }
    void (async () => {
      try {
        const output = await request.current
        if (!live()) return
        if (
          !output ||
          output.resource.id !== selected.id ||
          output.resource.sha256 !== selected.sha256 ||
          !['rule-yaml', 'rule-text', 'rule-mrs'].includes(output.kind) ||
          !['yaml', 'text'].includes(output.language) ||
          typeof output.text !== 'string' ||
          new TextEncoder().encode(output.text).byteLength > RULE_RESOURCE_PREVIEW_TEXT_LIMIT ||
          !Number.isSafeInteger(output.sourceBytes) ||
          output.sourceBytes < 1 ||
          output.sourceBytes >
            (output.kind === 'rule-mrs'
              ? RULE_RESOURCE_PREVIEW_INPUT_LIMIT
              : RULE_RESOURCE_PREVIEW_TEXT_LIMIT) ||
          typeof output.converted !== 'boolean' ||
          output.converted !== (output.kind === 'rule-mrs') ||
          (output.sourceRules !== undefined &&
            (!Number.isSafeInteger(output.sourceRules) || output.sourceRules < 0))
        )
          throw new Error()
        setPreview(output)
        setError(undefined)
      } catch {
        if (live()) {
          setPreview(undefined)
          setError('未能确认所选规则缓存的预览；请关闭后重新读取，不会自动重试。')
        }
      } finally {
        if (live()) setLoading(false)
      }
    })()
    return () => {
      mounted.current = false
      nextEpoch()
      remove()
      restored()
      window.removeEventListener('hashchange', invalidate)
      window.removeEventListener('popstate', invalidate)
      window.removeEventListener('pagehide', invalidate)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => {
    if (selection.id !== initial.current.id || selection.sha256 !== initial.current.sha256) close()
  }, [selection.id, selection.sha256])
  return (
    <Suspense
      fallback={
        <div role="status">
          正在加载规则缓存预览… <button onClick={close}>关闭预览</button>
        </div>
      }
    >
      <ResourceViewerView
        title={`规则缓存只读预览 · ${title}`}
        text={
          selection.id === initial.current.id && selection.sha256 === initial.current.sha256
            ? (preview?.text ?? '')
            : ''
        }
        language={preview?.language ?? 'text'}
        loading={loading}
        error={error}
        description={
          preview
            ? `${preview.converted ? 'MRS已转换为文本预览' : '原始规则文本'}；源文件${preview.sourceBytes}字节${preview.sourceRules === undefined ? '' : `，${preview.sourceRules}条规则`}。仅查看选定私有缓存，不写入或启用。`
            : '仅显式读取选定id和SHA的私有规则缓存；不读取原path，不获取或启用资源。'
        }
        readOnly
        onClose={close}
      />
    </Suspense>
  )
}
