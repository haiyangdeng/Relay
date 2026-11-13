import type {
  RelaySimpleProviderOptions,
  RelaySimpleSourceValue
} from '../../../../shared/relay/simple-sources'
import type { SimplePanelController, SimplePanelState } from './simple-panel-state'

const keyFor = (value: { id: string; sha256: string }) => value.id + ':' + value.sha256
export function SimpleSourcesPanel({
  state,
  controller,
  busy
}: {
  state: SimplePanelState
  controller: SimplePanelController
  busy: boolean
}): React.JSX.Element {
  const locked = busy || state.pending,
    snapshot = state.sourceSnapshot,
    form = state.sourceForm,
    selectedOrigin = form?.source
      ? state.sourceOrigins?.find(
          (origin) => origin.id === form.source?.id && origin.revision === form.source?.revision
        )
      : undefined,
    profileChoices = [...(state.sourceProfiles ?? [])]
  const selectedProfile = form?.profile
  if (
    selectedProfile &&
    !profileChoices.some((choice) => keyFor(choice) === keyFor(selectedProfile))
  )
    profileChoices.push({ ...selectedProfile, name: '当前明确选择的固定profile' })
  for (const version of selectedOrigin?.versions ?? [])
    if (!profileChoices.some((choice) => keyFor(choice) === keyFor(version.profile)))
      profileChoices.push({ ...version.profile, name: '此来源的历史profile' })
  const setFilter = (key: 'filter' | 'exclude-filter' | 'exclude-type', value: string): void => {
    const options = { ...form?.providerOptions }
    if (value === '') delete options[key]
    else options[key] = value
    controller.updateSourceForm({
      providerOptions: Object.keys(options).length ? options : undefined
    })
  }
  const setBoolean = (key: 'tfo' | 'mptcp' | 'udp' | 'udp-over-tcp', value: string): void => {
    const options = { ...form?.providerOptions },
      override = { ...options.override }
    if (value === 'unset') delete override[key]
    else override[key] = value === 'true'
    if (Object.keys(override).length) options.override = override
    else delete options.override
    controller.updateSourceForm({
      providerOptions: Object.keys(options).length ? options : undefined
    })
  }
  const setSize = (value: string): void => {
    const options: RelaySimpleProviderOptions = { ...form?.providerOptions }
    if (value === '') delete options['size-limit']
    else if (/^(0|[1-9][0-9]*)$/u.test(value) && Number.isSafeInteger(Number(value)))
      options['size-limit'] = Number(value)
    else return
    controller.updateSourceForm({
      providerOptions: Object.keys(options).length ? options : undefined
    })
  }
  return (
    <div className="relay-simple-sources">
      <h3>来源草稿绑定</h3>
      <p>
        显式选择固定profile/SHA和可选来源修订，不默认最新版本。URL、查询令牌、鉴权及AGE由Main私有读取，不回本表单。
      </p>
      <div className="relay-action">
        <button
          disabled={locked || state.needsRecovery}
          onClick={() => void controller.readSources()}
        >
          读取来源绑定与版本候选
        </button>
      </div>
      {snapshot && (
        <>
          <p>
            来源文件版本：{snapshot.revision || '尚无文件'}
            。修改或删除只改草稿绑定，模块引用和历史固定版本保持；结构预览可能需要手工修复引用。
          </p>
          <ul>
            {snapshot.sources.map((row) => (
              <li key={row.bindingId}>
                {row.name}（{row.mode}） · profile {row.profile.id} · SHA256 {row.profile.sha256}
                {!row.editable && (
                  <span> · 含不支持的既有选项，只可保持或明确删除，不会省略后覆盖。</span>
                )}
                <div className="relay-action">
                  <button
                    disabled={locked || !row.editable || state.needsRecovery}
                    onClick={() => controller.editSource(row.bindingId)}
                  >
                    编辑此草稿绑定
                  </button>
                  <button
                    disabled={locked || state.needsRecovery}
                    onClick={() => void controller.removeSource(row.bindingId)}
                  >
                    仅删除此草稿绑定
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <div className="relay-action">
            <button
              disabled={locked || state.needsRecovery || snapshot.sources.length >= 64}
              onClick={() => controller.newSource()}
            >
              新增来源草稿绑定
            </button>
          </div>
        </>
      )}
      {form && (
        <fieldset disabled={locked || state.needsRecovery}>
          <legend>{form.bindingId ? '替换明确选择的草稿绑定' : '新增草稿绑定'}</legend>
          <label>
            Profile / SHA256{' '}
            <select
              aria-label="来源profile固定版本"
              value={form.profile ? keyFor(form.profile) : ''}
              onChange={(event) => controller.chooseSourceProfile(event.target.value)}
            >
              <option value="">请明确选择profile</option>
              {profileChoices.map((choice) => (
                <option key={keyFor(choice)} value={keyFor(choice)}>
                  {choice.name} · {choice.sha256}
                </option>
              ))}
            </select>
          </label>
          <label>
            可选当前来源修订{' '}
            <select
              aria-label="来源固定修订"
              value={form.source ? form.source.id + ':' + form.source.revision : ''}
              onChange={(event) => controller.chooseSourceOrigin(event.target.value)}
            >
              <option value="">不绑定来源（HTTP模式不可用）</option>
              {form.source && !selectedOrigin && (
                <option value={form.source.id + ':' + form.source.revision} disabled>
                  已存修订不在本次候选中，请显式重选
                </option>
              )}
              {state.sourceOrigins?.map((origin) => (
                <option
                  key={origin.id + ':' + origin.revision}
                  value={origin.id + ':' + origin.revision}
                  disabled={origin.locked}
                >
                  {origin.name} · {origin.origin} · {origin.revision}
                  {origin.locked ? '（锁定）' : ''}
                </option>
              ))}
            </select>
          </label>
          {selectedOrigin && (
            <label>
              此来源的历史profile版本{' '}
              <select
                aria-label="来源历史profile版本"
                disabled={selectedOrigin.locked}
                value={form.selectedVersionId ?? ''}
                onChange={(event) => controller.chooseSourceVersion(event.target.value)}
              >
                <option value="">请选择版本（不默认最新）</option>
                {selectedOrigin.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.createdAt} · {version.id} · {version.profile.sha256}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p>绑定当前来源意图和该profile的历史成员关系，不表示历史下载凭据。</p>
          <label>
            来源名称{' '}
            <input
              aria-label="来源草稿名称"
              maxLength={256}
              value={form.name}
              onChange={(event) => controller.updateSourceForm({ name: event.target.value })}
            />
          </label>
          <label>
            模式{' '}
            <select
              aria-label="来源草稿模式"
              value={form.mode}
              onChange={(event) =>
                controller.updateSourceForm({
                  mode: event.target.value as RelaySimpleSourceValue['mode']
                })
              }
            >
              <option value="extract">提取节点</option>
              <option value="inline">Inline Provider</option>
              <option value="http">HTTP Provider</option>
            </select>
          </label>
          <label>
            节点前缀{' '}
            <input
              aria-label="来源节点前缀"
              maxLength={256}
              value={form.prefix}
              onChange={(event) => controller.updateSourceForm({ prefix: event.target.value })}
            />
          </label>
          <label>
            {form.mode === 'http' ? 'Provider间隔（秒）' : '保留的间隔值（当前模式不调度）'}{' '}
            <input
              aria-label="来源间隔秒数"
              inputMode="numeric"
              value={form.intervalText}
              onChange={(event) =>
                controller.updateSourceForm({ intervalText: event.target.value })
              }
            />
          </label>
          {(form.mode === 'http' || form.proxy) && (
            <label>
              HTTP集合更新出站名称{' '}
              <input
                aria-label="来源集合更新出站"
                value={form.proxy}
                onChange={(event) => controller.updateSourceForm({ proxy: event.target.value })}
              />
            </label>
          )}
          {form.mode !== 'extract' && (
            <>
              {(['filter', 'exclude-filter', 'exclude-type'] as const).map((key) => (
                <label key={key}>
                  {key}{' '}
                  <input
                    aria-label={'来源选项 ' + key}
                    value={form.providerOptions?.[key] ?? ''}
                    onChange={(event) => setFilter(key, event.target.value)}
                  />
                </label>
              ))}
              {(form.mode === 'http' || form.providerOptions?.['size-limit'] !== undefined) && (
                <label>
                  HTTP大小上限（字节）{' '}
                  <input
                    aria-label="来源大小上限"
                    inputMode="numeric"
                    value={form.providerOptions?.['size-limit'] ?? ''}
                    onChange={(event) => setSize(event.target.value)}
                  />
                </label>
              )}
              {(['tfo', 'mptcp', 'udp', 'udp-over-tcp'] as const).map((key) => (
                <label key={key}>
                  {key}{' '}
                  <select
                    aria-label={'来源覆盖 ' + key}
                    value={
                      form.providerOptions?.override?.[key] === undefined
                        ? 'unset'
                        : String(form.providerOptions.override[key])
                    }
                    onChange={(event) => setBoolean(key, event.target.value)}
                  >
                    <option value="unset">未设置</option>
                    <option value="true">启用</option>
                    <option value="false">禁用</option>
                  </select>
                </label>
              ))}
            </>
          )}
          {(form.providerOptions || form.proxy) && (
            <div className="relay-action">
              <button
                onClick={() =>
                  controller.updateSourceForm({ providerOptions: undefined, proxy: '' })
                }
              >
                明确清除集合选项与集合出站
              </button>
            </div>
          )}
          <p>
            HTTP仅保存URL/选项结构，未验证远端响应或Core兼容性。切换模式不会自动丢弃旧选项；不支持的选项需明确清除。
          </p>
          <div className="relay-action">
            <button
              disabled={!form.profile || !form.name.trim()}
              onClick={() => void controller.saveSource()}
            >
              仅保存来源草稿绑定
            </button>
            <button onClick={() => controller.cancelSourceForm()}>取消本次来源编辑</button>
          </div>
        </fieldset>
      )}
    </div>
  )
}
