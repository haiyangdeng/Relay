import { isValidElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultSimpleDraft } from '../../../../shared/simple-config'
import type {
  RelaySimpleEditableDraft,
  RelaySimpleIpcApi,
  RelaySimplePreview,
  RelaySimpleReply
} from '../../../../shared/relay/simple'
import type {
  RelayProfilePreparation,
  RelayProfileSaveResult
} from '../../../../shared/relay/profiles'
import { createSimplePanelController, hasUnsavedModules } from './simple-panel-state'
import { SimplePanelView } from './simple-panel'

const info = {
  exists: true,
  revision: 'a'.repeat(64),
  publishedRevision: 7,
  dirty: false,
  sharedConfigurationPinned: false,
  sources: []
}
const snapshot = (): RelaySimpleEditableDraft => ({
  ...info,
  modules: defaultSimpleDraft().modules
})
// Adversarial runtime receipts cross this test-only transport boundary.
const transport = <T>(raw: unknown): T => raw as T
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function fixture() {
  const preview: RelaySimplePreview = {
    yamlSHA256: 'b'.repeat(64),
    bytes: 100,
    errors: [],
    valid: true
  }
  const preparation: RelayProfilePreparation = {
    evidenceId: '11111111-1111-4111-8111-111111111111',
    name: 'Copy.yaml',
    sha256: preview.yamlSHA256,
    bytes: preview.bytes,
    inspection: { structure: 'passed', active: false, coreCompatibility: 'notVerified', issues: [] }
  }
  const replies: { read: unknown; save: unknown; recover: unknown } = {
    read: { status: 'ok', value: snapshot() },
    save: { status: 'ok', value: { ...info, revision: 'c'.repeat(64) } },
    recover: { status: 'ok', value: info }
  }
  const api: RelaySimpleIpcApi = {
    relaySimpleReadEditableDraft: vi.fn(async () =>
      transport<RelaySimpleReply<RelaySimpleEditableDraft>>(replies.read)
    ),
    relaySimpleSaveModule: vi.fn(async () =>
      transport<Awaited<ReturnType<RelaySimpleIpcApi['relaySimpleSaveModule']>>>(replies.save)
    ),
    relaySimplePreview: vi.fn(async () => ({ status: 'ok' as const, value: preview })),
    relaySimplePrepareProfile: vi.fn(async () => ({ status: 'ok' as const, value: preparation })),
    relaySimpleRecover: vi.fn(async () =>
      transport<Awaited<ReturnType<RelaySimpleIpcApi['relaySimpleRecover']>>>(replies.recover)
    )
  }
  const saveProfile = vi.fn(
      async (_request: { evidenceId: string }): Promise<RelayProfileSaveResult> => ({
        status: 'cancelled',
        warnings: []
      })
    ),
    onBusy = vi.fn()
  const controller = createSimplePanelController({
    api,
    saveProfile,
    isCurrent: () => true,
    onBusy
  })
  return { api, replies, controller, saveProfile, onBusy }
}
function elements(node: ReactNode): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function content(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(content).join('')
  return isValidElement<{ children?: ReactNode }>(node) ? content(node.props.children) : ''
}

describe('Controlled Simple panel receipts and sensitive local state', () => {
  it('renders the explicit read action without issuing a getter or exposing module bodies', () => {
    const f = fixture(),
      view = SimplePanelView({
        state: f.controller.getSnapshot(),
        controller: f.controller,
        busy: false
      })
    expect(content(view)).toContain('读取Simple草稿')
    expect(elements(view).some((element) => element.type === 'textarea')).toBe(false)
    for (const method of Object.values(f.api)) expect(method).not.toHaveBeenCalled()
  })
  it('preserves unsaved text when a successful module receipt echoes the old file SHA', async () => {
    const f = fixture()
    await f.controller.read()
    const saved = f.controller.getSnapshot().savedModules?.general
    f.controller.setText('changed unsaved')
    f.replies.save = { status: 'ok', value: info }
    await f.controller.saveModule()
    expect(f.controller.getSnapshot().savedModules?.general).toBe(saved)
    expect(f.controller.getSnapshot().modules?.general).toBe('changed unsaved')
    expect(hasUnsavedModules(f.controller.getSnapshot())).toBe(true)
    expect(f.controller.getSnapshot().notice).not.toContain('已保存当前模块')
  })
  it('rejects nonstring source modes instead of coercing an array into a valid mode', async () => {
    const f = fixture()
    f.replies.read = {
      status: 'ok',
      value: { ...snapshot(), sources: [{ id: 'bound', name: 'Source', mode: ['http'] }] }
    }
    await f.controller.read()
    expect(f.controller.getSnapshot().modules).toBeUndefined()
  })
  it('describes only the actual pinned shared intersection and preserves the empty-shared false case', async () => {
    const f = fixture()
    f.replies.read = { status: 'ok', value: { ...snapshot(), sharedConfigurationPinned: true } }
    await f.controller.read()
    const view = SimplePanelView({
      state: f.controller.getSnapshot(),
      controller: f.controller,
      busy: false
    })
    const hint = elements(view)
      .filter((element) => element.type === 'p')
      .map((element) => content(element.props.children as ReactNode))
      .find((text) => text.startsWith('已绑定固定共享配置'))
    expect(hint).toContain('geodata-mode')
    expect(hint).not.toContain('TUN')
    f.replies.read = { status: 'ok', value: snapshot() }
    await f.controller.read()
    expect(
      content(
        SimplePanelView({
          state: f.controller.getSnapshot(),
          controller: f.controller,
          busy: false
        })
      )
    ).toContain('按空共享配置预览')
  })
  it('clears body/proof immediately while retaining real pending work and suppressing its late result', async () => {
    const f = fixture(),
      late = deferred<RelaySimpleReply<RelaySimpleEditableDraft>>()
    vi.mocked(f.api.relaySimpleReadEditableDraft).mockImplementationOnce(() => late.promise)
    const reading = f.controller.read()
    f.controller.invalidate()
    expect(f.controller.getSnapshot().pending).toBe(true)
    expect(f.controller.getSnapshot().modules).toBeUndefined()
    late.resolve({ status: 'ok', value: snapshot() })
    await reading
    expect(f.controller.getSnapshot().modules).toBeUndefined()
    expect(f.controller.getSnapshot().pending).toBe(false)
    expect(f.onBusy.mock.calls).toEqual([[true], [false]])
  })
  it('requires explicit recovery followed by another explicit read, without updating any pin', async () => {
    const f = fixture()
    f.replies.read = { status: 'uncertain' }
    await f.controller.read()
    await f.controller.read()
    expect(f.api.relaySimpleReadEditableDraft).toHaveBeenCalledOnce()
    expect(f.api.relaySimpleRecover).not.toHaveBeenCalled()
    await f.controller.recover()
    expect(f.controller.getSnapshot().modules).toBeUndefined()
    expect(f.api.relaySimpleReadEditableDraft).toHaveBeenCalledOnce()
    f.replies.read = { status: 'ok', value: snapshot() }
    await f.controller.read()
    expect(f.api.relaySimpleReadEditableDraft).toHaveBeenCalledTimes(2)
  })
  it('uses one existing evidenceId save and never treats cancellation as publication or activation', async () => {
    const f = fixture()
    await f.controller.read()
    await f.controller.preview()
    await f.controller.prepareProfile()
    await Promise.all([f.controller.confirmSave(), f.controller.confirmSave()])
    expect(f.saveProfile).toHaveBeenCalledOnce()
    expect(f.saveProfile).toHaveBeenCalledWith({
      evidenceId: '11111111-1111-4111-8111-111111111111'
    })
    expect(f.controller.getSnapshot().notice).toContain('已取消')
    expect(f.controller.getSnapshot().metadata?.publishedRevision).toBe(7)
    expect(f.controller.getSnapshot().preparation).toBeUndefined()
  })
})

it('saves from a single prepare action, without a second confirmation, and blocks stale preparation', async () => {
  const f = fixture()
  await f.controller.read()
  await f.controller.preview()
  await Promise.all([f.controller.prepareProfile(true), f.controller.prepareProfile(true)])
  expect(f.saveProfile).toHaveBeenCalledOnce()
  expect(f.controller.getSnapshot().metadata?.publishedRevision).toBe(7)
  const g = fixture()
  await g.controller.read()
  await g.controller.preview()
  const late = deferred<Awaited<ReturnType<typeof g.api.relaySimplePrepareProfile>>>()
  vi.mocked(g.api.relaySimplePrepareProfile).mockReturnValue(late.promise)
  const pending = g.controller.prepareProfile(true)
  g.controller.invalidate()
  late.resolve({ status: 'invalid', message: 'stale' } as Awaited<
    ReturnType<typeof g.api.relaySimplePrepareProfile>
  >)
  await pending
  expect(g.saveProfile).not.toHaveBeenCalled()
})
