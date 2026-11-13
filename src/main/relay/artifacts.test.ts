import { mkdtemp, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  validateGenerateRequest,
  validatePreviewOutput,
  validateSimulationOutput,
  type RelayPreviewOutput,
  type RelaySimulationOutput,
  type RelayPreferences
} from '../../shared/relay/protocol'
import { atomicWriteFile } from '../utils/safeFile'
import { createArtifactService } from './artifacts'
import { relayRuntimeContext } from './context'
import { preferenceFixture } from './__fixtures__/preferences'

const input = { httpPort: 7890, node: 'fixture', existingJSON: '{}', internalExceptions: '' }
const configuration: RelayPreviewOutput = {
  settingsJSON: '{"env":{"CUSTOM":"secret-kept-in-draft"}}',
  noProxy: 'localhost',
  plan: 'fixture plan',
  rules: 'rules: []',
  dns: 'dns: {}',
  listeners: 'listeners: []',
  warnings: ['未应用配置']
}
const simulation: RelaySimulationOutput = {
  rows: Array.from({ length: 10 }, (_, i) => ({
    name: `fixture ${i}`,
    expected: 'drop',
    actual: 'drop',
    passed: true
  })),
  protected: false,
  warnings: ['只模拟策略函数，不代表实际网络受保护']
}
function fixture() {
  const adapters = {
    configuration: vi.fn(async () => structuredClone(configuration)),
    simulation: vi.fn(async () => structuredClone(simulation)),
    edgeProfile: vi.fn(async () => ({
      profileXML: '<?xml?><plist/>',
      installed: false as const,
      warnings: ['未安装']
    })),
    guardPlan: vi.fn(async (_node: string, _evidenceId: string) => ({
      plan: 'fixture guard plan',
      warnings: ['未部署']
    })),
    handoff: vi.fn(async () => '# reference\n```sh\nnever execute this\n```'),
    readPreferences: vi.fn(async () => preferenceFixture()),
    savePreferences: vi.fn(async (preferences: RelayPreferences, _revision: string) => ({
      ...preferenceFixture(),
      preferences,
      source: 'relay' as const,
      revision: 'b'.repeat(64)
    })),
    copy: vi.fn(),
    chooseSave: vi.fn(async (_filename: string): Promise<string | undefined> => undefined),
    write: vi.fn(async (_destination: string, _content: string) => {})
  }
  return { service: createArtifactService(adapters), adapters }
}

describe('Scoped draft generation and export', () => {
  it('remembers only the generated full-plan parameters after a successful export', async () => {
    const { service, adapters } = fixture()
    const generated = await service.generate({
      kind: 'configuration',
      input: { ...input, existingJSON: '{"secret":"not-a-preference"}' }
    })
    expect(adapters.savePreferences).not.toHaveBeenCalled()
    await service.action({ id: generated.artifacts[1].id, action: 'copy' })
    await service.action({ id: generated.artifacts[1].id, action: 'save' })
    expect(adapters.savePreferences).not.toHaveBeenCalled()
    adapters.chooseSave.mockResolvedValue('/fake/full-plan.md')
    await service.action({ id: generated.artifacts[0].id, action: 'save' })
    expect(adapters.savePreferences).not.toHaveBeenCalled()
    const saved = await service.action({ id: generated.artifacts[1].id, action: 'save' })
    expect(saved.preferenceSnapshot?.source).toBe('relay')
    expect(adapters.savePreferences).toHaveBeenCalledWith(
      { httpPort: 7890, node: 'fixture', internalExceptions: '' },
      'a'.repeat(64)
    )
    await service.action({ id: generated.artifacts[1].id, action: 'save' })
    expect(adapters.savePreferences).toHaveBeenLastCalledWith(
      { httpPort: 7890, node: 'fixture', internalExceptions: '' },
      'b'.repeat(64)
    )
  })
  it('reports exported text separately from an unconfirmed preference save', async () => {
    const { service, adapters } = fixture()
    const generated = await service.generate({ kind: 'configuration', input })
    adapters.chooseSave.mockResolvedValue('/fake/selected.md')
    adapters.savePreferences.mockRejectedValueOnce(new Error('private state error'))
    const result = await service.action({ id: generated.artifacts[1].id, action: 'save' })
    expect(result.status).toBe('saved')
    expect(result.warning).toContain('文本已导出')
    expect(result.warning).toContain('未确认')
    expect(result.warning).not.toContain('private state error')
    expect(result.preferenceSnapshot).toBeUndefined()
    expect(adapters.write).toHaveBeenCalledTimes(1)
  })
  it('preserves pure generation/export when preferences cannot be read, and never saves after file failure', async () => {
    const { service, adapters } = fixture()
    adapters.readPreferences.mockRejectedValueOnce(new Error('fixture corrupt preferences'))
    const result = await service.generate({ kind: 'configuration', input })
    expect(result.artifacts).toHaveLength(5)
    expect(result.warnings.join('')).toContain('不会记住参数')
    adapters.chooseSave.mockResolvedValue('/fake/selected.md')
    await service.action({ id: result.artifacts[1].id, action: 'save' })
    expect(adapters.savePreferences).not.toHaveBeenCalled()
    const valid = await service.generate({ kind: 'configuration', input })
    adapters.write.mockRejectedValueOnce(new Error('fixture disk full'))
    await expect(service.action({ id: valid.artifacts[1].id, action: 'save' })).rejects.toThrow(
      '导出未完成'
    )
    expect(adapters.savePreferences).not.toHaveBeenCalled()
  })
  it('generates Edge XML and verified guard plans as export-only artifacts', async () => {
    const { service, adapters } = fixture()
    const profile = await service.generate({ kind: 'edgeProfile' })
    expect(profile.artifacts[0].filename).toBe('Claude-Edge-Network.mobileconfig')
    expect(profile.warnings).toContain('未安装')
    await expect(service.generate({ kind: 'edgeProfile', port: 1234 })).rejects.toThrow()
    const evidenceId = '00000000-0000-4000-8000-000000000001'
    const plan = await service.generate({ kind: 'guardPlan', node: 'fixture-node', evidenceId })
    expect(adapters.guardPlan).toHaveBeenCalledWith('fixture-node', evidenceId)
    expect(plan.artifacts[0].content).toBe('fixture guard plan')
    await expect(
      service.generate({
        kind: 'guardPlan',
        node: 'fixture-node',
        evidenceId,
        proxyTypes: { 'fixture-node': 'Shadowsocks' }
      })
    ).rejects.toThrow()
    expect(adapters.chooseSave).not.toHaveBeenCalled()
    expect(adapters.write).not.toHaveBeenCalled()
  })
  it('routes validated input to the existing native merger and retains every copyable section', async () => {
    const { service, adapters } = fixture()
    const result = await service.generate({ kind: 'configuration', input })
    expect(adapters.configuration).toHaveBeenCalledWith(input)
    expect(result.artifacts.map((item) => item.content)).toEqual([
      configuration.settingsJSON,
      configuration.plan,
      configuration.rules,
      configuration.dns,
      configuration.listeners
    ])
    expect(new Set(result.artifacts.map((item) => item.id)).size).toBe(5)
    expect(adapters.copy).not.toHaveBeenCalled()
    expect(adapters.chooseSave).not.toHaveBeenCalled()
    expect(adapters.write).not.toHaveBeenCalled()
  })
  it('copies only stored text even if renderer output was changed', async () => {
    const { service, adapters } = fixture()
    const result = await service.generate({ kind: 'configuration', input })
    result.artifacts[0].content = 'renderer changed content'
    expect(await service.action({ id: result.artifacts[0].id, action: 'copy' })).toEqual({
      status: 'copied'
    })
    expect(adapters.copy).toHaveBeenCalledWith(configuration.settingsJSON)
    expect(adapters.write).not.toHaveBeenCalled()
  })
  it('cancellation writes nothing and permits the next export', async () => {
    const { service, adapters } = fixture()
    const result = await service.generate({ kind: 'configuration', input })
    const request = { id: result.artifacts[1].id, action: 'save' }
    expect(await service.action(request)).toEqual({ status: 'cancelled' })
    expect(adapters.write).not.toHaveBeenCalled()
    adapters.chooseSave.mockResolvedValue('/fake/chosen/network.md')
    expect(await service.action(request)).toMatchObject({
      status: 'saved',
      preferenceSnapshot: { source: 'relay' }
    })
    expect(adapters.chooseSave).toHaveBeenLastCalledWith('Claude-Codex-Network-Plan.md')
    expect(adapters.write).toHaveBeenCalledWith('/fake/chosen/network.md', configuration.plan)
  })
  it('rejects concurrent export dialogs and clears the lock after cancellation', async () => {
    const { service, adapters } = fixture()
    const result = await service.generate({ kind: 'configuration', input })
    let cancel!: (value: undefined) => void
    adapters.chooseSave.mockImplementationOnce(() => new Promise((resolve) => (cancel = resolve)))
    const request = { id: result.artifacts[0].id, action: 'save' }
    const pending = service.action(request)
    await expect(service.action(request)).rejects.toThrow('完成或取消')
    cancel(undefined)
    await pending
    expect(await service.action(request)).toEqual({ status: 'cancelled' })
  })
  it('sanitizes file errors and permits retry without echoing private paths', async () => {
    const { service, adapters } = fixture()
    const result = await service.generate({ kind: 'configuration', input })
    const request = { id: result.artifacts[0].id, action: 'save' }
    adapters.chooseSave.mockResolvedValue('/fake/private-secret')
    adapters.write.mockRejectedValueOnce(new Error('private-secret-do-not-log'))
    await expect(service.action(request)).rejects.toThrow('导出未完成；没有应用网络配置。')
    expect(await service.action(request)).toMatchObject({ status: 'saved' })
  })
  it('does not accept paths, arbitrary content or unknown operations from the renderer', async () => {
    const { service, adapters } = fixture()
    const result = await service.generate({ kind: 'configuration', input })
    for (const raw of [
      { id: result.artifacts[0].id, action: 'save', destination: '/fake/config' },
      { id: result.artifacts[0].id, action: 'copy', content: 'injected' },
      { id: '../secrets', action: 'copy' },
      { id: result.artifacts[0].id, action: 'apply' },
      [],
      null
    ]) {
      await expect(service.action(raw)).rejects.toThrow()
    }
    for (const raw of [
      { kind: 'apply', input },
      { kind: 'simulation', executable: '/bin/sh' },
      { kind: 'handoff', path: '/fake/file' },
      { kind: 'configuration', input: { ...input, httpPort: 17890 } }
    ]) {
      await expect(service.generate(raw)).rejects.toThrow()
    }
    expect(adapters.write).not.toHaveBeenCalled()
    expect(adapters.copy).not.toHaveBeenCalled()
    expect(adapters.chooseSave).not.toHaveBeenCalled()
    expect(adapters.simulation).not.toHaveBeenCalled()
    expect(adapters.handoff).not.toHaveBeenCalled()
  })
  it('limits retained draft data and invalidates IDs on window teardown', async () => {
    const { service } = fixture()
    const first = await service.generate({ kind: 'configuration', input })
    let last = first
    for (let i = 0; i < 7; i++) last = await service.generate({ kind: 'configuration', input })
    await expect(service.action({ id: first.artifacts[0].id, action: 'copy' })).rejects.toThrow(
      '过期'
    )
    service.clear()
    await expect(service.action({ id: last.artifacts[0].id, action: 'copy' })).rejects.toThrow(
      '过期'
    )
  })
  it('discards a draft that finishes after its context was cleared', async () => {
    const { service, adapters } = fixture()
    let finish!: (value: RelayPreviewOutput) => void
    adapters.configuration.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve))
    )
    const pending = service.generate({ kind: 'configuration', input })
    const rejected = expect(pending).rejects.toThrow('过期')
    service.clear()
    finish(configuration)
    await rejected
    const current = await service.generate({ kind: 'configuration', input })
    await expect(service.action({ id: current.artifacts[0].id, action: 'copy' })).resolves.toEqual({
      status: 'copied'
    })
  })
  it('does not write when a stale save dialog returns a destination', async () => {
    const { service, adapters } = fixture()
    const generated = await service.generate({ kind: 'configuration', input })
    let select!: (value: string) => void
    adapters.chooseSave.mockImplementationOnce(() => new Promise((resolve) => (select = resolve)))
    const pending = service.action({ id: generated.artifacts[1].id, action: 'save' })
    service.clear()
    select('/fake/chosen/network.md')
    expect(await pending).toMatchObject({
      status: 'cancelled',
      warning: expect.stringContaining('过期')
    })
    expect(adapters.write).not.toHaveBeenCalled()
    expect(adapters.savePreferences).not.toHaveBeenCalled()
  })
  it('keeps an already written export but does not save its parameters after a reset', async () => {
    const { service, adapters } = fixture()
    const generated = await service.generate({ kind: 'configuration', input })
    adapters.chooseSave.mockResolvedValue('/fake/chosen/network.md')
    let finish!: () => void
    adapters.write.mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
    const pending = service.action({ id: generated.artifacts[1].id, action: 'save' })
    await vi.waitFor(() => expect(adapters.write).toHaveBeenCalledOnce())
    service.clear()
    finish()
    expect(await pending).toMatchObject({
      status: 'saved',
      warning: expect.stringContaining('已导出')
    })
    expect(adapters.savePreferences).not.toHaveBeenCalled()
  })
  it('shows simulation as unprotected and reads bundled documents as plain text only', async () => {
    const { service, adapters } = fixture()
    const simulated = await service.generate({ kind: 'simulation' })
    expect(simulated.artifacts[0].content).toContain('当前未启用真实过滤器')
    expect(simulated.artifacts[0].content.match(/预期 drop，结果 drop/g)).toHaveLength(10)
    const reference = await service.generate({ kind: 'handoff' })
    expect(reference.artifacts[0].content).toContain('never execute this')
    expect(reference.warnings[0]).toContain('不执行文档内代码')
    expect(adapters.configuration).not.toHaveBeenCalled()
    expect(adapters.chooseSave).not.toHaveBeenCalled()
    expect(adapters.write).not.toHaveBeenCalled()
  })
})

describe('Native result contracts and runtime paths', () => {
  it('validates native results rather than trusting a JSON cast', () => {
    expect(validatePreviewOutput(configuration)).toEqual(configuration)
    expect(validateSimulationOutput(simulation)).toEqual(simulation)
    for (const invalid of [
      null,
      { ...configuration, rules: [] },
      { ...configuration, warnings: 'bad' }
    ])
      expect(() => validatePreviewOutput(invalid)).toThrow()
    for (const invalid of [
      { ...simulation, protected: true },
      { ...simulation, rows: [] },
      { ...simulation, rows: simulation.rows.map((row) => ({ ...row, passed: false })) }
    ])
      expect(() => validateSimulationOutput(invalid)).toThrow()
    expect(() => validateGenerateRequest({ kind: '__proto__' })).toThrow()
  })
  it('resolves only product-owned locations; no legacy path is adopted', () => {
    const packaged = relayRuntimeContext({
      packaged: true,
      resources: '/fake/Relay.app/Contents/Resources',
      mainDirectory: '/ignored',
      userData: '/fake/Relay-Preview'
    })
    expect(packaged).toEqual({
      nativeExecutable: '/fake/Relay.app/Contents/Resources/relay/RelayNative',
      browserExecutable:
        '/fake/Relay.app/Contents/Resources/relay/RelayBrowser.app/Contents/MacOS/RelayBrowser',
      handoffDocument: '/fake/Relay.app/Contents/Resources/relay/docs/AI-Network-Handoff.md',
      stateDirectory: '/fake/Relay-Preview'
    })
    expect(
      relayRuntimeContext({
        packaged: false,
        resources: '/ignored',
        mainDirectory: '/fake/app/out/main',
        userData: '/fake/state'
      }).nativeExecutable
    ).toBe('/fake/app/extra/relay/RelayNative')
  })
})

describe('Selected text export with the actual atomic file writer', () => {
  const directories: string[] = []
  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
  })
  it('writes only the selected draft with private mode inside a temporary directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-export-fixture-'))
    directories.push(directory)
    const destination = join(directory, 'selected.md')
    const { adapters } = fixture()
    adapters.chooseSave.mockResolvedValue(destination)
    const service = createArtifactService({
      ...adapters,
      write: (path, text) => atomicWriteFile(path, text, { mode: 0o600 })
    })
    const generated = await service.generate({ kind: 'configuration', input })
    await service.action({ id: generated.artifacts[1].id, action: 'save' })
    expect(await readFile(destination, 'utf8')).toBe(configuration.plan)
    expect((await stat(destination)).mode & 0o777).toBe(0o600)
  })
})
