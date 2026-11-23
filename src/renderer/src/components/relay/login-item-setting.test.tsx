import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, assert, expect, it, vi } from 'vitest'
import type { RelayLoginItemResult, RelayLoginItemState } from '../../../../shared/relay/shell'
import { RelayLoginItemSetting } from './login-item-setting'

type SwitchProps = {
  isSelected: boolean
  isDisabled: boolean
  onValueChange(enabled: boolean): void
}

const { useResource, switchView } = vi.hoisted(() => ({
  useResource: vi.fn<
    (
      key: string,
      read: () => Promise<RelayLoginItemState>
    ) => {
      data?: RelayLoginItemState
      error?: Error
      mutate(): Promise<void>
    }
  >(),
  switchView: vi.fn<(_props: SwitchProps) => null>(() => null)
}))
vi.mock('swr', () => ({ default: useResource }))
vi.mock('@heroui/react', () => ({ Switch: switchView }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: () => '开机自启动' }) }))

const off: RelayLoginItemState = { configured: false, approval: 'notRegistered' }
const on: RelayLoginItemState = { configured: true, approval: 'enabled' }
const readChannel = 'relayLoginItemState'

function fixture() {
  const invoke = vi.fn<(channel: string) => Promise<RelayLoginItemState | RelayLoginItemResult>>()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  let data: RelayLoginItemState | undefined, error: Error | undefined
  let initialRead: Promise<void> | undefined
  useResource.mockImplementation((key, read) => {
    expect(key).toBe(readChannel)
    const mutate = async () => {
      try {
        data = await read()
        error = undefined
      } catch {
        error = new Error('read failed')
      }
    }
    initialRead ??= mutate()
    return { data, error, mutate }
  })
  const busy = vi.fn()
  const render = () => {
    switchView.mockClear()
    const html = renderToStaticMarkup(<RelayLoginItemSetting busy={false} onBusy={busy} />)
    const control = switchView.mock.calls.at(-1)?.[0]
    return { html, control }
  }
  return { invoke, busy, render, initialRead: () => initialRead }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it.each([
  { before: off, target: true, channel: 'enableAutoRun', after: on },
  { before: on, target: false, channel: 'disableAutoRun', after: off }
])(
  'enters read-only, writes $channel only once per gesture and re-reads the OS state',
  async ({ before, target, channel, after }) => {
    const f = fixture()
    const write = Promise.withResolvers<RelayLoginItemResult>()
    f.invoke
      .mockResolvedValueOnce(before)
      .mockReturnValueOnce(write.promise)
      .mockResolvedValueOnce(after)
    expect(f.render().control).toBeUndefined()
    await f.initialRead()
    const { control, html } = f.render()
    expect(control).toMatchObject({ isSelected: before.configured, isDisabled: false })
    expect(html).not.toContain('<button')
    expect(f.invoke.mock.calls).toEqual([[readChannel]])
    assert.isDefined(control)
    control.onValueChange(before.configured)
    control.onValueChange(target)
    control.onValueChange(target)
    expect(f.invoke.mock.calls).toEqual([[readChannel], [channel]])
    expect(f.busy.mock.calls).toEqual([[true]])
    write.resolve({ status: 'applied', openAtLogin: target, warnings: [] })
    await vi.waitFor(() => expect(f.busy.mock.calls).toEqual([[true], [false]]))
    expect(f.invoke.mock.calls).toEqual([[readChannel], [channel], [readChannel]])
    expect(f.render().control?.isSelected).toBe(target)
  }
)

it('hides the switch on a failed initial read and offers a read-only retry', async () => {
  const f = fixture()
  f.invoke.mockRejectedValueOnce(new Error('IPC unavailable'))
  f.render()
  await f.initialRead()
  const { control, html } = f.render()
  expect(control).toBeUndefined()
  expect(html).toContain('重新读取登录项')
  expect(f.invoke.mock.calls).toEqual([[readChannel]])
})

it('shows the observed approval requirement and re-reads after a failed write without retrying it', async () => {
  const f = fixture()
  const observed: RelayLoginItemState = { configured: true, approval: 'requiresApproval' }
  f.invoke
    .mockResolvedValueOnce(observed)
    .mockRejectedValueOnce(new Error('write unconfirmed'))
    .mockResolvedValueOnce(observed)
  f.render()
  await f.initialRead()
  const { control, html } = f.render()
  expect(html).toContain('系统设置')
  expect(html).toContain('允许 Relay')
  assert.isDefined(control)
  control.onValueChange(false)
  await vi.waitFor(() => expect(f.busy).toHaveBeenLastCalledWith(false))
  expect(f.render().control?.isSelected).toBe(true)
  expect(f.invoke.mock.calls).toEqual([[readChannel], ['disableAutoRun'], [readChannel]])
})

it.each(['notRegistered', 'notFound'] as const)(
  'shows that macOS has not acknowledged a configured %s item',
  async (approval) => {
    const f = fixture()
    f.invoke.mockResolvedValueOnce({ configured: true, approval })
    f.render()
    await f.initialRead()
    const { control, html } = f.render()
    expect(control?.isSelected).toBe(true)
    expect(html).toContain('macOS 尚未确认登记')
    expect(f.invoke.mock.calls).toEqual([[readChannel]])
  }
)
