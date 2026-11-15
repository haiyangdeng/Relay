import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validatePreferenceSnapshot, validateRecoveryStatus } from '../../shared/relay/protocol'
import {
  previewNative,
  simulateNative,
  edgeProfileNative,
  diagnoseNative,
  guardPlanNative,
  readPreferencesNative,
  savePreferencesNative,
  recoveryStatusNative,
  recoveryPreflightNative,
  recoveryRestoreNative,
  prepareCodeNative,
  applyCodeNative,
  desktopReadinessNative,
  inspectEdgeNative,
  openEdgeToolNative,
  guardReadinessNative
} from './native'
import { readOnlyFixture } from './__fixtures__/read-only'
import { preferenceFixture } from './__fixtures__/preferences'
import { recoveryFixture, preflightFixture } from './__fixtures__/recovery'
import { codeFixture, appliedCodeFixture } from './__fixtures__/code'
import { desktopReadinessFixture } from './__fixtures__/desktop-readiness'
import { edgeFixture } from './__fixtures__/edge'
import { guardReadinessFixture } from './__fixtures__/guard'

const mock = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: mock.execFile }))
const input = { httpPort: 7890, node: 'fixture', existingJSON: '{}', internalExceptions: '' }
const preview = {
  settingsJSON: '{}',
  noProxy: 'localhost',
  plan: 'plan',
  rules: 'rules: []',
  dns: 'dns: {}',
  listeners: 'listeners: []',
  warnings: []
}

beforeEach(() => {
  mock.execFile.mockReset()
})
afterEach(() => {
  expect(mock.execFile.mock.calls.map((args) => [args[0], args.length, typeof args[3]])).toEqual(
    mock.execFile.mock.calls.map(() => ['/fixture/RelayNative', 4, 'function'])
  )
})

describe('Fixed native command bridge', () => {
  it('uses only the guard status command and refuses a runtime protection claim', async () => {
    const end = vi.fn()
    let result: unknown = guardReadinessFixture()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(result)))
      return { stdin: { end, on: vi.fn() } }
    })
    expect(await guardReadinessNative('/fixture/RelayNative')).toEqual(result)
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--guard-status'])
    expect(end).toHaveBeenCalledWith(undefined)
    result = { ...guardReadinessFixture(), protectionVerified: true }
    await expect(guardReadinessNative('/fixture/RelayNative')).rejects.toThrow('不能声明')
  })
  it('uses only the fixed Edge operation and keeps context and revision on stdin', async () => {
    const end = vi.fn(),
      context = {
        home: '/fixture',
        stateRoot: '/fixture/Library/Application Support/Relay-Preview'
      }
    let result: unknown = edgeFixture()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(result)))
      return { stdin: { end, on: vi.fn() } }
    })
    expect(await inspectEdgeNative('/fixture/RelayNative', context)).toEqual(edgeFixture())
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--edge-tools'])
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({ action: 'inspect', context })
    result = { status: 'requested', action: 'openProfile', installed: false, warnings: [] }
    await openEdgeToolNative('/fixture/RelayNative', 'openProfile', context, 'a'.repeat(64))
    expect(JSON.parse(end.mock.calls[1][0])).toEqual({
      action: 'openProfile',
      context,
      expectedRevision: 'a'.repeat(64)
    })
    expect(() =>
      openEdgeToolNative('/fixture/RelayNative', 'openProfile', context, '../escape')
    ).toThrow()
    expect(() =>
      openEdgeToolNative('/fixture/RelayNative', 'edgePolicy', context, 'a'.repeat(64))
    ).toThrow()
    result = { status: 'requested', action: 'deviceManagement', installed: false, warnings: [] }
    await expect(openEdgeToolNative('/fixture/RelayNative', 'edgePolicy', context)).rejects.toThrow(
      '不一致'
    )
  })
  it('uses one fixed desktop inspection operation and rejects permission claims', async () => {
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(desktopReadinessFixture())))
      return { stdin: { end, on: vi.fn() } }
    })
    const context = {
      home: '/fixture/home',
      stateRoot: '/fixture/home/Library/Application Support/Relay-Preview'
    }
    expect(await desktopReadinessNative('/fixture/RelayNative', context)).toEqual(
      desktopReadinessFixture()
    )
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--desktop-readiness'])
    expect(JSON.parse(end.mock.calls[0][0])).toEqual(context)
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() =>
        done(null, JSON.stringify({ ...desktopReadinessFixture(), startEnabled: true }))
      )
      return { stdin: { end, on: vi.fn() } }
    })
    await expect(desktopReadinessNative('/fixture/RelayNative', context)).rejects.toThrow('权限')
  })
  it('prepares and applies through fixed operations without forwarding paths from renderer data', async () => {
    const end = vi.fn(),
      settings = preferenceFixture().preferences
    mock.execFile.mockImplementation((_path, args, _options, done) => {
      queueMicrotask(() =>
        done(
          null,
          JSON.stringify(args[0] === '--code-prepare' ? codeFixture() : appliedCodeFixture())
        )
      )
      return { stdin: { end, on: vi.fn() } }
    })
    const context = {
      home: '/fixture/home',
      stateRoot: '/fixture/home/Library/Application Support/Relay-Preview',
      browserExecutable: '/fixture/RelayBrowser'
    }
    const report = await prepareCodeNative('/fixture/RelayNative', settings, context)
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--code-prepare'])
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({ context, settings })
    expect(
      (await applyCodeNative('/fixture/RelayNative', settings, report.revision, context)).status
    ).toBe('applied')
    expect(mock.execFile.mock.calls[1][1]).toEqual(['--code-apply'])
    expect(JSON.parse(end.mock.calls[1][0])).toEqual({
      context,
      settings,
      expectedRevision: report.revision
    })
    expect(() =>
      prepareCodeNative('/fixture/RelayNative', { ...settings, existingJSON: 'private' }, context)
    ).toThrow()
    expect(() => applyCodeNative('/fixture/RelayNative', settings, 'bad', context)).toThrow()
  })
  it('restores with main-owned proof fields only and rejects a noncommitted response', async () => {
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify({ status: 'restored', warnings: [] })))
      return { stdin: { end, on: vi.fn() } }
    })
    const context = {
      home: '/fixture/home',
      stateRoot: '/fixture/home/Library/Application Support/Relay-Preview'
    }
    const proof = preflightFixture()
    expect(
      (
        await recoveryRestoreNative(
          '/fixture/RelayNative',
          proof.selection,
          proof.revision,
          false,
          context
        )
      ).status
    ).toBe('restored')
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--recovery-restore'])
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({
      context,
      selection: proof.selection,
      expectedRevision: proof.revision,
      allowLegacy: false
    })
    expect(() =>
      recoveryRestoreNative('/fixture/RelayNative', proof.selection, 'bad', true, context)
    ).toThrow()
    mock.execFile.mockImplementationOnce((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify({ status: 'cancelled', warnings: [] })))
      return { stdin: { end, on: vi.fn() } }
    })
    await expect(
      recoveryRestoreNative('/fixture/RelayNative', proof.selection, proof.revision, false, context)
    ).rejects.toThrow('未确认')
  })
  it('uses a fixed read-only preflight command and verifies the selected record on return', async () => {
    const end = vi.fn()
    const selection = preflightFixture().selection
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(preflightFixture())))
      return { stdin: { end, on: vi.fn() } }
    })
    const context = {
      home: '/fixture/home',
      stateRoot: '/fixture/home/Library/Application Support/Relay-Preview'
    }
    expect(await recoveryPreflightNative('/fixture/RelayNative', selection, context)).toEqual(
      preflightFixture()
    )
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--recovery-preflight'])
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({ context, selection })
    expect(() =>
      recoveryPreflightNative('/fixture/RelayNative', { ...selection, path: '/injected' }, context)
    ).toThrow()
    const wrong = preflightFixture()
    wrong.selection.id = 'another-record'
    mock.execFile.mockImplementationOnce((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(wrong)))
      return { stdin: { end, on: vi.fn() } }
    })
    await expect(
      recoveryPreflightNative('/fixture/RelayNative', selection, context)
    ).rejects.toThrow('其他记录')
  })
  it('uses a fixed recovery read command and rejects malformed or misleading metadata', async () => {
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(recoveryFixture())))
      return { stdin: { end, on: vi.fn() } }
    })
    const context = {
      home: '/fixture/home',
      stateRoot: '/fixture/home/Library/Application Support/Relay-Preview'
    }
    expect(await recoveryStatusNative('/fixture/RelayNative', context)).toEqual(recoveryFixture())
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--recovery-status'])
    expect(JSON.parse(end.mock.calls[0][0])).toEqual(context)
    expect(() => validateRecoveryStatus({ ...recoveryFixture(), restoreEnabled: 'yes' })).toThrow()
    const incomplete = recoveryFixture()
    incomplete.inventories[0].entries[0].phase = 'unreadable'
    incomplete.inventories[0].entries[0].version = 0
    expect(() => validateRecoveryStatus(incomplete)).toThrow('完整性')
    incomplete.inventories[0].complete = false
    expect(validateRecoveryStatus(incomplete).inventories[0].complete).toBe(false)
    const duplicate = recoveryFixture()
    duplicate.inventories[1].source = 'relay'
    expect(() => validateRecoveryStatus(duplicate)).toThrow('来源重复')
  })
  it('uses one fixed preference command with separate read/save actions on stdin', async () => {
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(preferenceFixture())))
      return { stdin: { end, on: vi.fn() } }
    })
    const context = {
      home: '/fixture/home',
      stateRoot: '/fixture/home/Library/Application Support/Relay-Preview'
    }
    expect(await readPreferencesNative('/fixture/RelayNative', context)).toEqual(
      preferenceFixture()
    )
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({ action: 'read', context })
    const request = {
      preferences: preferenceFixture().preferences,
      revision: preferenceFixture().revision
    }
    mock.execFile.mockImplementationOnce((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify({ ...preferenceFixture(), source: 'relay' })))
      return { stdin: { end, on: vi.fn() } }
    })
    await savePreferencesNative('/fixture/RelayNative', request, context)
    expect(
      mock.execFile.mock.calls.every((call) => JSON.stringify(call[1]) === '["--preferences"]')
    ).toBe(true)
    expect(JSON.parse(end.mock.calls[1][0])).toEqual({ action: 'save', context, ...request })
    const before = mock.execFile.mock.calls.length
    for (const raw of [
      { ...request, context: { home: '/injected' } },
      { ...request, revision: '' },
      { ...request, preferences: { ...request.preferences, existingJSON: 'private' } }
    ]) {
      expect(() => savePreferencesNative('/fixture/RelayNative', raw, context)).toThrow()
    }
    expect(mock.execFile).toHaveBeenCalledTimes(before)
    expect(() =>
      validatePreferenceSnapshot({ ...preferenceFixture(), source: 'unknown' })
    ).toThrow()
    expect(() => validatePreferenceSnapshot({ ...preferenceFixture(), revision: 'bad' })).toThrow()
    await expect(savePreferencesNative('/fixture/RelayNative', request, context)).rejects.toThrow(
      '保存结果与请求不一致'
    )
    mock.execFile.mockImplementationOnce((_path, _args, _options, done) => {
      queueMicrotask(() =>
        done(
          null,
          JSON.stringify({
            ...preferenceFixture(),
            source: 'relay',
            preferences: { ...request.preferences, httpPort: 8888 }
          })
        )
      )
      return { stdin: { end, on: vi.fn() } }
    })
    await expect(savePreferencesNative('/fixture/RelayNative', request, context)).rejects.toThrow(
      '保存结果与请求不一致'
    )
  })
  it('generates Edge XML without forwarding paths, ports or an install command', async () => {
    const profile = { profileXML: '<?xml?><plist/>', installed: false, warnings: ['未安装'] }
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(profile)))
      return { stdin: { end, on: vi.fn() } }
    })
    expect(await edgeProfileNative('/fixture/RelayNative')).toEqual(profile)
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--edge-profile'])
    expect(end).toHaveBeenCalledWith(undefined)
  })
  it('keeps diagnostic context in stdin under the fixed read-only operation', async () => {
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(readOnlyFixture())))
      return { stdin: { end, on: vi.fn() } }
    })
    const context = {
      home: '/fixture/home',
      clashRoot: '/fixture/clash',
      browserProfile: '/fixture/browser',
      browserExecutable: '/fixture/RelayBrowser'
    }
    const settings = { httpPort: 7890, node: 'fixture-node', internalExceptions: '' }
    expect(await diagnoseNative('/fixture/RelayNative', settings, context)).toEqual(
      readOnlyFixture()
    )
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--diagnose'])
    expect(mock.execFile.mock.calls[0][2].timeout).toBe(30000)
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({ settings, context })
    expect(() =>
      diagnoseNative('/fixture/RelayNative', { ...settings, path: '/injected' }, context)
    ).toThrow()
  })
  it('requires owned native metadata without relaxing the legacy runtime-claim validator', async () => {
    const report = readOnlyFixture()
    report.owned = {
      appVersion: '1.0.0',
      appBuild: '7',
      browsers: [{ bundleId: 'com.google.Chrome', version: '100.0', profile: 'relay-private' }]
    }
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(report)))
      return { stdin: { end, on: vi.fn() } }
    })
    const context = {
      home: '/fixture/home',
      clashRoot: '/unused-legacy',
      browserProfile: '/fixture/browser',
      browserExecutable: '/fixture/RelayBrowser',
      owned: {
        systemHTTPPort: 18191,
        systemSOCKSPort: 18191,
        codeHTTPPort: 17891,
        dedicatedSOCKSPort: 17890
      }
    }
    const settings = { httpPort: 17891, node: 'Relay 当前实例', internalExceptions: '' }
    expect((await diagnoseNative('/fixture/RelayNative', settings, context)).owned).toEqual(
      report.owned
    )
    const webrtc = report.checks.find((row) => row.id === 'webrtc')
    if (!webrtc) throw new Error('Missing WebRTC fixture')
    webrtc.state = 'verifiedConfiguration'
    await expect(diagnoseNative('/fixture/RelayNative', settings, context)).rejects.toThrow(
      '状态无效'
    )
    webrtc.state = 'pending'
    delete report.owned
    await expect(diagnoseNative('/fixture/RelayNative', settings, context)).rejects.toThrow()
  })
  it('passes the trusted core metadata to a text-only guard plan operation', async () => {
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() =>
        done(null, JSON.stringify({ plan: 'fixture plan', warnings: ['未部署'] }))
      )
      return { stdin: { end, on: vi.fn() } }
    })
    await guardPlanNative('/fixture/RelayNative', 'fixture-node', { 'fixture-node': 'Shadowsocks' })
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--guard-plan'])
    expect(JSON.parse(end.mock.calls[0][0])).toEqual({
      node: 'fixture-node',
      proxyTypes: { 'fixture-node': 'Shadowsocks' }
    })
  })
  it('sends structured input on stdin, uses a fixed executable/operation and validates output', async () => {
    const end = vi.fn()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, JSON.stringify(preview)))
      return { stdin: { end, on: vi.fn() } }
    })
    expect(await previewNative('/fixture/RelayNative', input)).toEqual(preview)
    expect(mock.execFile).toHaveBeenCalledWith(
      '/fixture/RelayNative',
      ['--preview'],
      { timeout: 10000, maxBuffer: 2 * 1024 * 1024 },
      expect.any(Function)
    )
    expect(JSON.parse(end.mock.calls[0][0])).toEqual(input)
  })
  it('refuses malformed input before spawning and never forwards stderr credentials', async () => {
    expect(() => previewNative('/fixture/RelayNative', { ...input, httpPort: 17890 })).toThrow()
    expect(mock.execFile).not.toHaveBeenCalled()
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(new Error('secret in error'), '', 'secret in stderr'))
      return { stdin: { end: vi.fn(), on: vi.fn() } }
    })
    await expect(previewNative('/fixture/RelayNative', input)).rejects.toThrow(
      '原生生成未完成，请检查输入；没有应用配置。'
    )
  })
  it('rejects truncated and wrong-shape native results', async () => {
    for (const stdout of ['{', '{}', JSON.stringify({ ...preview, rules: [] })]) {
      mock.execFile.mockImplementation((_path, _args, _options, done) => {
        queueMicrotask(() => done(null, stdout))
        return { stdin: { end: vi.fn(), on: vi.fn() } }
      })
      await expect(previewNative('/fixture/RelayNative', input)).rejects.toThrow()
    }
  })
  it('runs only the fixed simulation command and refuses a protected=true result', async () => {
    mock.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null, '{"protected":true,"rows":[]}'))
      return { stdin: { end: vi.fn(), on: vi.fn() } }
    })
    await expect(simulateNative('/fixture/RelayNative')).rejects.toThrow('格式异常')
    expect(mock.execFile.mock.calls[0][1]).toEqual(['--simulate'])
  })
  it('handles a closed input pipe without an unhandled process error', async () => {
    const stdin = new EventEmitter() as EventEmitter & { end: () => void }
    stdin.end = () => {
      queueMicrotask(() => stdin.emit('error', new Error('EPIPE secret')))
    }
    mock.execFile.mockReturnValue({ stdin })
    await expect(previewNative('/fixture/RelayNative', input)).rejects.toThrow('输入通道已关闭')
  })
})
