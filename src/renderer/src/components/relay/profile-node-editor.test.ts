import { isValidElement, type ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayProfilePreparation, RelayStoredProfile } from '../../../../shared/relay/profiles'
import { RelayProfileNodeEditor } from './profile-node-editor'

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect() {
    /* Name-only payload tests; lifecycle is covered by direct-resource-actions. */
  },
  useState<T>(initial: T | (() => T)) {
    const at = hooks.cursor++
    if (at >= hooks.slots.length)
      hooks.slots[at] = typeof initial === 'function' ? (initial as () => T)() : initial
    return [
      hooks.slots[at] as T,
      (next: T | ((old: T) => T)) => {
        hooks.slots[at] =
          typeof next === 'function' ? (next as (old: T) => T)(hooks.slots[at] as T) : next
      }
    ]
  },
  useRef<T>(initial: T) {
    const at = hooks.cursor++
    if (at >= hooks.slots.length) hooks.slots[at] = { current: initial }
    return hooks.slots[at] as { current: T }
  }
}))
const profile: RelayStoredProfile = {
  id: '00000000-0000-0000-0000-000000000001',
  sha256: 'a'.repeat(64),
  name: 'Private',
  createdAt: '2026-11-03T00:00:00Z',
  summary: { proxies: 1, groups: 1, rules: 0, proxyProviders: 0, ruleProviders: 0 }
}
const proof: RelayProfilePreparation = {
  evidenceId: '00000000-0000-0000-0000-000000000002',
  name: 'Private-edited.json',
  sha256: 'b'.repeat(64),
  bytes: 100,
  inspection: { structure: 'passed', active: false, coreCompatibility: 'notVerified', issues: [] }
}
const nodes = [{ name: 'A', type: 'ss', password: 'retained-private-value' }]
function elements(node: ReactNode): { type: unknown; props: Record<string, unknown> }[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}
function content(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(content).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return content(node.props.children)
  return ''
}
beforeEach(() => {
  hooks.slots = []
  hooks.cursor = 0
})
function fixture(groups = false) {
  const invoke = vi.fn(async (channel: string): Promise<unknown> => {
      if (channel.endsWith('Read'))
        return groups
          ? { profile, groups: nodes, targets: ['A'], providers: [] }
          : { profile, nodes }
      if (channel === 'relayProfileSave') return { status: 'saved', profile }
      return proof
    }),
    onBusy = vi.fn()
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } })
  const render = () => {
    hooks.cursor = 0
    return RelayProfileNodeEditor({
      profile,
      busy: false,
      onBusy,
      collection: groups ? 'groups' : 'nodes'
    })
  }
  const find = (type: string, part?: string) => {
    const found = elements(render()).find(
      (element) =>
        element.type === type &&
        (!part || content(element.props.children as ReactNode).includes(part))
    )
    if (!found) throw new Error(`fixture element missing: ${type} ${part ?? ''}`)
    return found.props
  }
  const change = (type: string, value: string) => {
    const fn = find(type).onChange
    if (typeof fn !== 'function') throw new Error('missing change')
    fn({ target: { value } })
  }
  const click = async (part: string) => {
    const fn = find('button', part).onClick
    if (typeof fn !== 'function') throw new Error('missing click')
    fn()
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  return { invoke, render, find, change, click, onBusy }
}
describe('Explicit name-only profile editor intent (injected hooks/IPC, no product GUI)', () => {
  it('shows the shared YAML identity restriction at the explicit rename entry', async () => {
    const f = fixture()
    await f.click('读取')
    f.change('select', '0')
    expect(content(f.render())).toContain('改名不接受共享的YAML对象或数组别名')
  })
  it.each([false, true])(
    'sends rename only and preserves an unrelated invalid JSON draft, groups=%s',
    async (groups) => {
      const f = fixture(groups)
      expect(elements(f.render()).some((element) => element.type === 'input')).toBe(false)
      await f.click('读取')
      f.change('select', '0')
      f.change('textarea', 'unsaved invalid JSON')
      f.change('input', 'Renamed')
      await f.click('改名并另存')
      expect(f.invoke).toHaveBeenCalledWith(
        groups ? 'relayProfileGroupsPrepare' : 'relayProfileNodesPrepare',
        {
          profile: { id: profile.id, sha256: profile.sha256 },
          action: 'rename',
          originalName: 'A',
          newName: 'Renamed'
        }
      )
      expect(f.find('textarea').value).toBe('unsaved invalid JSON')
      expect(
        f.invoke.mock.calls.filter(([channel]) => channel === 'relayProfileSave')
      ).toHaveLength(1)
      expect(f.invoke).toHaveBeenLastCalledWith('relayProfileSave', {
        evidenceId: proof.evidenceId
      })
    }
  )
  it('never saves a failed rename and preserves the editable source draft', async () => {
    const f = fixture()
    await f.click('读取')
    f.change('select', '0')
    f.change('input', 'Renamed')
    f.invoke.mockRejectedValueOnce(new Error('private failure'))
    await f.click('改名并另存')
    expect(f.invoke).not.toHaveBeenCalledWith('relayProfileSave', expect.anything())
    expect(f.find('textarea').value).toContain('retained-private-value')
    f.change('select', '')
    expect(elements(f.render()).some((element) => element.type === 'input')).toBe(false)
  })
  it('shares the existing in-flight guard across repeated rename clicks', async () => {
    const f = fixture()
    await f.click('读取')
    f.change('select', '0')
    f.change('input', 'Renamed')
    let finish: ((value: unknown) => void) | undefined
    f.invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const click = f.find('button', '改名并另存').onClick
    if (typeof click !== 'function') throw new Error('missing click')
    click()
    click()
    expect(f.invoke.mock.calls.filter(([channel]) => channel.endsWith('Prepare'))).toHaveLength(1)
    if (!finish) throw new Error('missing pending operation')
    finish(proof)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(f.invoke.mock.calls.filter(([channel]) => channel === 'relayProfileSave')).toHaveLength(
      1
    )
  })
})
