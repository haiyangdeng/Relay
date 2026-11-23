import { isValidElement } from 'react'
import { expect, it, vi } from 'vitest'
import { RelayTunPanel, type RelayTunControls } from './tun-panel'

// Exercise the mounted panel and its real effect cleanup while IPC replies
// arrive out of order. Network status is deliberately held busy in this test.
const hooks = vi.hoisted(() => ({
  cursor: 0,
  slots: [] as unknown[],
  cleanups: [] as Array<(() => void) | undefined>,
  effects: [] as (() => void)[]
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState(initial: unknown) {
    const index = hooks.cursor++
    if (index >= hooks.slots.length)
      hooks.slots[index] = typeof initial === 'function' ? initial() : initial
    return [
      hooks.slots[index],
      (value: unknown) => {
        hooks.slots[index] = typeof value === 'function' ? value(hooks.slots[index]) : value
      }
    ]
  },
  useRef(initial: unknown) {
    const index = hooks.cursor++
    return (hooks.slots[index] ??= { current: initial })
  },
  useSyncExternalStore(_subscribe: unknown, read: () => unknown) {
    return read()
  },
  useEffect(effect: () => void | (() => void), deps: unknown[]) {
    const index = hooks.cursor++
    const old = hooks.slots[index] as unknown[] | undefined
    if (!old || deps.some((value, i) => value !== old[i]))
      hooks.effects.push(() => {
        hooks.cleanups[index]?.()
        hooks.cleanups[index] = effect() || undefined
      })
    hooks.slots[index] = deps
  }
}))

it('resolves one live source for both the detail switch and the editor after a cold import, ignoring late selection reads', async () => {
  let actual = 'imported'
  let release!: (value: { current: string }) => void
  const read = vi.fn(async (_name: string, _force: boolean) => ({ current: actual }))
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke: read, on: () => () => {} } } })
  const empty: IProfileConfig = { items: [] }
  const first: IProfileConfig = { current: 'imported', items: [] }
  const second: IProfileConfig = { current: 'next', items: [] }
  const noop = () => {}
  function render(profileConfig: IProfileConfig, active = true) {
    hooks.cursor = 0
    const panel = RelayTunPanel({
      profileConfig,
      active,
      busy: true,
      onState: noop,
      onBusy: noop,
      onUnconfirmed: noop
    })
    const props = panel.props as Parameters<typeof RelayTunControls>[0]
    const editor = props.settings
    if (!isValidElement<{ preferredProfileId?: string }>(editor)) throw Error('missing editor')
    for (const effect of hooks.effects.splice(0)) effect()
    return {
      enabledSource: props.canPrepareConfiguration,
      editorId: editor.props.preferredProfileId
    }
  }
  try {
    render(empty, false)
    expect(read).not.toHaveBeenCalled()
    render(empty)
    await vi.waitFor(() =>
      expect(render(empty)).toEqual({ enabledSource: true, editorId: 'imported' })
    )
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          release = done
        })
    )
    // Selecting the fallback during enable must not discard it mid-operation.
    expect(render(first)).toEqual({ enabledSource: true, editorId: 'imported' })
    actual = 'next'
    expect(render(second)).toEqual({ enabledSource: false, editorId: undefined })
    await vi.waitFor(() =>
      expect(render(second)).toEqual({ enabledSource: true, editorId: 'next' })
    )
    release({ current: 'imported' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(render(second)).toEqual({ enabledSource: true, editorId: 'next' })
    expect(read.mock.calls.every(([name, force]) => name === 'getProfileConfig' && force)).toBe(
      true
    )
  } finally {
    hooks.cleanups.forEach((cleanup) => cleanup?.())
    vi.unstubAllGlobals()
  }
})
