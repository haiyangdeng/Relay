import { describe, expect, it } from 'vitest'
import {
  defaultShellSettings,
  shellAction,
  shellAccelerator,
  shellSettings,
  shellCSS,
  shellThemeLibrary,
  shellProxyEnvironment
} from './shell'

describe('Relay desktop settings boundary', () => {
  it('reads older preferences with an empty theme library and returns independent library records', () => {
    const { themes: _missing, ...legacy } = defaultShellSettings()
    expect(shellSettings(legacy).themes).toEqual([])
    const theme = {
      id: '00000000-0000-4000-8000-000000000038',
      name: 'Ocean',
      css: 'body{color:blue}'
    }
    const parsed = shellThemeLibrary([theme])
    theme.css = 'changed'
    expect(parsed[0].css).toBe('body{color:blue}')
    expect(() => shellSettings({ ...legacy, themes: undefined })).toThrow()
  })
  it('enforces unique IDs/names, field shape, per-theme and total CSS budgets', () => {
    const base = { id: '00000000-0000-4000-8000-000000000038', name: 'Ocean', css: '' }
    for (const value of [
      null,
      {},
      [base, base],
      [{ ...base, name: 'bad\nname' }],
      [{ ...base, id: '../escape' }],
      [{ ...base, script: 'code' }],
      [{ ...base, css: 'a'.repeat(8193) }],
      [base, { ...base, id: '00000000-0000-4000-8000-000000000039', name: 'oCeAn' }]
    ])
      expect(() => shellThemeLibrary(value)).toThrow()
    const themes = Array.from({ length: 16 }, (_, index) => ({
      ...base,
      id: '00000000-0000-4000-8000-' + index.toString(16).padStart(12, '0'),
      name: 'Theme ' + index
    }))
    expect(shellThemeLibrary(themes)).toHaveLength(16)
    expect(() => shellThemeLibrary([...themes, { ...base }])).toThrow('16')
    expect(() =>
      shellThemeLibrary(themes.slice(0, 5).map((theme) => ({ ...theme, css: 'a'.repeat(8192) })))
    ).toThrow('32KiB')
    expect(
      shellThemeLibrary(themes.slice(0, 4).map((theme) => ({ ...theme, css: 'a'.repeat(8192) })))
    ).toHaveLength(4)
  })
  it('reads legacy records with a visible Dock without relaxing other field checks', () => {
    const { showDockIcon: _legacyMissing, ...legacy } = defaultShellSettings()
    expect(shellSettings(legacy).showDockIcon).toBe(true)
    expect(shellSettings({ ...legacy, showDockIcon: false }).showDockIcon).toBe(false)
    for (const value of [undefined, null, 'false', 0])
      expect(() => shellSettings({ ...legacy, showDockIcon: value })).toThrow('Dock')
    const { silentStart: _missing, ...incomplete } = legacy
    expect(() => shellSettings(incomplete)).toThrow('字段')
  })
  it('keeps custom CSS opt-in, byte bounded and strict while accepting both generations of old records', () => {
    const { customCSS: _css, showDockIcon: _dock, ...old } = defaultShellSettings()
    expect(shellSettings(old)).toMatchObject({ customCSS: '', showDockIcon: true })
    expect(shellSettings({ ...old, showDockIcon: false })).toMatchObject({
      customCSS: '',
      showDockIcon: false
    })
    expect(shellCSS('a'.repeat(8192))).toHaveLength(8192)
    for (const value of ['a'.repeat(8193), '中'.repeat(3000), 'a\0b', undefined, null, {}])
      expect(() => shellCSS(value)).toThrow('8KiB')
    expect(() => shellSettings({ ...old, customCSS: undefined })).toThrow('8KiB')
    expect(() => shellSettings({ ...old, arbitraryThemeScript: 'code' })).toThrow('字段')
  })
  it('normalizes modifier aliases and accepts an unset shortcut', () => {
    expect(shellAccelerator('shift+cmdorctrl+r')).toBe('CommandOrControl+Shift+R')
    expect(shellAccelerator('')).toBe('')
    expect(shellSettings(defaultShellSettings()).silentStart).toBe(false)
  })
  it('refuses duplicate bindings after normalization and unknown settings', () => {
    const value = defaultShellSettings()
    value.shortcuts.showWindow = 'Cmd+Shift+R'
    value.shortcuts.showFloatingWindow = 'Shift+Command+r'
    expect(() => shellSettings(value)).toThrow('同一个')
    expect(() => shellSettings({ ...defaultShellSettings(), tun: true })).toThrow('字段')
    expect(() => shellSettings({ ...defaultShellSettings(), appTheme: ['light'] })).toThrow('主题')
  })
  it('rejects free text shortcuts, repeated modifiers and unsupported lifecycle actions', () => {
    for (const value of ['R', 'Control+Control+R', 'Control+/', 'Control+', 'arbitrary'])
      expect(() => shellAccelerator(value)).toThrow()
    for (const action of ['restartCore', 'quitWithoutCore'])
      expect(() => shellAction(action)).toThrow('未支持')
    expect(shellAction('quitApp')).toBe('quitApp')
  })
})

describe('Confirmed network shortcut model proposal', () => {
  it('reads the seven-action generation without rewriting or inventing a binding', () => {
    const settings = defaultShellSettings()
    const {
      triggerSysProxy: _proxy,
      triggerTun: _tun,
      runInBackground: _background,
      restartApp: _restart,
      ...old
    } = settings.shortcuts
    const legacy = { ...settings, shortcuts: old }
    const before = JSON.stringify(legacy)
    const parsed = shellSettings(legacy)
    expect(parsed.shortcuts.triggerSysProxy).toBe('')
    expect(parsed.shortcuts.triggerTun).toBe('')
    expect(JSON.stringify(legacy)).toBe(before)
  })
  it('requires all seven old actions while allowing either new action to be omitted', () => {
    const settings = defaultShellSettings()
    const { triggerTun: _tun, runInBackground: _background, ...oneMissing } = settings.shortcuts
    expect(shellSettings({ ...settings, shortcuts: oneMissing }).shortcuts.triggerTun).toBe('')
    const { showWindow: _window, ...invalid } = oneMissing
    expect(() => shellSettings({ ...settings, shortcuts: invalid })).toThrow('不完整')
  })
  it('keeps present network bindings strict and part of duplicate detection', () => {
    const settings = defaultShellSettings()
    for (const bad of [undefined, null, false, 3])
      expect(() =>
        shellSettings({ ...settings, shortcuts: { ...settings.shortcuts, triggerTun: bad } })
      ).toThrow()
    settings.shortcuts.showWindow = 'Cmd+R'
    settings.shortcuts.triggerSysProxy = 'Command+R'
    expect(() => shellSettings(settings)).toThrow('同一个')
    expect(() =>
      shellSettings({
        ...defaultShellSettings(),
        shortcuts: { ...defaultShellSettings().shortcuts, arbitraryNetworkAction: '' }
      })
    ).toThrow('无效')
  })
  it('recognizes the fixed takeover intents and rejects unsupported Core lifecycle actions', () => {
    expect(shellAction('triggerSysProxy')).toBe('triggerSysProxy')
    expect(shellAction('triggerTun')).toBe('triggerTun')
    for (const raw of ['quitWithoutCore', 'restartCore'])
      expect(() => shellAction(raw)).toThrow('未支持')
  })
})

describe('Background shortcut backwards compatibility', () => {
  it('reads a nine-action record without creating a new binding or changing its bytes', () => {
    const value = defaultShellSettings()
    const { runInBackground: _background, restartApp: _restart, ...shortcuts } = value.shortcuts
    const previous = { ...value, shortcuts }
    const bytes = JSON.stringify(previous)
    expect(shellSettings(previous).shortcuts.runInBackground).toBe('')
    expect(JSON.stringify(previous)).toBe(bytes)
    expect(shellAction('runInBackground')).toBe('runInBackground')
  })
  it('validates the new binding and rejects collision with an existing action', () => {
    const value = defaultShellSettings()
    value.shortcuts.runInBackground = 'Cmd+Shift+B'
    expect(shellSettings(value).shortcuts.runInBackground).toBe('Command+Shift+B')
    value.shortcuts.showWindow = 'Command+Shift+B'
    expect(() => shellSettings(value)).toThrow('同一个快捷键')
    expect(() =>
      shellSettings({
        ...defaultShellSettings(),
        shortcuts: { ...defaultShellSettings().shortcuts, runInBackground: null }
      })
    ).toThrow('格式无效')
  })
})

describe('Explicit environment format preferences', () => {
  it('reads missing new fields without changing old input and rejects explicit invalid values', () => {
    const { environmentFormat: _format, swapTrayClick: _swap, ...legacy } = defaultShellSettings()
    const bytes = JSON.stringify(legacy)
    expect(shellSettings(legacy)).toMatchObject({
      environmentFormat: 'default',
      swapTrayClick: false
    })
    expect(JSON.stringify(legacy)).toBe(bytes)
    for (const bad of [undefined, null, false, '', 'zsh', {}])
      expect(() => shellSettings({ ...legacy, environmentFormat: bad })).toThrow('格式')
    for (const bad of [undefined, null, 0, 'false'])
      expect(() => shellSettings({ ...legacy, swapTrayClick: bad })).toThrow('开关')
  })
  it('matches the five fixed upstream formats and retains the original default NO_PROXY', () => {
    const proxy = 'http://127.0.0.1:18191'
    expect(shellProxyEnvironment(18191, 'default')).toBe(
      `export HTTP_PROXY=${proxy}\nexport HTTPS_PROXY=${proxy}\nexport ALL_PROXY=${proxy}\nexport NO_PROXY=localhost,127.0.0.1,::1`
    )
    expect(shellProxyEnvironment(18191, 'bash')).toBe(
      `export https_proxy=${proxy} http_proxy=${proxy} all_proxy=${proxy}`
    )
    expect(shellProxyEnvironment(18191, 'cmd')).toBe(
      `set http_proxy=${proxy}\r\nset https_proxy=${proxy}`
    )
    expect(shellProxyEnvironment(18191, 'powershell')).toBe(
      `$env:HTTP_PROXY="${proxy}"; $env:HTTPS_PROXY="${proxy}"`
    )
    expect(shellProxyEnvironment(18191, 'fish')).toBe(
      `set -x http_proxy ${proxy}; set -x https_proxy ${proxy}; set -x all_proxy ${proxy}`
    )
    expect(shellProxyEnvironment(18191, 'nushell')).toBe(
      `$env.HTTP_PROXY = "${proxy}"; $env.HTTPS_PROXY = "${proxy}"; $env.ALL_PROXY = "${proxy}"`
    )
    for (const port of [0, 80, 1023, 65536, -1, 18191.5, NaN, Infinity])
      expect(() => shellProxyEnvironment(port, 'bash')).toThrow('端口')
  })
})

describe('Restart shortcut compatibility', () => {
  it('reads old ten-action records without writing a default binding', () => {
    const value = defaultShellSettings()
    const { restartApp: _missing, ...shortcuts } = value.shortcuts
    const legacy = { ...value, shortcuts },
      bytes = JSON.stringify(legacy)
    expect(shellSettings(legacy).shortcuts.restartApp).toBe('')
    expect(JSON.stringify(legacy)).toBe(bytes)
    expect(shellAction('restartApp')).toBe('restartApp')
    expect(() =>
      shellSettings({ ...legacy, shortcuts: { ...shortcuts, restartApp: undefined } })
    ).toThrow()
  })
})

describe('Optional current proxy name in tray group labels', () => {
  it('defaults missing legacy records to false without mutating the supplied record', () => {
    const { showCurrentProxyInTray: _missing, ...legacy } = defaultShellSettings()
    const bytes = JSON.stringify(legacy)
    expect(shellSettings(legacy).showCurrentProxyInTray).toBe(false)
    expect(JSON.stringify(legacy)).toBe(bytes)
    for (const value of [false, true])
      expect(
        shellSettings({ ...legacy, showCurrentProxyInTray: value }).showCurrentProxyInTray
      ).toBe(value)
    for (const value of [undefined, null, 0, 1, 'true', []])
      expect(() => shellSettings({ ...legacy, showCurrentProxyInTray: value })).toThrow('布尔')
  })
})

describe('Tray group layout compatibility', () => {
  it('uses the fixed upstream default for fresh settings and preserves old collapsed records without mutating them', () => {
    expect(defaultShellSettings().trayProxyGroupStyle).toBe('default')
    const { trayProxyGroupStyle: _missing, ...legacy } = defaultShellSettings()
    const bytes = JSON.stringify(legacy)
    expect(shellSettings(legacy).trayProxyGroupStyle).toBe('submenu')
    expect(JSON.stringify(legacy)).toBe(bytes)
    for (const style of ['default', 'submenu'] as const)
      expect(shellSettings({ ...legacy, trayProxyGroupStyle: style }).trayProxyGroupStyle).toBe(
        style
      )
  })
  it.each([null, undefined, true, 0, ['default'], { value: 'submenu' }, '', 'flat'])(
    'rejects an explicit non-enum layout %j',
    (trayProxyGroupStyle) => {
      expect(() => shellSettings({ ...defaultShellSettings(), trayProxyGroupStyle })).toThrow(
        '布局'
      )
    }
  )
})

describe('Tray group visibility preference', () => {
  it('keeps groups visible for both fresh and byte-compatible old preferences', () => {
    expect(defaultShellSettings().proxyInTray).toBe(true)
    const { proxyInTray: _missing, ...legacy } = defaultShellSettings()
    const original = JSON.stringify(legacy)
    expect(shellSettings(legacy).proxyInTray).toBe(true)
    expect(JSON.stringify(legacy)).toBe(original)
    expect(shellSettings({ ...legacy, proxyInTray: false }).proxyInTray).toBe(false)
    expect(shellSettings({ ...legacy, proxyInTray: true }).proxyInTray).toBe(true)
  })
  it.each([undefined, null, 0, 1, 'false', 'true', [], {}])(
    'rejects explicit nonboolean visibility %s',
    (proxyInTray) => {
      expect(() => shellSettings({ ...defaultShellSettings(), proxyInTray })).toThrow('布尔')
    }
  )
})
