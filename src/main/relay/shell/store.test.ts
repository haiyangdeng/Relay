import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import { defaultShellSettings, shellSettings } from '../../../shared/relay/shell'
import { RelayShellStore } from './store'

describe('Private Relay shell preferences', () => {
  it('keeps the legacy file readable and commits display preferences only for its exact revision', async () => {
    const root = await mkdtemp('/private/tmp/relay-shell-display-')
    const store = new RelayShellStore({ stateRoot: root })
    const basePath = join(root, 'UI/shell.json'),
      displayPath = join(root, 'UI/shell-display.json')
    const hash = (value: Buffer | string): string =>
      createHash('sha256').update(value).digest('hex')
    try {
      const saved = await store.save(
        {
          ...defaultShellSettings(),
          floatingWindowCompatMode: false,
          trayTrafficTextColor: 'white'
        },
        ''
      )
      const oldBase = await readFile(basePath)
      expect(JSON.parse(oldBase.toString('utf8'))).toEqual(defaultShellSettings())
      expect((await stat(displayPath)).mode & 0o777).toBe(0o600)
      expect((await store.read()).settings).toMatchObject({
        floatingWindowCompatMode: false,
        trayTrafficTextColor: 'white'
      })

      const nextBase = JSON.stringify({ ...defaultShellSettings(), appTheme: 'dark' }, null, 2)
      await writeFile(
        displayPath,
        JSON.stringify({
          version: 1,
          entries: [
            {
              baseRevision: hash(oldBase),
              floatingWindowCompatMode: false,
              trayTrafficTextColor: 'white'
            },
            {
              baseRevision: hash(nextBase),
              floatingWindowCompatMode: true,
              trayTrafficTextColor: 'black'
            }
          ]
        })
      )
      // An interrupted stage does not make the pending display choice visible.
      expect(await store.read()).toEqual(saved)
      await writeFile(basePath, nextBase)
      const committed = await store.read()
      expect(committed.settings).toMatchObject({
        appTheme: 'dark',
        floatingWindowCompatMode: true,
        trayTrafficTextColor: 'black'
      })
      await expect(store.save(defaultShellSettings(), saved.revision)).rejects.toThrow('修改')

      const restored = await store.save(defaultShellSettings(), committed.revision)
      expect(restored.settings).toEqual(defaultShellSettings())
      expect(await store.read()).toEqual(restored)
      expect(await readFile(basePath)).toEqual(oldBase)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('preserves legacy bytes on read and writes new preferences only on an explicit save', async () => {
    const root = await mkdtemp('/private/tmp/relay-shell-legacy-'),
      store = new RelayShellStore({ stateRoot: root }),
      path = join(root, 'UI/shell.json')
    try {
      await mkdir(join(root, 'UI'), { mode: 0o700 })
      const {
          showDockIcon: _legacyMissing,
          themes: _missingThemes,
          environmentFormat: _missingFormat,
          swapTrayClick: _missingSwap,
          triggerMainWindowBehavior: _missingTrigger,
          spinFloatingIcon: _missingSpin,
          ...legacy
        } = defaultShellSettings(),
        original = JSON.stringify(legacy)
      await writeFile(path, original, { mode: 0o600 })
      const read = await store.read()
      expect(read.settings.showDockIcon).toBe(true)
      expect(read.settings.themes).toEqual([])
      expect(read.settings.environmentFormat).toBe('default')
      expect(read.settings.environmentFormats).toBeUndefined()
      expect(read.settings.swapTrayClick).toBe(false)
      expect(read.settings.triggerMainWindowBehavior).toBe('show')
      expect(read.settings.spinFloatingIcon).toBe(true)
      expect(await readFile(path, 'utf8')).toBe(original)
      await store.save(
        {
          ...read.settings,
          showDockIcon: false,
          environmentFormat: 'fish',
          environmentFormats: ['nushell', 'bash'],
          swapTrayClick: true,
          triggerMainWindowBehavior: 'toggle',
          spinFloatingIcon: false
        },
        read.revision
      )
      expect((await store.read()).settings).toMatchObject({
        showDockIcon: false,
        environmentFormat: 'fish',
        environmentFormats: ['nushell', 'bash'],
        swapTrayClick: true,
        triggerMainWindowBehavior: 'toggle',
        spinFloatingIcon: false
      })
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each([
    { formats: [] },
    { formats: ['fish', 'fish'] },
    { formats: ['zsh'] },
    { formats: null }
  ])('rejects invalid ordered clipboard formats $formats', ({ formats }) => {
    expect(() =>
      shellSettings({ ...defaultShellSettings(), environmentFormats: formats })
    ).toThrow()
  })
  it('round-trips a maximum byte-budget stylesheet even when JSON escaping exceeds the old file cap', async () => {
    const root = await mkdtemp('/private/tmp/relay-shell-css-'),
      store = new RelayShellStore({ stateRoot: root })
    try {
      const css = '\n'.repeat(8192)
      await store.save({ ...defaultShellSettings(), customCSS: css }, '')
      expect((await store.read()).settings.customCSS).toBe(css)
      expect((await stat(join(root, 'UI/shell.json'))).size).toBeGreaterThan(16384)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('round-trips the complete theme byte budget with worst-case JSON escaping and private permissions', async () => {
    const root = await mkdtemp('/private/tmp/relay-shell-themes-'),
      store = new RelayShellStore({ stateRoot: root })
    try {
      const settings = {
        ...defaultShellSettings(),
        customCSS: '\u0001'.repeat(8192),
        themes: Array.from({ length: 4 }, (_, index) => ({
          id: '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0'),
          name: 'Theme ' + index,
          css: '\u0001'.repeat(8192)
        }))
      }
      const saved = await store.save(settings, '')
      expect((await store.read()).settings).toEqual(settings)
      const path = join(root, 'UI/shell.json'),
        info = await stat(path)
      expect(info.size).toBeGreaterThan(196608)
      expect(info.size).toBeLessThan(262144)
      expect(info.mode & 0o777).toBe(0o600)
      await expect(store.save(settings, '')).rejects.toThrow('修改')
      expect((await store.read()).revision).toBe(saved.revision)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('persists privately, refuses stale revisions and does not reset corrupt data', async () => {
    const root = await mkdtemp('/private/tmp/relay-shell-store-'),
      store = new RelayShellStore({ stateRoot: root })
    try {
      const initial = await store.read()
      expect(initial.exists).toBe(false)
      const saved = await store.save({ ...defaultShellSettings(), appTheme: 'dark' }, '')
      expect((await store.read()).settings.appTheme).toBe('dark')
      expect(saved.revision).toHaveLength(64)
      expect((await stat(join(root, 'UI', 'shell.json'))).mode & 0o777).toBe(0o600)
      await expect(store.save(defaultShellSettings(), '')).rejects.toThrow('修改')
      await writeFile(join(root, 'UI', 'shell.json'), '{broken')
      await expect(store.read()).rejects.toThrow('读取失败')
      await expect(store.save(defaultShellSettings(), saved.revision)).rejects.toThrow('读取失败')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Seven-action settings remain byte-preserved until explicit save', () => {
  it('reads a real old record without writing new bindings, then saves only on explicit CAS', async () => {
    const root = await mkdtemp('/private/tmp/relay-shell-seven-')
    const store = new RelayShellStore({ stateRoot: root })
    const path = join(root, 'UI/shell.json')
    try {
      await mkdir(join(root, 'UI'), { mode: 0o700 })
      const settings = defaultShellSettings()
      const {
        triggerSysProxy: _proxy,
        triggerTun: _tun,
        runInBackground: _background,
        restartApp: _restart,
        ...seven
      } = settings.shortcuts
      const original = JSON.stringify({ ...settings, shortcuts: seven })
      await writeFile(path, original, { mode: 0o600 })
      const observed = await store.read()
      expect(observed.settings.shortcuts.triggerSysProxy).toBe('')
      expect(observed.settings.shortcuts.triggerTun).toBe('')
      expect(observed.settings.shortcuts.runInBackground).toBe('')
      expect(await readFile(path, 'utf8')).toBe(original)
      await store.save(
        {
          ...observed.settings,
          shortcuts: { ...observed.settings.shortcuts, triggerTun: 'Command+Shift+T' }
        },
        observed.revision
      )
      expect((await store.read()).settings.shortcuts.triggerTun).toBe('Command+Shift+T')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Restart preference keeps real ten-action bytes until explicit save', () => {
  it('adds only an empty restart binding on read and writes it only through revision-checked save', async () => {
    const root = await mkdtemp('/private/tmp/relay-shell-restart-')
    const store = new RelayShellStore({ stateRoot: root }),
      path = join(root, 'UI/shell.json')
    try {
      await mkdir(join(root, 'UI'), { mode: 0o700 })
      const settings = defaultShellSettings(),
        { restartApp: _missing, ...shortcuts } = settings.shortcuts
      const bytes = JSON.stringify({ ...settings, shortcuts })
      await writeFile(path, bytes, { mode: 0o600 })
      const read = await store.read()
      expect(read.settings.shortcuts.restartApp).toBe('')
      expect(await readFile(path, 'utf8')).toBe(bytes)
      await store.save(read.settings, read.revision)
      expect((await store.read()).settings.shortcuts.restartApp).toBe('')
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('Current-proxy preference legacy bytes and CAS', () => {
  it('reads old bytes unchanged and writes explicit false only on a successful save', async () => {
    const root = await mkdtemp('/private/tmp/relay-shell-current-proxy-'),
      store = new RelayShellStore({ stateRoot: root }),
      path = join(root, 'UI/shell.json')
    try {
      const { showCurrentProxyInTray: _missing, ...legacy } = defaultShellSettings(),
        bytes = JSON.stringify(legacy)
      await mkdir(join(root, 'UI'), { mode: 0o700 })
      await writeFile(path, bytes, { mode: 0o600 })
      const record = await store.read()
      expect(record.settings.showCurrentProxyInTray).toBe(false)
      expect(await readFile(path, 'utf8')).toBe(bytes)
      const saved = await store.save(
        { ...record.settings, showCurrentProxyInTray: true },
        record.revision
      )
      await expect(
        store.save({ ...saved.settings, showCurrentProxyInTray: false }, record.revision)
      ).rejects.toThrow('修改')
      expect((await store.read()).settings.showCurrentProxyInTray).toBe(true)
      await store.save({ ...saved.settings, showCurrentProxyInTray: false }, saved.revision)
      expect((await store.read()).settings.showCurrentProxyInTray).toBe(false)
      expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

it('distinguishes fresh upstream layout from byte-preserved legacy collapsed layout and writes only an explicit CAS choice', async () => {
  const root = await mkdtemp('/private/tmp/relay-shell-layout-'),
    store = new RelayShellStore({ stateRoot: root }),
    path = join(root, 'UI/shell.json')
  try {
    const fresh = await store.read()
    expect(fresh).toMatchObject({
      exists: false,
      revision: '',
      settings: { trayProxyGroupStyle: 'default' }
    })
    const { trayProxyGroupStyle: _missing, ...legacy } = defaultShellSettings(),
      bytes = Buffer.from(JSON.stringify(legacy, null, 2))
    await mkdir(join(root, 'UI'), { mode: 0o700 })
    await writeFile(path, bytes, { mode: 0o600 })
    const before = await stat(path),
      originalSHA = createHash('sha256').update(bytes).digest('hex')
    const record = await store.read()
    expect(record).toMatchObject({
      exists: true,
      revision: originalSHA,
      settings: { trayProxyGroupStyle: 'submenu' }
    })
    await store.read()
    expect(await readFile(path)).toEqual(bytes)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
    const saved = await store.save(
      { ...record.settings, trayProxyGroupStyle: 'default' },
      record.revision
    )
    expect(saved.settings).toEqual({ ...record.settings, trayProxyGroupStyle: 'default' })
    expect(saved.revision).not.toBe(record.revision)
    await expect(
      store.save({ ...saved.settings, trayProxyGroupStyle: 'submenu' }, record.revision)
    ).rejects.toThrow('修改')
    expect((await store.read()).settings.trayProxyGroupStyle).toBe('default')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('preserves exact old visible-group bytes, persists a hide only with current revision and refuses stale resurrection', async () => {
  const root = await mkdtemp('/private/tmp/relay-shell-groups-visible-'),
    store = new RelayShellStore({ stateRoot: root }),
    path = join(root, 'UI/shell.json')
  try {
    expect((await store.read()).settings.proxyInTray).toBe(true)
    const { proxyInTray: _missing, ...legacy } = defaultShellSettings(),
      bytes = Buffer.from(JSON.stringify(legacy, null, 2))
    await mkdir(join(root, 'UI'), { mode: 0o700 })
    await writeFile(path, bytes, { mode: 0o600 })
    const before = await stat(path),
      originalSHA = createHash('sha256').update(bytes).digest('hex')
    const record = await store.read()
    expect(record.settings.proxyInTray).toBe(true)
    expect(record.revision).toBe(originalSHA)
    await store.read()
    expect(await readFile(path)).toEqual(bytes)
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
    const saved = await store.save({ ...record.settings, proxyInTray: false }, record.revision)
    expect((await store.read()).settings.proxyInTray).toBe(false)
    await expect(
      store.save({ ...saved.settings, proxyInTray: true }, record.revision)
    ).rejects.toThrow('修改')
    expect((await store.read()).revision).toBe(saved.revision)
    await store.save({ ...saved.settings, proxyInTray: true }, saved.revision)
    expect((await store.read()).settings.proxyInTray).toBe(true)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
