import { isValidElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayUpdatePanel } from './update-panel'
import { RelayAppUpdatePanel } from './app-update-panel'
import { RelayRemoteBackupPanel } from './backup-remote-panel'
import { RelayRuntimeGistPanel } from './runtime-gist-panel'
import { RelayWebdavDirectoryPanel } from './webdav-directory-panel'
import { RelayBackupAccountPanel } from './backup-account-panel'
import { RelayBackupPanel } from './backup-panel'
import { RelayMaintenancePanel } from './maintenance-panel'

const hooks = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as (() => void | (() => void))[],
  cleanups: [] as (() => void)[]
}))
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState<T>(initial?: T | (() => T)) {
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
  },
  useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
    const at = hooks.cursor++,
      prior = hooks.slots[at] as readonly unknown[] | undefined
    if (!prior || deps.some((item, index) => !Object.is(item, prior[index])))
      hooks.effects.push(effect)
    hooks.slots[at] = deps
  }
}))
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
function button(tree: ReactNode, label: string): () => void {
  const found = elements(tree).find(
    (item) => item.type === 'button' && content(item.props.children as ReactNode) === label
  )
  expect(found, label).toBeDefined()
  if (!found) throw new Error(label)
  return found.props.onClick as () => void
}
function render(component: () => ReactNode): ReactNode {
  hooks.cursor = 0
  const tree = component()
  for (const effect of hooks.effects.splice(0)) {
    const cleanup = effect()
    if (cleanup) hooks.cleanups.push(cleanup)
  }
  return tree
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const id = '00000000-0000-4000-8000-000000000001'
const release = {
  version: '2.0.1',
  architecture: 'arm64',
  bytes: 100,
  sha512: 'a'.repeat(86) + '==',
  releasedAt: '2026-11-10T00:00:00Z'
}
const appState = {
  configured: true,
  runningVersion: '2.0.0',
  checkedAt: 1,
  pending: false,
  phase: 'idle',
  latest: release,
  candidates: [],
  incomplete: 0,
  installation: null,
  installationRevision: '',
  requiresApplicationExit: false
}
beforeEach(() => {
  hooks.slots = []
  hooks.cursor = 0
  hooks.effects = []
  hooks.cleanups = []
})
afterEach(() => {
  for (const cleanup of hooks.cleanups) cleanup()
  vi.unstubAllGlobals()
})
function environment(handler: (channel: string, request?: unknown) => Promise<unknown>) {
  const invoke = vi.fn(handler),
    events = new Map<string, () => void>(),
    onBusy = vi.fn()
  vi.stubGlobal('window', {
    electron: {
      ipcRenderer: {
        invoke,
        on: (name: string, callback: () => void) => {
          events.set(name, callback)
          return () => {
            events.delete(name)
          }
        }
      }
    }
  })
  return { invoke, events, onBusy }
}

describe('Direct backup/update actions', () => {
  it.each([
    ['reset-interface', '重置界面与导航偏好…', 'reset'],
    ['restore-interface', '恢复最近一次界面偏好…', 'restored'],
    ['clear-renderer-cache', '清理本界面资源缓存…', 'cleared'],
    ['export-heap', '导出Main堆快照…', 'exported']
  ] as const)(
    'executes the selected %s maintenance action once after validating its proof',
    async (action, label, status) => {
      const fixture = environment(async (channel) => {
        if (channel === 'relayMaintenancePrepare')
          return { evidenceId: id, action, expiresAt: Date.now() + 60000, backupId: null }
        if (channel === 'relayMaintenanceExecute')
          return status === 'exported'
            ? {
                status,
                export: {
                  id,
                  fileName: `Relay-main-${id}.heapsnapshot`,
                  bytes: 42,
                  sha256: 'a'.repeat(64),
                  containsSecrets: true
                }
              }
            : { status }
        return {
          pending: false,
          phase: 'idle',
          reset: {
            id,
            phase: 'reset',
            beforeRevision: '',
            beforeSHA256: 'a'.repeat(64),
            afterRevision: 'b'.repeat(64)
          }
        }
      })
      const component = () => RelayMaintenancePanel({ busy: false, onBusy: fixture.onBusy })
      button(render(component), '读取维护状态')()
      await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
      button(render(component), label)()
      await vi.waitFor(() =>
        expect(fixture.invoke).toHaveBeenCalledWith('relayMaintenanceExecute', { evidenceId: id })
      )
      await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
      expect(
        fixture.invoke.mock.calls.filter(([channel]) => channel === 'relayMaintenancePrepare')
      ).toHaveLength(1)
      expect(fixture.invoke).toHaveBeenCalledWith('relayMaintenancePrepare', action)
      expect(
        fixture.invoke.mock.calls.filter(([channel]) => channel === 'relayMaintenanceExecute')
      ).toHaveLength(1)
      expect(content(render(component))).not.toContain('单独确认本次维护')
    }
  )

  it.each(['cancel', 'unmount', 'wrong-action', 'failure'] as const)(
    'does not execute maintenance after %s while preparing',
    async (interruption) => {
      const proof = deferred<unknown>()
      const fixture = environment(async (channel) => {
        if (channel === 'relayMaintenancePrepare') {
          if (interruption === 'failure') throw new Error('fixture failure')
          return proof.promise
        }
        return { pending: false, phase: 'idle', reset: null }
      })
      const component = () => RelayMaintenancePanel({ busy: false, onBusy: fixture.onBusy })
      button(render(component), '重置界面与导航偏好…')()
      await vi.waitFor(() =>
        expect(fixture.invoke).toHaveBeenCalledWith('relayMaintenancePrepare', 'reset-interface')
      )
      if (interruption === 'cancel') button(render(component), '取消本次维护准备')()
      if (interruption === 'unmount') for (const cleanup of hooks.cleanups.splice(0)) cleanup()
      proof.resolve({
        evidenceId: id,
        action: interruption === 'wrong-action' ? 'export-heap' : 'reset-interface',
        expiresAt: Date.now() + 60000,
        backupId: null
      })
      await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
      expect(
        fixture.invoke.mock.calls.some(([channel]) => channel === 'relayMaintenanceExecute')
      ).toBe(false)
      expect(
        fixture.invoke.mock.calls.filter(([channel]) => channel === 'relayMaintenancePrepare')
      ).toHaveLength(1)
    }
  )

  it.each(['resource', 'app', 'remote', 'gist'] as const)(
    '%s prepares once then consumes only its returned proof from the same click',
    async (kind) => {
      const prefixes = {
        resource: ['relayUpdatePrepare', 'relayUpdateExecute'],
        app: ['relayAppUpdatePrepareDownload', 'relayAppUpdateDownload'],
        remote: ['relayBackupRemotePrepare', 'relayBackupRemoteExecute'],
        gist: ['relayRuntimeGistPrepare', 'relayRuntimeGistExecute']
      }
      const [prepare, execute] = prefixes[kind],
        proof = deferred<unknown>()
      const fixture = environment(async (channel) => {
        if (channel === prepare) return proof.promise
        if (channel === execute)
          return { status: kind === 'remote' || kind === 'gist' ? 'uploaded' : 'staged' }
        if (channel === 'relayAppUpdateState') return appState
        return { trustedAssets: [], candidates: [], incomplete: 0 }
      })
      const component = () =>
        kind === 'resource'
          ? RelayUpdatePanel({ busy: false, onBusy: fixture.onBusy })
          : kind === 'app'
            ? RelayAppUpdatePanel({ busy: false, onBusy: fixture.onBusy })
            : kind === 'remote'
              ? RelayRemoteBackupPanel({
                  busy: false,
                  onBusy: fixture.onBusy,
                  onRestoreNotice: vi.fn()
                })
              : RelayRuntimeGistPanel({ busy: false, onBusy: fixture.onBusy })
      const label = {
        resource: '下载并校验候选',
        app: '下载最新版本',
        remote: '上传新备份',
        gist: '上传所选运行配置'
      }[kind]
      const tree = render(component)
      expect(fixture.invoke).not.toHaveBeenCalled()
      button(tree, label)()
      await vi.waitFor(() =>
        expect(fixture.invoke).toHaveBeenCalledWith(
          prepare,
          ...(kind === 'app' ? [] : [expect.any(Object)])
        )
      )
      expect(fixture.invoke.mock.calls.some(([channel]) => channel === execute)).toBe(false)
      proof.resolve({
        evidenceId: id,
        operation: 'download',
        release,
        expiresAt: Date.now() + 60000
      })
      await vi.waitFor(() =>
        expect(fixture.invoke).toHaveBeenCalledWith(execute, { evidenceId: id })
      )
      await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
      expect(fixture.invoke.mock.calls.filter(([channel]) => channel === prepare)).toHaveLength(1)
      expect(fixture.invoke.mock.calls.filter(([channel]) => channel === execute)).toHaveLength(1)
    }
  )

  it.each(['resource', 'app', 'remote', 'gist'] as const)(
    '%s cannot continue a pending preparation after cancellation or unmount',
    async (kind) => {
      const prepare = {
        resource: 'relayUpdatePrepare',
        app: 'relayAppUpdatePrepareDownload',
        remote: 'relayBackupRemotePrepare',
        gist: 'relayRuntimeGistPrepare'
      }[kind]
      const proof = deferred<unknown>(),
        fixture = environment(async (channel) => (channel === prepare ? proof.promise : {}))
      const component = () =>
        kind === 'resource'
          ? RelayUpdatePanel({ busy: false, onBusy: fixture.onBusy })
          : kind === 'app'
            ? RelayAppUpdatePanel({ busy: false, onBusy: fixture.onBusy })
            : kind === 'remote'
              ? RelayRemoteBackupPanel({
                  busy: false,
                  onBusy: fixture.onBusy,
                  onRestoreNotice: vi.fn()
                })
              : RelayRuntimeGistPanel({ busy: false, onBusy: fixture.onBusy })
      button(
        render(component),
        {
          resource: '下载并校验候选',
          app: '下载最新版本',
          remote: '上传新备份',
          gist: '上传所选运行配置'
        }[kind]
      )()
      await vi.waitFor(() =>
        expect(fixture.invoke.mock.calls.some(([channel]) => channel === prepare)).toBe(true)
      )
      for (const cleanup of hooks.cleanups.splice(0)) cleanup()
      proof.resolve({
        evidenceId: id,
        operation: 'download',
        release,
        expiresAt: Date.now() + 60000
      })
      await vi.waitFor(() =>
        expect(fixture.invoke.mock.calls.filter(([channel]) => channel === prepare)).toHaveLength(1)
      )
      await new Promise((resolve) => setImmediate(resolve))
      expect(
        fixture.invoke.mock.calls.some(([channel]) => /Execute$|AppUpdateDownload$/.test(channel))
      ).toBe(false)
    }
  )

  it('does not execute or retry when preparation fails', async () => {
    const fixture = environment(async () => {
      throw new Error('synthetic preparation refusal')
    })
    button(
      render(() =>
        RelayRemoteBackupPanel({ busy: false, onBusy: fixture.onBusy, onRestoreNotice: vi.fn() })
      ),
      '上传新备份'
    )()
    await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
    expect(fixture.invoke).toHaveBeenCalledTimes(1)
    expect(fixture.invoke.mock.calls[0][0]).toBe('relayBackupRemotePrepare')
  })

  it('receipt props only display a result and never execute on mount', () => {
    const fixture = environment(async () => {
      throw new Error('unexpected IO')
    })
    render(() =>
      RelayRemoteBackupPanel({
        busy: false,
        onBusy: fixture.onBusy,
        onRestoreNotice: vi.fn(),
        externalPreparation: {
          plan: {
            evidenceId: id,
            provider: 'gist',
            action: 'upload',
            endpoint: 'fixture',
            proxyPort: 17891,
            encrypted: true,
            containsSecrets: true,
            expiresAt: 100
          },
          result: { status: 'uploaded' }
        }
      })
    )
    expect(fixture.invoke).not.toHaveBeenCalled()
    expect(
      content(
        render(() =>
          RelayRemoteBackupPanel({ busy: false, onBusy: fixture.onBusy, onRestoreNotice: vi.fn() })
        )
      )
    ).toContain('已上传并读回核对')
  })

  it('creates the selected WebDAV leaf in one click and keeps the account revision in preparation', async () => {
    const account = {
      id,
      revision: 'a'.repeat(64),
      name: 'Fixture',
      provider: 'webdav',
      state: 'active',
      directoryURL: 'https://fixture.invalid/backups/',
      username: 'user',
      proxyPort: 17891
    }
    const fixture = environment(async (channel) =>
      channel === 'relayBackupAccountList'
        ? { accounts: [account], incomplete: 0 }
        : channel === 'relayBackupDirectoryPrepare'
          ? { ...account, evidenceId: id, expiresAt: Date.now() + 60000 }
          : { status: 'cancelled' }
    )
    const component = () => RelayWebdavDirectoryPanel({ busy: false, onBusy: fixture.onBusy })
    button(render(component), '读取可创建目录的WebDAV账号')()
    await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
    const select = elements(render(component)).find(
      (item) => item.props['aria-label'] === '创建目录账号'
    )
    if (!select) throw new Error('Missing account selector')
    ;(select.props.onChange as (event: unknown) => void)({ target: { value: id } })
    button(render(component), '创建账号目录末层')()
    await vi.waitFor(() =>
      expect(fixture.invoke).toHaveBeenCalledWith('relayBackupDirectoryExecute', { evidenceId: id })
    )
    expect(fixture.invoke).toHaveBeenCalledWith('relayBackupDirectoryPrepare', {
      id,
      revision: account.revision
    })
  })

  it.each(['resume', 'rollback'] as const)(
    'executes only the selected %s recovery action after one click',
    async (action) => {
      const plan = { evidenceId: id },
        onRestoreNotice = vi.fn()
      const fixture = environment(async (channel) =>
        channel === 'relayBackupRecoveryList'
          ? [{ id, version: 2, phase: 'uncertain', actions: ['resume', 'rollback'] }]
          : channel === 'relayBackupRecoveryPrepare'
            ? { status: 'prepared', plan }
            : channel === 'relayBackupRecoveryCommit'
              ? { status: action === 'resume' ? 'restored' : 'rolled-back' }
              : undefined
      )
      const component = () =>
        RelayBackupPanel({ busy: false, onBusy: fixture.onBusy, onRestoreNotice })
      button(render(component), '读取恢复记录')()
      await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
      button(render(component), action === 'resume' ? '继续恢复' : '回滚原件')()
      await vi.waitFor(() =>
        expect(fixture.invoke).toHaveBeenCalledWith('relayBackupRecoveryCommit', { evidenceId: id })
      )
      expect(fixture.invoke).toHaveBeenCalledWith('relayBackupRecoveryPrepare', { id, action })
      expect(
        fixture.invoke.mock.calls.filter(([channel]) => channel === 'relayBackupRecoveryCommit')
      ).toHaveLength(1)
    }
  )

  it('does not commit a recovery proof returned after lifecycle invalidation', async () => {
    const proof = deferred<unknown>()
    const fixture = environment(async (channel) =>
      channel === 'relayBackupRecoveryList'
        ? [{ id, version: 2, phase: 'uncertain', actions: ['resume'] }]
        : channel === 'relayBackupRecoveryPrepare'
          ? proof.promise
          : undefined
    )
    const component = () =>
      RelayBackupPanel({ busy: false, onBusy: fixture.onBusy, onRestoreNotice: vi.fn() })
    button(render(component), '读取恢复记录')()
    await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
    button(render(component), '继续恢复')()
    await vi.waitFor(() =>
      expect(fixture.invoke).toHaveBeenCalledWith('relayBackupRecoveryPrepare', {
        id,
        action: 'resume'
      })
    )
    fixture.events.get('relayBackupPreparationsInvalidated')?.()
    proof.resolve({ status: 'prepared', plan: { evidenceId: id } })
    await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
    expect(
      fixture.invoke.mock.calls.some(([channel]) => channel === 'relayBackupRecoveryCommit')
    ).toBe(false)
  })

  it('saved-account transfer sends a terminal receipt to the display panel rather than an executable preparation', async () => {
    const account = {
      id,
      revision: 'a'.repeat(64),
      name: 'Fixture',
      provider: 'gist',
      state: 'active',
      proxyPort: 17891
    }
    const plan = { evidenceId: id },
      result = { status: 'uploaded', gistId: 'abcde' },
      onPrepared = vi.fn()
    const fixture = environment(async (channel) =>
      channel === 'relayBackupAccountList'
        ? { accounts: [account], incomplete: 0 }
        : channel === 'relayBackupAccountPrepareRemote'
          ? plan
          : channel === 'relayBackupRemoteExecute'
            ? result
            : undefined
    )
    const component = () =>
      RelayBackupAccountPanel({ busy: false, onBusy: fixture.onBusy, onPrepared })
    button(render(component), '读取已保存账号')()
    await vi.waitFor(() => expect(fixture.onBusy).toHaveBeenLastCalledWith(false))
    button(render(component), '选择Fixture')()
    button(render(component), '用所选账号上传新备份')()
    await vi.waitFor(() => expect(onPrepared).toHaveBeenCalledWith(plan, result))
    expect(
      fixture.invoke.mock.calls.filter(([channel]) => channel === 'relayBackupRemoteExecute')
    ).toHaveLength(1)
  })
})
