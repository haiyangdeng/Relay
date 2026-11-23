import { expect, it, vi } from 'vitest'
import { applySavedSelectorDefaults, restoreSavedSelectors } from './startup-node'
it('sets a validated selector default before first traffic without changing order, automatic strategy or providers', () => {
  const group = {
    name: 'Main',
    type: 'select',
    proxies: ['First', 'Chosen'],
    'default-selected': 'First'
  }
  const fallback = { name: 'Auto', type: 'fallback', proxies: ['First', 'Chosen'] }
  const config = {
    proxies: [
      { name: 'First', type: 'http' },
      { name: 'Chosen', type: 'http' },
      { name: 'Skip', type: 'pass' }
    ],
    'proxy-providers': { remote: { type: 'inline', payload: [{ name: 'From provider' }] } },
    'proxy-groups': [group, fallback]
  }
  const saved = new Map([
    ['Main', 'Chosen'],
    ['GLOBAL', 'Main'],
    ['Auto', 'Chosen']
  ])
  applySavedSelectorDefaults(config, saved)
  expect(group).toMatchObject({ proxies: ['First', 'Chosen'], 'default-selected': 'Chosen' })
  expect(fallback).not.toHaveProperty('default-selected')
  expect(config['proxy-groups'][2]).toEqual({
    name: 'GLOBAL',
    type: 'select',
    proxies: ['DIRECT', 'REJECT', 'First', 'Chosen', 'Main', 'Auto'],
    'default-selected': 'Main'
  })
  for (const selection of ['removed', 'From provider']) {
    applySavedSelectorDefaults(config, new Map([['Main', selection]]))
    expect(group['default-selected']).toBe('Chosen')
  }
  const filtered = { ...group, filter: 'First' }
  const dynamic = { name: 'Remote', type: 'select', use: ['remote'] }
  const special = {
    'proxy-providers': { GLOBAL: {} },
    'proxy-groups': [filtered, dynamic],
    proxies: config.proxies
  }
  applySavedSelectorDefaults(
    special,
    new Map([
      ['Main', 'First'],
      ['Remote', 'From provider'],
      ['GLOBAL', 'Main']
    ])
  )
  expect(filtered['default-selected']).toBe('Chosen')
  expect(dynamic).not.toHaveProperty('default-selected')
  expect(special['proxy-groups']).toHaveLength(2)
})
it('restores the saved node, including an explicitly pinned automatic winner, without a latency test', async () => {
  const select = vi.fn(),
    group = vi.fn(async () => ({ now: 'B', fixed: 'B' }))
  await restoreSavedSelectors(
    { select, group },
    [{ name: 'Main', type: 'fallback', members: ['A', 'B'], now: 'B', fixed: '', confirmed: true }],
    new Map([['Main', 'B']]),
    () => {}
  )
  expect(select).toHaveBeenCalledWith('Main', 'B')
})
it('skips unavailable old members and never picks a replacement', async () => {
  const select = vi.fn(),
    group = vi.fn()
  await restoreSavedSelectors(
    { select, group },
    [{ name: 'Main', type: 'select', members: ['A', 'B'], now: 'A', confirmed: true }],
    new Map([['Main', 'removed']]),
    () => {}
  )
  expect(select).not.toHaveBeenCalled()
  expect(group).not.toHaveBeenCalled()
})
