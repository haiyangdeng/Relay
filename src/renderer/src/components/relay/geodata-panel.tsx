import { useRelayInitialRead } from '../../hooks/use-relay-initial-read'
import { GeoDataView, type GeoURLKey, type GeoURLs } from '../resources/geo-data-view'
import { useRelayGeoData } from '../../hooks/use-relay-geodata'
import { geoFields, type GeoOriginDraft } from '../../utils/relay-geo-config'

export function RelayGeoDataPanel({
  active: pageActive = true,
  busy,
  onBusy,
  tunSessionId,
  onModeChanged
}: {
  active?: boolean
  busy: boolean
  onBusy(value: boolean): void
  tunSessionId?: string
  onModeChanged?(): void
}): React.JSX.Element {
  const data = useRelayGeoData({ busy, onBusy, tunSessionId, onModeChanged }),
    locked = busy || data.pending > 0,
    formLocked = locked || !data.draft || data.requiresRead,
    urls: GeoURLs = { geoip: '', geosite: '', mmdb: '', asn: '' },
    urlDisabled: Partial<Record<GeoURLKey, boolean>> = {},
    actions: Partial<Record<GeoURLKey, React.ReactNode>> = {}
  for (const field of geoFields) {
    urls[field.key] = data.urls[field.kind] ?? ''
    if (field.kind === data.kind && data.draft) urls[field.key] = data.draft.url
    urlDisabled[field.key] = formLocked || field.kind !== data.kind
    const info = data.inventory?.origins.find((i) => i.descriptor.kind === field.kind)
    actions[field.key] = (
      <button
        disabled={locked || data.dirty || data.kind === field.kind}
        onClick={() => data.choose(field.kind)}
        aria-pressed={data.kind === field.kind}
      >
        {data.kind === field.kind ? '编辑中' : '编辑'}
        {info ? '' : ' · 未添加'}
      </button>
    )
  }
  function update<K extends keyof GeoOriginDraft>(key: K, value: GeoOriginDraft[K]): void {
    const draft = data.draft
    if (draft) data.change({ ...draft, [key]: value })
  }
  const active = data.snapshot?.resources.find((r) => r.kind === data.kind),
    head = data.info?.head,
    currentHead = !!head && head.originRevision === data.info?.originRevision,
    supported =
      !!tunSessionId &&
      !!data.snapshot &&
      data.snapshot.sessionId === tunSessionId &&
      data.quarantined !== tunSessionId
  useRelayInitialRead(pageActive, !!data.inventory && !!data.modeBase, locked, async () => {
    await data.readSettings()
    await data.readMode()
    await data.readSchedule()
  })
  useRelayInitialRead(
    pageActive && !!data.info,
    !!data.draft,
    locked || !data.modeBase || !data.inventory,
    data.read,
    data.kind
  )
  return (
    <section className="relay-panel" aria-label="GeoData结构化管理">
      <h2>外部资源</h2>
      <p className="text-xs">选择数据库后编辑地址，保存来源或手动更新缓存。</p>
      <div className="relay-action">
        <button
          disabled={locked || data.dirty}
          onClick={() =>
            void (async () => {
              await data.readSettings()
              await data.readMode()
              await data.readSchedule()
            })()
          }
        >
          {data.modeDirty ? '放弃模式修改并刷新' : '刷新'}
        </button>
        {data.modeDirty && (
          <button
            disabled={locked || !data.modeBase || !data.modeDirty || data.modeRequiresRead}
            onClick={() => void data.saveMode()}
          >
            保存模式
          </button>
        )}
      </div>
      <GeoDataView
        urls={urls}
        urlActions={actions}
        urlDisabled={urlDisabled}
        onURLChange={(key, value) => {
          const field = geoFields.find((f) => f.key === key)
          if (field?.kind === data.kind) update('url', value)
        }}
        mode={data.mode}
        allowInherited
        modeDisabled={locked || !data.modeBase || data.modeRequiresRead}
        onModeChange={data.changeMode}
        autoUpdate={data.draft?.requested ?? data.info?.autoIntent.requested ?? false}
        autoTitle="保存自动更新计划"
        autoDisabled={formLocked}
        onAutoChange={(value) => update('requested', value)}
        intervalHours={
          data.draft?.hours ??
          (data.info?.autoIntent.schedule.kind === 'interval'
            ? String(data.info.autoIntent.schedule.minutes / 60)
            : '')
        }
        onHoursChange={(value) => {
          const draft = data.draft
          if (draft) data.change({ ...draft, hours: value, hoursChanged: true })
        }}
        onUpdate={() => void data.fetch()}
        updating={data.operationState?.pending}
        updateDisabled={locked || !data.info || data.dirty}
      >
        <p className="text-xs">保存的模式在下次应用配置时使用。</p>
      </GeoDataView>
      {!data.modeBase && <p>尚未读取保存的模式；禁用的编辑初值不是当前运行模式。</p>}
      <p className="text-xs">
        当前编辑：{geoFields.find((field) => field.kind === data.kind)?.name}
      </p>
      {!!data.inventory?.incomplete && (
        <p role="alert">有 {data.inventory.incomplete} 项来源未完整读取。</p>
      )}
      {!!data.inventory?.warnings.length && <p role="alert">{data.inventory.warnings.join(' ')}</p>}
      <div className="relay-action">
        <button
          disabled={locked || (!data.info && !data.draft)}
          onClick={() => void (data.dirty ? data.discard() : data.read())}
        >
          {data.dirty ? '放弃修改并刷新' : '刷新来源'}
        </button>
        <button
          disabled={locked || !data.inventory || !!data.inventory.incomplete || !!data.info}
          onClick={data.create}
        >
          添加此类来源
        </button>
        <button disabled={formLocked || !data.dirty} onClick={() => void data.save()}>
          保存来源
        </button>
        {data.operationState?.operationId && (
          <button onClick={() => void data.cancel()}>取消更新</button>
        )}
      </div>
      {data.requiresRead && (
        <p>
          保存／获取后或结果未知，需要显式重读详情才可继续编辑；不会从安全摘要猜回完整地址或重试旧修订。
        </p>
      )}
      {data.dirty && <p className="text-xs">有未保存修改；保存或放弃后可切换数据库。</p>}
      {data.operationState?.pending && (
        <p>
          当前操作 {data.operationState.operationId}：{data.operationState.phase}
          。取消不提前释放在途工作。
        </p>
      )}
      {data.result && (
        <p role="status">
          来源结果：{data.result.status}；{data.result.warnings.join(' ')}
        </p>
      )}
      <details className="mt-4">
        <summary>高级：请求参数、缓存和自动更新授权</summary>
        <p>
          DB／DAT仅编辑受控草稿，继承会移除本项受控覆盖；保存后不会热载。地址为空只表示尚未读取，不能据此清空已保存来源。
        </p>
        {data.info && (
          <p>
            来源名称：{data.info.descriptor.name}；公开来源 {data.info.origin}；代理127.0.0.1:
            {data.info.proxyPort}；私有请求头{data.info.hasPrivateHeaders ? '有' : '无'}；定义修订{' '}
            {data.info.originRevision}。自动意图{data.info.autoIntent.requested ? '已请求' : '关闭'}
            。
          </p>
        )}
        {data.draft && (
          <fieldset disabled={formLocked} aria-label="当前私有来源草稿">
            <label>
              来源名称
              <input
                aria-label="Geo来源名称"
                value={data.draft.name}
                onChange={(e) => update('name', e.target.value)}
              />
            </label>
            <label>
              固定HTTP代理端口
              <input
                aria-label="Geo固定代理端口"
                inputMode="numeric"
                value={data.draft.port}
                onChange={(e) => update('port', e.target.value)}
              />
            </label>
            <label>
              核心校验选择器／ASN
              <input
                aria-label="Geo校验选择器"
                value={data.draft.selector}
                onChange={(e) => update('selector', e.target.value)}
              />
            </label>
            <label>
              私有请求头JSON
              <textarea
                aria-label="Geo私有请求头"
                value={data.draft.headers}
                onChange={(e) => update('headers', e.target.value)}
              />
            </label>
            <label>
              可选期望SHA256
              <input
                aria-label="Geo期望摘要"
                value={data.draft.expectedSHA256}
                onChange={(e) => update('expectedSHA256', e.target.value)}
              />
            </label>
            {data.draft.schedule.kind === 'cron' && !data.draft.hoursChanged && (
              <p>
                已保存cron：{data.draft.schedule.expression}
                ；小时字段不修改则保留原调度，修改后换为小时周期。
              </p>
            )}
          </fieldset>
        )}
        <div className="relay-action">
          <button disabled={data.schedulePending} onClick={() => void data.readSchedule()}>
            刷新自动更新状态
          </button>
          <button disabled={locked} onClick={() => void data.readMode()}>
            重新读取模式
          </button>
        </div>
        <h3>缓存head（不是活动证明）</h3>
        {head ? (
          <p>
            {head.resource.id}；SHA256 {head.resource.sha256}；
            {currentHead ? '与当前定义一致' : '属于旧定义，须重新获取检查'}；获取时间{' '}
            {head.acquiredAt}。历史配置仍指原快照。
          </p>
        ) : (
          <p>当前摘要尚无已检查缓存head；不会自动修复或接管已有活动数据库。</p>
        )}
        <h3>本次TUN活动代际</h3>
        <p>
          只有已确认新能力的当前自有会话可读取和独立确认替换；旧能力仅做缓存工作。没有匹配的活动类型不会新增它，未知会话不通过重读收养。
        </p>
        <p>所示head与代际来自最近一次读取／操作回执，不是实时状态；后台更新后需显式重读核对。</p>
        <button
          disabled={locked || !tunSessionId || data.quarantined === tunSessionId}
          onClick={() => void data.active(false)}
        >
          读取当前TUN活动资源
        </button>
        <button
          disabled={locked || !supported || !active?.active || !currentHead || data.dirty}
          onClick={() => void data.active(true)}
        >
          独立确认替换所选TUN活动数据
        </button>
        {data.snapshot && (
          <div>
            <p>
              会话 {data.snapshot.sessionId}；配置 {data.snapshot.configurationRevision}；活动代际{' '}
              {data.snapshot.generationSHA256}
            </p>
            <ul>
              {data.snapshot.resources.map((r) => (
                <li key={r.kind}>
                  {r.kind}：{r.active ? '活动' : '未活动'}，{r.bytes}字节，SHA256 {r.sha256}
                </li>
              ))}
            </ul>
          </div>
        )}
        {data.activeNotice && <p role="status">{data.activeNotice}</p>}
        <h3>本会话周期权限（重启／恢复不继承）</h3>
        <p>下拉只是下一次授权草稿；修改不会改变已有授权，须停用或重新点击启动。</p>
        <label>
          授权目标
          <select
            aria-label="Geo自动授权目标"
            disabled={locked}
            value={data.target}
            onChange={(e) => data.setTarget(e.target.value === 'tun' ? 'tun' : 'cache')}
          >
            <option value="cache">仅获取、检查并更新缓存head</option>
            <option value="tun" disabled={!supported || !active?.active}>
              缓存并替换本次匹配TUN活动类型
            </option>
          </select>
        </label>
        <button
          disabled={
            locked ||
            !data.info ||
            !data.info.autoIntent.requested ||
            data.dirty ||
            (data.target === 'tun' && (!supported || !active?.active))
          }
          onClick={() => void data.arm()}
        >
          启动本次周期更新
        </button>
        <button
          disabled={!data.info}
          onClick={() => {
            if (data.info) void data.disarm(data.info.id)
          }}
        >
          停用当前来源本次授权
        </button>
        {data.schedule ? (
          <div>
            <p>
              本会话调度{data.schedule.pending ? '正在工作' : '当前空闲'}；挂起{' '}
              {data.schedule.suspended ? '是' : '否'}。
            </p>
            <ul>
              {data.schedule.entries.map((entry) => (
                <li key={entry.id}>
                  {entry.name} · {entry.enabled ? '本会话已授权' : '已停用'} ·{' '}
                  {entry.target.kind === 'cache' ? '仅缓存' : `TUN ${entry.target.sessionId}`} ·
                  下次 {entry.nextAt ?? '无'} · 最近状态 {entry.lastStatus ?? '无'}{' '}
                  <button onClick={() => void data.disarm(entry.id)}>停用此来源授权</button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p>尚未读取本会话状态；不根据保存的自动意图声称已运行。</p>
        )}
      </details>
      {data.notice && <p role="status">{data.notice}</p>}
    </section>
  )
}
