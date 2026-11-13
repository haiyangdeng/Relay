import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type { RelayShellTrayProxyGroupStyle } from '../../../shared/relay/shell'
import { createTrayWorkflows } from './tray-workflows'

function fixture(
  showCurrentProxyInTray = false,
  trayProxyGroupStyle: RelayShellTrayProxyGroupStyle = 'submenu'
) {
  const state: LocalProxyState = {
    phase: 'running',
    pending: false,
    owned: true,
    hasRecord: true,
    uncertain: false,
    instanceId: '00000000-0000-4000-8000-000000000038',
    configurationRevision: 'revision',
    pid: 42,
    profileId: '00000000-0000-4000-8000-000000000001',
    traffic: 'listening',
    groups: [
      {
        name: '选择',
        members: ['节点A', '节点B'],
        type: 'select',
        selectable: true,
        now: '节点A',
        confirmed: true
      }
    ],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: []
  }
  const profile = {
    id: '00000000-0000-4000-8000-000000000001',
    sha256: 'a'.repeat(64),
    name: '私有配置',
    createdAt: '2026-10-28',
    summary: { proxies: 2, groups: 1, rules: 1, proxyProviders: 0, ruleProviders: 0 }
  }
  const menus: MenuItemConstructorOptions[][] = []
  const adapters = {
    showCurrentProxyInTray,
    trayProxyGroupStyle,
    load: vi.fn(async () => ({
      local: structuredClone(state),
      profiles: [profile],
      selectedId: profile.id
    })),
    local: () => structuredClone(state),
    chooseProfile: vi.fn(async () => undefined),
    chooseNode: vi.fn(async () => undefined),
    publish: vi.fn((items: MenuItemConstructorOptions[]) => {
      menus.push(items)
    }),
    assertIdle: vi.fn(),
    report: vi.fn()
  }
  return { state, profile, menus, adapters, service: createTrayWorkflows(adapters) }
}
function last<T>(items: T[]): T {
  const item = items.at(-1)
  if (!item) throw new Error('Expected published menu')
  return item
}
function children(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  if (!Array.isArray(item.submenu)) throw new Error('Expected submenu')
  return item.submenu
}
function click(item: MenuItemConstructorOptions): void {
  if (!item.click) throw new Error('Expected menu action')
  Reflect.apply(item.click, undefined, [])
}

function profileMenu(f: ReturnType<typeof fixture>): MenuItemConstructorOptions {
  const item = last(f.menus).find((entry) => entry.label === '订阅配置')
  if (!item) throw new Error('Expected profiles menu')
  return item
}
function groupMenu(f: ReturnType<typeof fixture>): MenuItemConstructorOptions {
  const item = last(f.menus).find((entry) => entry.label === '代理组')
  if (!item) throw new Error('Expected groups menu')
  return item
}

describe('Explicit snapshot-bound tray workflows', () => {
  it('coalesces menu openings into one read and places proxy groups before subscription profiles', async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = f.adapters.load.getMockImplementation()
    if (!load) throw new Error('Missing snapshot fixture')
    f.adapters.load.mockImplementationOnce(async () => {
      await gate
      return load()
    })
    const first = f.service.open()
    expect(f.service.open()).toBe(first)
    expect(f.adapters.load).toHaveBeenCalledOnce()
    release()
    await first
    expect(last(f.menus).map((item) => item.label)).toEqual(['代理组', '订阅配置'])
    expect(f.adapters.chooseProfile).not.toHaveBeenCalled()
    expect(f.adapters.chooseNode).not.toHaveBeenCalled()
  })
  it('keeps a failed open usable and retries only at the next opening, with no popup confirmation', async () => {
    const f = fixture()
    f.adapters.load.mockRejectedValueOnce(Error('read failure'))
    await f.service.open()
    expect(last(f.menus)).toEqual([{ label: '菜单暂不可用，重新打开可重试', enabled: false }])
    expect(f.adapters.report).not.toHaveBeenCalled()
    expect(f.adapters.load).toHaveBeenCalledOnce()
    await f.service.open()
    expect(profileMenu(f)).toBeDefined()
    expect(f.adapters.load).toHaveBeenCalledTimes(2)
  })
  it('discards a pending opening after disposal and does not start another read', async () => {
    const f = fixture(),
      snapshot = await f.adapters.load()
    let release!: (value: typeof snapshot) => void
    f.adapters.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const opening = f.service.open(),
      count = f.menus.length
    f.service.dispose()
    release(snapshot)
    await opening
    await f.service.open()
    expect(f.menus).toHaveLength(count)
    expect(f.adapters.load).toHaveBeenCalledTimes(2)
  })
  it('does no work on creation and reads directly when the menu is opened', async () => {
    const f = fixture()
    expect(f.adapters.load).not.toHaveBeenCalled()
    expect(f.adapters.chooseNode).not.toHaveBeenCalled()
    await f.service.open()
    await f.service.whenIdle()
    expect(f.adapters.load).toHaveBeenCalledOnce()
    expect(f.adapters.chooseProfile).not.toHaveBeenCalled()
    expect(children(profileMenu(f))[0]).toMatchObject({ label: '私有配置', checked: true })
  })
  it('shows recorded delay and timeout without probing or changing the exact node choice', async () => {
    const f = fixture()
    f.state.groups[0].health = [
      { name: '节点A', delay: 37 },
      { name: '节点B', delay: 0 }
    ]
    await f.service.refresh()
    const items = children(children(groupMenu(f))[0])
    expect(items.map((item) => item.label)).toEqual(['节点A (37ms)', '节点B (Timeout)'])
    expect(f.adapters.chooseNode).not.toHaveBeenCalled()
    click(items[1])
    await f.service.whenIdle()
    expect(f.adapters.chooseNode).toHaveBeenCalledWith(expect.objectContaining({ member: '节点B' }))
  })
  it.each([-1, NaN, Infinity, 1.5, undefined])(
    'omits unavailable recorded delay %s',
    async (delay) => {
      const f = fixture()
      f.state.groups[0].health = [{ name: '节点A', delay }]
      await f.service.refresh()
      expect(children(children(groupMenu(f))[0])[0].label).toBe('节点A')
      expect(f.adapters.chooseNode).not.toHaveBeenCalled()
    }
  )
  it('passes only the immutable selected profile to the existing selection/hot-reload workflow', async () => {
    const f = fixture()
    await f.service.refresh()
    click(children(profileMenu(f))[0])
    await f.service.whenIdle()
    expect(f.adapters.chooseProfile).toHaveBeenCalledExactlyOnceWith({
      id: f.profile.id,
      sha256: f.profile.sha256
    })
    expect(last(f.menus)[0].enabled).toBe(false)
  })
  it('keeps the clicked profile hash bound to the read snapshot rather than a mutated adapter object', async () => {
    const f = fixture()
    await f.service.refresh()
    const item = children(profileMenu(f))[0]
    f.profile.sha256 = 'b'.repeat(64)
    click(item)
    await f.service.whenIdle()
    expect(f.adapters.chooseProfile).toHaveBeenCalledExactlyOnceWith({
      id: f.profile.id,
      sha256: 'a'.repeat(64)
    })
  })
  it('binds an explicit node choice to the current instance and configuration revision', async () => {
    const f = fixture()
    await f.service.refresh()
    const group = children(groupMenu(f))[0]
    expect(children(group)[0].checked).toBe(true)
    click(children(group)[1])
    await f.service.whenIdle()
    expect(f.adapters.chooseNode).toHaveBeenCalledExactlyOnceWith({
      action: 'select',
      instanceId: f.state.instanceId,
      configurationRevision: 'revision',
      group: '选择',
      member: '节点B'
    })
  })
  it.each(['instanceId', 'configurationRevision', 'pid'] as const)(
    'refuses a stale %s even if an old menu callback survives',
    async (field) => {
      const f = fixture()
      await f.service.refresh()
      const item = children(children(groupMenu(f))[0])[1]
      if (field === 'pid') f.state.pid = 43
      else f.state[field] = 'changed'
      click(item)
      await vi.waitFor(() => expect(f.adapters.report).toHaveBeenCalledOnce())
      expect(f.adapters.chooseNode).not.toHaveBeenCalled()
    }
  )
  it('rejects invalidated menus and changed live group membership', async () => {
    const f = fixture()
    await f.service.refresh()
    const stale = children(children(groupMenu(f))[0])[1]
    f.service.invalidate()
    click(stale)
    await vi.waitFor(() => expect(f.adapters.report).toHaveBeenCalledOnce())
    await f.service.refresh()
    const changed = children(children(groupMenu(f))[0])[1]
    f.state.groups[0].members = ['节点A']
    click(changed)
    await f.service.whenIdle()
    expect(f.adapters.chooseNode).not.toHaveBeenCalled()
  })
  it('does not offer or execute node changes for an automatic-only or unconfirmed group', async () => {
    const f = fixture()
    f.state.groups[0].selectable = false
    f.state.groups[0].type = 'url-test'
    await f.service.refresh()
    const group = children(groupMenu(f))[0]
    expect(group.enabled).toBe(false)
    click(children(group)[0])
    await f.service.whenIdle()
    expect(f.adapters.chooseNode).not.toHaveBeenCalled()
  })
  it.each(['url-test', 'fallback', 'smart'] as const)(
    'offers an explicit return to automatic for a confirmed pinned %s group',
    async (type) => {
      const f = fixture()
      f.state.groups[0].dynamic = type !== 'smart'
      f.state.groups[0].fixed = '节点A'
      f.state.groups[0].selectable = false
      f.state.groups[0].type = type
      await f.service.refresh()
      const item = children(children(groupMenu(f))[0])[0]
      expect(item.label).toBe('恢复自动选择')
      click(item)
      await f.service.whenIdle()
      expect(f.adapters.chooseNode).toHaveBeenCalledExactlyOnceWith({
        action: 'automatic',
        instanceId: f.state.instanceId,
        configurationRevision: 'revision',
        group: '选择'
      })
    }
  )
  it('keeps retry enabled after failed loading rather than leaving a busy menu forever', async () => {
    const f = fixture()
    f.adapters.load.mockRejectedValueOnce(new Error('IO'))
    await expect(f.service.refresh()).rejects.toThrow('IO')
    expect(f.service.isBusy()).toBe(false)
    expect(last(f.menus)[0].enabled).toBe(false)
    await f.service.refresh()
    expect(children(profileMenu(f))[0].label).toBe('私有配置')
  })
  it('discards a late read after invalidation and releases close waiters', async () => {
    const f = fixture(),
      snapshot = await f.adapters.load()
    let finish!: (value: typeof snapshot) => void
    f.adapters.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const reading = f.service.refresh(),
      idle = vi.fn()
    void f.service.whenIdle().then(idle)
    await expect(f.service.refresh()).rejects.toThrow('尚未结束')
    f.service.invalidate()
    expect(idle).not.toHaveBeenCalled()
    finish(snapshot)
    await reading
    await f.service.whenIdle()
    expect(last(f.menus)[0].label).toContain('已变化')
    expect(last(f.menus)[0].enabled).toBe(false)
  })
  it('rejects actions after the global quit/restore gate changes', async () => {
    const f = fixture()
    await f.service.refresh()
    f.adapters.assertIdle.mockImplementation(() => {
      throw new Error('quitting')
    })
    click(children(profileMenu(f))[0])
    await vi.waitFor(() => expect(f.adapters.report).toHaveBeenCalledOnce())
    expect(f.adapters.chooseProfile).not.toHaveBeenCalled()
  })
  it('refuses oversized or malformed menus without publishing a partial list', async () => {
    const f = fixture()
    f.profile.name = 'invalid\nlabel'
    await expect(f.service.refresh()).rejects.toThrow('名称')
    f.profile.name = 'valid'
    f.adapters.load.mockResolvedValueOnce({
      local: f.state,
      profiles: Array(201).fill(f.profile),
      selectedId: f.profile.id
    })
    await expect(f.service.refresh()).rejects.toThrow('条目过多')
    expect(f.adapters.chooseProfile).not.toHaveBeenCalled()
  })
  it('does not publish or execute retained menu callbacks after disposal', async () => {
    const f = fixture()
    await f.service.refresh()
    const old = children(profileMenu(f))[0],
      count = f.menus.length
    f.service.dispose()
    click(old)
    await Promise.resolve()
    expect(f.adapters.chooseProfile).not.toHaveBeenCalled()
    expect(f.menus).toHaveLength(count)
  })
})

describe('Cached current-proxy group labels', () => {
  const heading = (f: ReturnType<typeof fixture>) => children(groupMenu(f))[0]
  it('uses the fixed default false and does no load when toggled before the first explicit read', async () => {
    const f = fixture()
    f.service.setCurrentProxyVisible(true)
    expect(f.adapters.load).not.toHaveBeenCalled()
    await f.service.refresh()
    expect(heading(f).label).toBe('选择 | 节点A')
    expect(f.adapters.load).toHaveBeenCalledOnce()
  })
  it('restores a previously loaded true preference on the first refresh', async () => {
    const f = fixture(true)
    await f.service.refresh()
    expect(heading(f).label).toBe('选择 | 节点A')
    expect(f.adapters.load).toHaveBeenCalledOnce()
  })
  it('toggles only cached text and preserves exact choice identities and history labels', async () => {
    const f = fixture()
    f.state.groups[0].health = [{ name: '节点B', delay: 37 }]
    await f.service.refresh()
    expect(heading(f).label).toBe('选择')
    f.service.setCurrentProxyVisible(true)
    expect(heading(f).label).toBe('选择 | 节点A')
    expect(children(heading(f))[1].label).toBe('节点B (37ms)')
    f.service.setCurrentProxyVisible(false)
    expect(heading(f).label).toBe('选择')
    f.service.setCurrentProxyVisible(true)
    expect(f.adapters.load).toHaveBeenCalledOnce()
    click(children(heading(f))[1])
    await f.service.whenIdle()
    expect(f.adapters.chooseNode).toHaveBeenCalledExactlyOnceWith({
      action: 'select',
      instanceId: f.state.instanceId,
      configurationRevision: 'revision',
      group: '选择',
      member: '节点B'
    })
  })
  it.each([undefined, '', 'unknown', '\u0000'])(
    'omits unknown or empty selected value %s',
    async (now) => {
      const f = fixture(true)
      f.state.groups[0].now = now
      await f.service.refresh()
      expect(heading(f).label).toBe('选择')
    }
  )
  it('omits unconfirmed selection and uses the existing label validator for the combination', async () => {
    const f = fixture(true)
    f.state.groups[0].confirmed = false
    await f.service.refresh()
    expect(heading(f).label).toBe('选择')
    f.state.groups[0].confirmed = true
    f.state.groups[0].name = '组'.repeat(200)
    f.state.groups[0].members = ['节'.repeat(100)]
    f.state.groups[0].now = f.state.groups[0].members[0]
    await f.service.refresh()
    expect(heading(f).label).toBe('组'.repeat(200))
    f.state.groups[0].name = '组'.repeat(128)
    f.state.groups[0].members = ['节'.repeat(125)]
    f.state.groups[0].now = f.state.groups[0].members[0]
    await f.service.refresh()
    expect(heading(f).label).toBe(`${'组'.repeat(128)} | ${'节'.repeat(125)}`)
  })
  it('never revives an invalidated cache and does no additional source work', async () => {
    const f = fixture()
    await f.service.refresh()
    f.service.invalidate()
    f.service.setCurrentProxyVisible(true)
    expect(last(f.menus)[0].label).toContain('已变化')
    expect(last(f.menus)).toHaveLength(1)
    expect(f.adapters.load).toHaveBeenCalledOnce()
  })
  it.each(['instance', 'configuration', 'pending', 'uncertain'] as const)(
    'retires cached text after %s changes',
    async (field) => {
      const f = fixture()
      await f.service.refresh()
      if (field === 'instance') f.state.instanceId = 'another-instance'
      if (field === 'configuration') f.state.configurationRevision = 'another-config'
      if (field === 'pending') f.state.pending = true
      if (field === 'uncertain') f.state.uncertain = true
      f.service.setCurrentProxyVisible(true)
      expect(last(f.menus)).toHaveLength(1)
      expect(last(f.menus)[0].label).toContain('已变化')
      expect(f.adapters.load).toHaveBeenCalledOnce()
    }
  )
  it('does not revive a cache revoked while an explicit refresh is awaiting its source', async () => {
    const f = fixture()
    let release: (snapshot: Awaited<ReturnType<typeof f.adapters.load>>) => void = () => {
      throw new Error('No pending source')
    }
    f.adapters.load.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    const pending = f.service.refresh()
    try {
      f.service.setCurrentProxyVisible(true)
      f.service.invalidate()
    } finally {
      release({ local: structuredClone(f.state), profiles: [f.profile], selectedId: f.profile.id })
      await pending
    }
    expect(last(f.menus)).toHaveLength(1)
    expect(last(f.menus)[0].label).toContain('已变化')
    expect(f.adapters.load).toHaveBeenCalledOnce()
  })
  it('does not publish or reload after disposal', async () => {
    const f = fixture()
    await f.service.refresh()
    const count = f.adapters.publish.mock.calls.length
    f.service.dispose()
    f.service.setCurrentProxyVisible(true)
    expect(f.adapters.publish).toHaveBeenCalledTimes(count)
    expect(f.adapters.load).toHaveBeenCalledOnce()
  })
})

describe('Cached tray labels cannot regain owner readiness', () => {
  it.each(['inactive', 'unconfirmed'] as const)(
    'invalidates a previously ready cache after current traffic becomes %s',
    async (traffic) => {
      const f = fixture()
      await f.service.refresh()
      expect(children(groupMenu(f))[0].label).toBe('选择')
      const old = structuredClone(f.state)
      f.state.traffic = traffic
      expect({ ...f.state, traffic: old.traffic }).toEqual(old)
      f.service.setCurrentProxyVisible(true)
      expect(last(f.menus)).toHaveLength(1)
      expect(last(f.menus)[0].label).toContain('已变化')
      expect(f.adapters.load).toHaveBeenCalledOnce()
      expect(f.adapters.chooseNode).not.toHaveBeenCalled()
      expect(f.adapters.chooseProfile).not.toHaveBeenCalled()
      f.service.setCurrentProxyVisible(false)
      expect(last(f.menus)).toHaveLength(1)
      expect(f.adapters.load).toHaveBeenCalledOnce()
    }
  )
})

describe('Cached tray group layout', () => {
  it('projects group submenus at the top level or in the existing wrapper without another read', async () => {
    const f = fixture(true, 'default')
    await f.service.refresh()
    let menu = last(f.menus)
    const group = menu.find((item) => item.label === '选择 | 节点A')
    if (!group) throw new Error('Expected flat group')
    expect(children(group)).toHaveLength(2)
    expect(menu.find((item) => item.label === '代理组')?.submenu).toBeUndefined()
    f.service.setGroupStyle('submenu')
    menu = last(f.menus)
    expect(children(groupMenu(f))[0]).toBe(group)
    f.service.setGroupStyle('default')
    expect(last(f.menus).find((item) => item.label === '选择 | 节点A')).toBe(group)
    expect(f.adapters.load).toHaveBeenCalledOnce()
    expect(f.adapters.chooseNode).not.toHaveBeenCalled()
  })
  it('retains exact member callback and authority arguments while moving a cached group', async () => {
    const f = fixture(true, 'default')
    await f.service.refresh()
    const group = last(f.menus).find((item) => item.label === '选择 | 节点A')
    if (!group) throw new Error('Expected flat group')
    const member = children(group)[1],
      handler = member.click
    f.service.setGroupStyle('submenu')
    expect(children(children(groupMenu(f))[0])[1].click).toBe(handler)
    click(member)
    await f.service.whenIdle()
    expect(f.adapters.chooseNode).toHaveBeenCalledExactlyOnceWith({
      action: 'select',
      instanceId: f.state.instanceId,
      configurationRevision: f.state.configurationRevision,
      group: '选择',
      member: '节点B'
    })
    expect(f.adapters.load).toHaveBeenCalledOnce()
  })
  it.each(['traffic', 'binding', 'uncertain'] as const)(
    'invalidates the cached layout on %s changes rather than reviving an old ready menu',
    async (kind) => {
      const f = fixture(true)
      await f.service.refresh()
      if (kind === 'traffic') f.state.traffic = 'inactive'
      else if (kind === 'binding') f.state.configurationRevision = 'changed'
      else f.state.uncertain = true
      f.service.setGroupStyle('default')
      expect(last(f.menus)[0].label).toContain('重新打开')
      expect(last(f.menus).some((item) => item.label === '选择 | 节点A')).toBe(false)
      expect(f.adapters.load).toHaveBeenCalledOnce()
      expect(f.adapters.chooseNode).not.toHaveBeenCalled()
    }
  )
  it('does not load on a setter before any read, rejects invalid enums, and ignores disposed changes', () => {
    const f = fixture()
    f.service.setGroupStyle('default')
    expect(f.adapters.load).not.toHaveBeenCalled()
    expect(() => f.service.setGroupStyle('invalid' as RelayShellTrayProxyGroupStyle)).toThrow(
      '布局'
    )
    f.service.dispose()
    const count = f.menus.length
    f.service.setGroupStyle('submenu')
    expect(f.menus).toHaveLength(count)
  })
})

describe('Cached tray group visibility', () => {
  it.each(['default', 'submenu'] as const)(
    'hides and restores %s groups without reading, probing or replacing exact actions',
    async (style) => {
      const f = fixture(true, style)
      await f.service.refresh()
      const group =
        style === 'default'
          ? last(f.menus).find((item) => item.label === '选择 | 节点A')
          : children(groupMenu(f))[0]
      if (!group) throw new Error('Expected group')
      const handler = children(group)[1].click
      f.service.setProxyGroupsVisible(false)
      expect(last(f.menus).map((item) => item.label)).toEqual(['订阅配置'])
      expect(children(profileMenu(f))[0].label).toBe('私有配置')
      f.service.setGroupStyle(style === 'default' ? 'submenu' : 'default')
      expect(last(f.menus)).toHaveLength(1)
      f.service.setGroupStyle(style)
      f.service.setProxyGroupsVisible(true)
      const restored =
        style === 'default'
          ? last(f.menus).find((item) => item.label === '选择 | 节点A')
          : children(groupMenu(f))[0]
      expect(restored).toBe(group)
      if (!restored) throw new Error('Expected restored group')
      expect(children(restored)[1].click).toBe(handler)
      expect(f.adapters.load).toHaveBeenCalledOnce()
      expect(f.adapters.chooseNode).not.toHaveBeenCalled()
      expect(f.adapters.chooseProfile).not.toHaveBeenCalled()
      click(children(restored)[1])
      await f.service.whenIdle()
      expect(f.adapters.chooseNode).toHaveBeenCalledExactlyOnceWith({
        action: 'select',
        instanceId: f.state.instanceId,
        configurationRevision: f.state.configurationRevision,
        group: '选择',
        member: '节点B'
      })
    }
  )
  it.each(['traffic', 'binding', 'uncertain', 'pending'] as const)(
    'does not revive hidden groups or old actions after %s changes',
    async (kind) => {
      const f = fixture()
      await f.service.refresh()
      const old = children(children(groupMenu(f))[0])[0]
      f.service.setProxyGroupsVisible(false)
      if (kind === 'traffic') f.state.traffic = 'inactive'
      else if (kind === 'binding') f.state.configurationRevision = 'changed'
      else f.state[kind] = true
      f.service.setProxyGroupsVisible(true)
      expect(last(f.menus)[0].label).toContain('重新打开')
      expect(last(f.menus).some((item) => item.label === '代理组')).toBe(false)
      click(old)
      await Promise.resolve()
      expect(f.adapters.chooseNode).not.toHaveBeenCalled()
      expect(f.adapters.load).toHaveBeenCalledOnce()
    }
  )
  it('retains the latest visibility choice made while an explicit read is pending', async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.adapters.load.mockImplementationOnce(async () => {
      await gate
      return { local: structuredClone(f.state), profiles: [f.profile], selectedId: f.profile.id }
    })
    const reading = f.service.refresh()
    f.service.setProxyGroupsVisible(false)
    release()
    await reading
    expect(last(f.menus).map((item) => item.label)).toEqual(['订阅配置'])
    f.service.setProxyGroupsVisible(true)
    expect(children(groupMenu(f))[0].label).toBe('选择')
    expect(f.adapters.load).toHaveBeenCalledOnce()
    expect(f.adapters.chooseNode).not.toHaveBeenCalled()
  })
  it('honors a disabled startup preference without requiring an extra apply or touching the Core', async () => {
    const f = fixture()
    const service = createTrayWorkflows({ ...f.adapters, proxyInTray: false })
    await service.refresh()
    expect(last(f.menus).map((item) => item.label)).toEqual(['订阅配置'])
    service.setProxyGroupsVisible(true)
    expect(children(groupMenu(f))[0].label).toBe('选择')
    expect(f.adapters.load).toHaveBeenCalledOnce()
    service.dispose()
  })
  it('does no work before the first read, rejects invalid values and ignores changes after disposal', () => {
    const f = fixture()
    f.service.setProxyGroupsVisible(false)
    f.service.setProxyGroupsVisible(true)
    expect(f.adapters.load).not.toHaveBeenCalled()
    expect(f.adapters.chooseNode).not.toHaveBeenCalled()
    expect(() => f.service.setProxyGroupsVisible('false' as never)).toThrow('布尔')
    expect(() => createTrayWorkflows({ ...f.adapters, proxyInTray: null as never })).toThrow('布尔')
    f.service.dispose()
    const count = f.menus.length
    f.service.setProxyGroupsVisible(false)
    expect(f.menus).toHaveLength(count)
  })
})
