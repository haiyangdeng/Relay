import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import type { RelaySimplePublicationIpcApi } from '../../../../shared/relay/simple-publication'
import { SIMPLE_MODULES, type SimpleModule } from '../../../../shared/simple-config'
import type { RelayProfileSaveResult } from '../../../../shared/relay/profiles'
import type { RelaySimpleIpcApi } from '../../../../shared/relay/simple'
import type { RelaySimpleConfigurationIpcApi } from '../../../../shared/relay/simple-configuration'
import { SimplePublicationPanel } from './simple-publication-panel'
import { SimpleConfigurationPanel } from './simple-configuration-panel'
import { SimpleSourcesPanel } from './simple-sources-panel'
import {
  createSimplePanelController,
  hasUnsavedModules,
  isPublicationBlocking,
  type SimplePanelController,
  type SimplePanelState,
  type SimplePanelSourcesAdapter
} from './simple-panel-state'

export interface SimpleEditorScope {
  isCurrent(): boolean
  // Existing Main invalidation notifications, visibility and workspace restore
  // are adapted by the parent. No state body is broadcast through this seam.
  subscribeInvalidation(listener: () => void): () => void
}
interface Props {
  initialModule?: SimpleModule
  api: RelaySimpleIpcApi
  sources?: SimplePanelSourcesAdapter
  configuration?: RelaySimpleConfigurationIpcApi
  publication?: RelaySimplePublicationIpcApi
  saveProfile(request: { evidenceId: string }): Promise<RelayProfileSaveResult>
  scope: SimpleEditorScope
  busy: boolean
  onBusy?(busy: boolean): void
}

export function SimplePanelView({
  state,
  controller,
  busy
}: {
  state: SimplePanelState
  controller: SimplePanelController
  busy: boolean
}): React.JSX.Element {
  const publicationLocked = isPublicationBlocking(state),
    locked = busy || state.pending || publicationLocked,
    unsaved = hasUnsavedModules(state),
    selectedChanged =
      !!state.modules &&
      !!state.savedModules &&
      state.modules[state.module] !== state.savedModules[state.module]
  return (
    <section className="relay-panel relay-simple">
      <h2>Simple草稿编辑</h2>
      <p>
        读取并编辑模块，保存草稿后可检查结构或另存配置副本。模块正文可能含密码。
        界面模式不会切换配置或启动、停止核心。
      </p>
      <div className="relay-action">
        <button disabled={locked || state.needsRecovery} onClick={() => void controller.read()}>
          {state.modules ? '重新读取草稿（舍弃未保存文本）' : '读取Simple草稿'}
        </button>
        {state.needsRecovery && (
          <button disabled={locked} onClick={() => void controller.recover()}>
            核对磁盘草稿并恢复编辑
          </button>
        )}
      </div>
      {state.metadata && (
        <div>
          <p>
            文件版本：{state.metadata.revision || '尚无已保存文件'} ·{' '}
            {state.metadata.dirty ? '草稿与历史固定版本不同' : '草稿与历史固定版本一致'}
          </p>
          <p>
            {state.metadata.sharedConfigurationPinned
              ? '已绑定固定共享配置，DNS、Hosts、嗅探及geodata-mode可能被共享设置覆盖。'
              : '未绑定共享配置，按空共享配置预览；读取不会绑定最新版本。'}
            已有绑定版本变化需要另行显式选择，重新读取模块不会更新绑定。
          </p>
        </div>
      )}
      {state.modules && (
        <fieldset disabled={locked}>
          <label>
            编辑模块{' '}
            <select
              aria-label="Simple模块"
              value={state.module}
              onChange={(event) => controller.selectModule(event.target.value as SimpleModule)}
            >
              {(Object.keys(SIMPLE_MODULES) as SimpleModule[]).map((module) => (
                <option key={module} value={module}>
                  {SIMPLE_MODULES[module]}
                </option>
              ))}
            </select>
          </label>
          <p>
            {SIMPLE_MODULES[state.module]} · {state.modules[state.module].split('\n').length} 行 ·
            每模块最多128KiB
          </p>
          <textarea
            aria-label={`${SIMPLE_MODULES[state.module]}草稿正文`}
            rows={22}
            className="font-mono"
            value={state.modules[state.module]}
            onChange={(event) => controller.setText(event.target.value)}
          />
          <div className="relay-action">
            <button
              disabled={!selectedChanged || state.moduleRevisionStale || state.needsRecovery}
              onClick={() => void controller.saveModule()}
            >
              保存当前模块草稿
            </button>
            <button
              disabled={unsaved || state.moduleRevisionStale || state.needsRecovery}
              onClick={() => void controller.preview()}
            >
              预览已保存草稿
            </button>
          </div>
          {unsaved && <p>存在未保存文本。预览前请逐项保存，或显式重新读取舍弃文本。</p>}
          <label>
            副本名称{' '}
            <input
              aria-label="Simple副本名称"
              value={state.name}
              maxLength={108}
              onChange={(event) => controller.setName(event.target.value)}
            />
          </label>
          <div className="relay-action">
            <button
              disabled={
                unsaved || state.moduleRevisionStale || !state.preview?.valid || !state.name.trim()
              }
              onClick={() => void controller.prepareProfile(true)}
            >
              另存配置副本
            </button>
          </div>
        </fieldset>
      )}
      {state.preview && (
        <p>
          {state.preview.valid ? '结构预览通过' : '结构预览未通过'} · {state.preview.bytes} 字节 ·
          SHA256 {state.preview.yamlSHA256} · 核心兼容性未知
        </p>
      )}
      {state.preparation && (
        <p>
          待另存 {state.preparation.name} · SHA256 {state.preparation.sha256}。
          另存不会推进Simple历史版本或启用配置。
        </p>
      )}
      {state.metadata && state.metadata.sources.length > 0 && (
        <p>
          已保存来源绑定：
          {state.metadata.sources.map((source) => `${source.name}（${source.mode}）`).join('、')}。
          本面板不读取来源凭据或下载远端正文。
        </p>
      )}
      <p>
        HTTP来源只作URL及选项结构预览，未验证远端正文或核心兼容性。点击发布后会检查并保存配置；不会自动启用。
      </p>
      {state.moduleRevisionStale && (
        <p>模块基线与当前来源文件版本不同。未保存正文仍保留，请显式重新读取后再保存或预览。</p>
      )}
      {state.configurationEnabled && (
        <SimpleConfigurationPanel
          state={state}
          controller={controller}
          busy={busy || publicationLocked}
        />
      )}
      {state.sourcesEnabled && (
        <SimpleSourcesPanel
          state={state}
          controller={controller}
          busy={busy || publicationLocked}
        />
      )}
      {state.publicationEnabled && (
        <SimplePublicationPanel state={state} controller={controller} busy={busy} />
      )}
      {state.notice && <p role="status">{state.notice}</p>}
    </section>
  )
}

export function RelaySimplePanel({
  api,
  sources,
  configuration,
  publication,
  saveProfile,
  scope,
  busy,
  onBusy,
  initialModule
}: Props): React.JSX.Element {
  const currentProps = useRef({ busy, onBusy })
  currentProps.current = { busy, onBusy }
  const controller = useMemo(
    () =>
      createSimplePanelController({
        api,
        sources,
        configuration,
        publication,
        saveProfile,
        isCurrent: () => scope.isCurrent(),
        isBlocked: () => currentProps.current.busy,
        onBusy: (value) => currentProps.current.onBusy?.(value)
      }),
    [api, sources, configuration, publication, saveProfile, scope]
  )
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  )
  const routedModule = useRef<
    { controller: SimplePanelController; module: SimpleModule } | undefined
  >(undefined)
  useEffect(() => {
    controller.activate()
    return () => controller.deactivate()
  }, [controller])
  useEffect(() => scope.subscribeInvalidation(() => controller.invalidate()), [controller, scope])
  useEffect(() => {
    if (!initialModule) {
      routedModule.current = undefined
      return
    }
    if (busy || state.pending) return
    if (
      routedModule.current?.controller === controller &&
      routedModule.current.module === initialModule
    )
      return
    controller.selectModule(initialModule)
    routedModule.current = { controller, module: initialModule }
  }, [controller, initialModule, busy, state.pending])
  return <SimplePanelView state={state} controller={controller} busy={busy} />
}
