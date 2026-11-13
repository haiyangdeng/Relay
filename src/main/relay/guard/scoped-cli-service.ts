import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { StringDecoder } from 'string_decoder'
import {
  LocalProxyMutationRefused,
  type LocalRuntimeCaptureResult
} from '../core/local-proxy-service'
import type { RelayStateContext } from '../context'
import { readBinaryResource } from '../resources/source'
import { scopedCLIRequest, type ScopedCLIState } from '../../../shared/relay/guard-scoped-cli'
import {
  scopedStorageRequest,
  type ScopedStorageReport
} from '../../../shared/relay/guard-scoped-storage'
import { createScopedHTTPSBroker } from './scoped-https-broker'
import { scopedCLIProfile } from './scoped-cli-profile'
import { createScopedCLIWorkspace } from './scoped-cli-workspace'
import { GuardNativeUnavailable, type GuardNativeBridge } from './native-addon'
import type { ScopedStorageBridge } from './scoped-storage-native'

// A pinned Node>=24.5 + CLI JS resource pair is a release prerequisite. No
// Electron run-as-node, PATH discovery, npm install, shell or renderer path.
export function createScopedCLIService(adapters: {
  context: RelayStateContext
  resourceRoot: string
  bridge: GuardNativeBridge
  storage: ScopedStorageBridge
  capture(signal: AbortSignal): Promise<LocalRuntimeCaptureResult>
  owned(): { instanceId?: string; pid?: number }
  assertIdle(): void
  assertStorageIdle(): void
  confirmStart(): Promise<boolean>
  confirmStop(): Promise<boolean>
}) {
  let state: ScopedCLIState = {
    phase: 'idle',
    pending: false,
    output: '',
    truncated: false,
    protectionVerified: false,
    scope: 'explicitNormalTLSProcessTree'
  }
  let child: ChildProcessWithoutNullStreams | undefined, closed: Promise<void> | undefined
  let nativePrepared = false
  let generation = 0
  let storageGeneration = 0
  const invalidateStorage = (): void => {
    ++storageGeneration
    adapters.storage.invalidate()
  }
  let broker: Awaited<ReturnType<typeof createScopedHTTPSBroker>> | undefined
  let brokerClosing: Promise<void> | undefined
  const snapshot = (): ScopedCLIState => {
    if (child && broker && !broker.isAlive()) state.phase = 'uncertain'
    return structuredClone({ ...state, pending: state.pending || !!brokerClosing })
  }
  const endBroker = (): Promise<void> => {
    if (brokerClosing) return brokerClosing
    const previous = broker
    if (!previous && !child && !nativePrepared) return Promise.resolve()
    broker = undefined
    brokerClosing = (async () => {
      await previous?.close()
      if (child) {
        state.phase = 'uncertain'
        state.output = ''
      }
      if (nativePrepared) {
        const released = await adapters.bridge.revokeScoped()
        if (released.pending || released.scopedPolicy?.phase !== 'unbound')
          throw new Error('本次原生代理证据清除未确认。')
        nativePrepared = false
      }
    })().finally(() => {
      brokerClosing = undefined
    })
    return brokerClosing
  }
  const stop = async (): Promise<boolean> => {
    if (state.pending) invalidateStorage()
    if (adapters.storage.isBusy()) {
      invalidateStorage()
      return false
    }
    if (state.pending && !child) {
      ++generation // Revoke a late capture/approval before a child can exist.
      state.phase = 'stopping'
      try {
        await endBroker()
      } catch {
        state.phase = 'uncertain'
      }
      return false // Launch must settle; a second close is an explicit new intent.
    }
    if (!child) {
      try {
        await endBroker()
        state.phase = 'idle'
        state.output = ''
        return true
      } catch {
        return false
      }
    }
    if (state.pending) return false
    const owned = child
    state.pending = true
    try {
      if (!(await adapters.confirmStop())) return false
      state.phase = 'stopping'
      // Close the network capability before waiting for a cooperative child.
      try {
        await endBroker()
      } catch {
        state.phase = 'uncertain'
      }
      // New process group created by our own spawn only; no disk PID cleanup.
      if (child !== owned || owned.exitCode !== null || owned.signalCode !== null || !owned.pid) {
        state.phase = 'uncertain'
        await endBroker()
        return false
      }
      process.kill(-owned.pid, 'SIGTERM')
      await Promise.race([closed, new Promise<void>((resolve) => setTimeout(resolve, 3000))])
      if (child === owned) {
        state.phase = 'uncertain'
        return false
      }
      await endBroker()
      return true
    } catch {
      state.phase = 'uncertain'
      return false
    } finally {
      state.pending = false
    }
  }
  return {
    state: snapshot,
    isBlocking: () =>
      state.pending ||
      adapters.storage.isBusy() ||
      !!child ||
      !!broker ||
      !!brokerClosing ||
      nativePrepared ||
      state.phase === 'uncertain',
    async beforeRuntimeMutation(): Promise<void> {
      if (state.pending || child || adapters.storage.isBusy())
        throw new LocalProxyMutationRefused('受限 CLI 尚未结束，未更改核心。')
      await endBroker()
    },
    invalidateIntent: async (): Promise<void> => {
      ++generation
      invalidateStorage()
      await endBroker()
    },
    async storageAction(raw: unknown, current: () => void): Promise<ScopedStorageReport> {
      current()
      const request = scopedStorageRequest(raw)
      if (request.action === 'list') return adapters.storage.list(current)
      adapters.assertStorageIdle()
      const leader = child
      if (
        state.pending ||
        brokerClosing ||
        (leader && leader.exitCode === null && leader.signalCode === null)
      )
        throw new Error('请先结束本次 CLI 入口；不强制卸载。')
      const ticket = ++storageGeneration
      const assertStorage = (): void => {
        current()
        adapters.assertStorageIdle()
        if (ticket !== storageGeneration || (child && child !== leader))
          throw new Error('本次私有磁盘收尾意图已失效。')
      }
      state.pending = true
      try {
        // A positively exited same leader may leave stdout-owning descendants.
        // They are not signalled/adopted/declared gone by a storage operation.
        await endBroker()
        assertStorage()
        return await adapters.storage.close(request.workspaceID, request.revision, assertStorage)
      } finally {
        state.pending = false
      }
    },
    invalidateStorageIntent: invalidateStorage,
    requestClose: stop,
    stop,
    async launch(raw: unknown, assertCurrent: () => void = () => {}): Promise<ScopedCLIState> {
      assertCurrent()
      const input = scopedCLIRequest(raw)
      adapters.assertIdle()
      if (
        child ||
        broker ||
        brokerClosing ||
        nativePrepared ||
        state.pending ||
        adapters.storage.isBusy() ||
        state.phase === 'uncertain'
      )
        throw new Error('请先结束本次受限 CLI 会话。')
      const currentGeneration = ++generation
      const assertLaunch = (): void => {
        assertCurrent()
        if (generation !== currentGeneration) throw new Error('本次受限启动意图已撤销。')
      }
      state = {
        phase: 'starting',
        pending: true,
        output: '',
        truncated: false,
        protectionVerified: false,
        scope: 'explicitNormalTLSProcessTree'
      }
      try {
        const signal = new AbortController().signal,
          result = await adapters.capture(signal)
        if (result.status !== 'captured') throw new Error('请先准备自有专用代理。')
        const capture = result.capture,
          configurationSHA256 = createHash('sha256')
            .update(capture.snapshot.configuration)
            .digest('hex'),
          owner = adapters.owned()
        await capture.assertOwner(signal)
        if (!capture.isCurrent() || owner.instanceId !== capture.snapshot.instanceId || !owner.pid)
          throw new Error()
        assertLaunch()
        let native: Awaited<ReturnType<GuardNativeBridge['verifyScoped']>>
        try {
          native = await adapters.bridge.verifyScoped({
            instanceID: capture.snapshot.instanceId,
            configuration: capture.snapshot.configuration,
            pid: owner.pid
          })
        } catch (error) {
          // A lost or rejected receipt can follow a native write. Keep the
          // cleanup barrier except for a loader refusal before submission.
          if (!(error instanceof GuardNativeUnavailable)) nativePrepared = true
          throw error
        }
        nativePrepared = native.pending || native.scopedPolicy?.phase !== 'unbound'
        if (
          native.pending ||
          native.phase === 'blocked' ||
          native.scopedPolicy?.phase !== 'prepared' ||
          native.scopedPolicy.instanceID !== capture.snapshot.instanceId ||
          native.scopedPolicy.configurationSHA256 !== configurationSHA256
        )
          throw new Error('受限启动发布门尚未开放。')
        assertLaunch()
        // Native verified the signed App envelope, then the signed manifest pins
        // each executable byte resource below. This is not renderer authority.
        const manifest = JSON.parse(
          (
            await readBinaryResource(
              join(adapters.resourceRoot, 'guard-cli/manifest.json'),
              false,
              8192
            )
          ).toString('utf8')
        ) as Record<string, unknown>
        if (
          Object.keys(manifest).sort().join(',') !== 'assets,runtimeReady,schemaVersion' ||
          manifest.schemaVersion !== 1 ||
          manifest.runtimeReady !== true ||
          !manifest.assets ||
          typeof manifest.assets !== 'object' ||
          Array.isArray(manifest.assets)
        )
          throw new Error('受限 CLI 固定资源尚未发布。')
        const pair = (manifest.assets as Record<string, unknown>)[process.arch]
        if (!pair || typeof pair !== 'object' || Array.isArray(pair))
          throw new Error('本机 CLI 资源不可用。')
        const pins = pair as Record<string, unknown>
        if (
          Object.keys(pins).sort().join(',') !== 'cliSHA256,nodeSHA256,nodeVersion' ||
          typeof pins.nodeVersion !== 'string' ||
          !/^24\.(?:[5-9]|[1-9][0-9]+)\.[0-9]+$/u.test(pins.nodeVersion) ||
          [pins.cliSHA256, pins.nodeSHA256].some(
            (hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash)
          )
        )
          throw new Error('固定 Node/CLI 对不受支持。')
        const node = join(adapters.resourceRoot, 'guard-cli', process.arch, 'node'),
          cli = join(adapters.resourceRoot, 'guard-cli', process.arch, 'cli.js')
        for (const [path, hash] of [
          [node, pins.nodeSHA256],
          [cli, pins.cliSHA256]
        ])
          if (
            createHash('sha256')
              .update(await readBinaryResource(String(path)))
              .digest('hex') !== hash
          )
            throw new Error('CLI 固定资源已改变。')
        assertLaunch()
        if (!(await adapters.confirmStart())) {
          state.phase = 'idle'
          await endBroker()
          return { ...snapshot(), pending: false }
        }
        assertLaunch()
        await capture.assertOwner(signal)
        const verifiedCapture = {
          ...capture,
          assertOwner: async (active: AbortSignal): Promise<void> => {
            await capture.assertOwner(active)
            const checked = await adapters.bridge.verifyScoped()
            if (
              checked.pending ||
              checked.phase === 'blocked' ||
              checked.scopedPolicy?.phase !== 'prepared' ||
              checked.scopedPolicy.instanceID !== capture.snapshot.instanceId ||
              checked.scopedPolicy.configurationSHA256 !== configurationSHA256
            )
              throw new Error()
          }
        }
        broker = await createScopedHTTPSBroker(verifiedCapture)
        const workspace = await createScopedCLIWorkspace(
          adapters.context,
          adapters.storage,
          assertLaunch
        )
        const { support, home, work } = workspace
        const ca = join(support, 'proxy-ca.pem')
        await workspace.writeSupport('proxy-ca.pem', broker.ca)
        // curl uses a separate HTTPS-proxy CA option, not CURL_CA_BUNDLE (which
        // changes origin trust). Config is outside all writable sandbox roots.
        await workspace.writeSupport('.curlrc', `proxy-cacert = ${JSON.stringify(ca)}\n`)
        const env: NodeJS.ProcessEnv = {
          HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          TMPDIR: join(home, 'tmp'),
          PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`,
          LANG: 'en_US.UTF-8',
          HTTP_PROXY: broker.proxyURL,
          HTTPS_PROXY: broker.proxyURL,
          http_proxy: broker.proxyURL,
          https_proxy: broker.proxyURL,
          ALL_PROXY: broker.proxyURL,
          all_proxy: broker.proxyURL,
          NO_PROXY: '',
          no_proxy: '',
          NODE_EXTRA_CA_CERTS: ca,
          NODE_OPTIONS: '--use-env-proxy',
          CURL_HOME: support,
          GIT_CONFIG_COUNT: '2',
          GIT_CONFIG_KEY_0: 'http.proxy',
          GIT_CONFIG_VALUE_0: broker.proxyURL,
          GIT_CONFIG_KEY_1: 'http.proxySSLCAInfo',
          GIT_CONFIG_VALUE_1: ca,
          GIT_PROXY_SSL_CAINFO: ca,
          ANTHROPIC_API_KEY: input.apiKey
        }
        await verifiedCapture.assertOwner(signal)
        await workspace.assertCurrent()
        assertLaunch()
        if (!broker?.isAlive()) throw new Error('本次代理通道已失效。')
        const launched = spawn(
          '/usr/bin/sandbox-exec',
          [
            '-p',
            scopedCLIProfile(broker.port, home, work, workspace.protectedPaths),
            node,
            '--use-env-proxy',
            cli,
            '-p',
            input.prompt
          ],
          { cwd: work, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }
        )
        child = launched
        launched.stdin.end()
        const appendOutput = (text: string): void => {
          // Bounded, session-only UI output. No file, log, console or telemetry.
          if (state.output.length + text.length > 32768) state.truncated = true
          state.output = (state.output + text).slice(-32768)
        }
        const receive = (): { data(data: Buffer): void; end(): void } => {
          const decoder = new StringDecoder('utf8')
          let pending = ''
          const flush = (final: boolean): void => {
            const through = final
              ? pending.length
              : Math.max(0, pending.length - input.apiKey.length + 1)
            let cursor = 0,
              text = ''
            while (cursor < through) {
              const found = pending.indexOf(input.apiKey, cursor)
              if (found < 0 || found >= through) {
                text += pending.slice(cursor, through)
                cursor = through
              } else {
                text += pending.slice(cursor, found) + '[已隐藏]'
                cursor = found + input.apiKey.length
              }
            }
            pending = pending.slice(cursor)
            appendOutput(text)
          }
          return {
            data(data): void {
              pending += decoder.write(data)
              flush(false)
            },
            end(): void {
              pending += decoder.end()
              flush(true)
            }
          }
        }
        const stdout = receive(),
          stderr = receive()
        launched.stdout.on('data', stdout.data).once('end', stdout.end)
        launched.stderr.on('data', stderr.data).once('end', stderr.end)
        closed = new Promise<void>((resolve) => {
          launched.once('error', () => {
            state.phase = 'uncertain'
          })
          launched.once('close', (code) => {
            if (child === launched) {
              child = undefined
              state.phase = code === 0 ? 'exited' : 'uncertain'
              state.exitCode = code ?? undefined
            }
            void endBroker()
              .catch(() => {
                state.phase = 'uncertain'
              })
              .finally(resolve)
          })
        })
        await new Promise<void>((resolve, reject) => {
          launched.once('spawn', resolve)
          launched.once('error', reject)
        })
        state.phase = 'running'
        return { ...snapshot(), pending: false }
      } catch {
        state.phase = 'blocked'
        try {
          await endBroker()
        } catch {
          state.phase = 'uncertain'
        }
        throw new Error('受限 CLI 启动未完成；没有直连或普通启动回退。')
      } finally {
        state.pending = false
      }
    }
  }
}
