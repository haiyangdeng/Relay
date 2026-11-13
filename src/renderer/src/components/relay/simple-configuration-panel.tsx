import type { SimplePanelController, SimplePanelState } from './simple-panel-state'

export function SimpleConfigurationPanel({
  state,
  controller,
  busy
}: {
  state: SimplePanelState
  controller: SimplePanelController
  busy: boolean
}): React.JSX.Element {
  const locked = busy || state.pending || state.needsRecovery,
    snapshot = state.configurationSnapshot,
    candidate = snapshot?.candidate
  return (
    <div className="relay-simple-configuration">
      <h3>共享配置绑定</h3>
      <p>
        先查看固定版本，再明确采用或解除。此处只显示版本与共享键名；不会读取到表单中、修改或启用配置内容。
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void controller.readConfigurationBinding()}>
          查看共享配置绑定与候选版本
        </button>
      </div>
      {snapshot && (
        <>
          <p>草稿共享版本：{snapshot.configurationRevision || '未绑定（使用空共享配置）'}</p>
          {candidate?.status === 'available' ? (
            <>
              <p>
                本次查看的候选：{candidate.configurationRevision} · 共享项：
                {candidate.keys.join('、') || '无'}
              </p>
              <div className="relay-action">
                <button disabled={locked} onClick={() => void controller.bindViewedConfiguration()}>
                  明确采用此候选版本
                </button>
              </div>
            </>
          ) : (
            <p>
              {candidate?.status === 'missing'
                ? '尚无共享配置候选。'
                : '共享配置候选未确认；可以解除已有草稿绑定。'}
            </p>
          )}
          <div className="relay-action">
            <button
              disabled={locked || !snapshot.configurationRevision}
              onClick={() => void controller.unbindConfiguration()}
            >
              明确解除草稿共享绑定
            </button>
          </div>
          <p>
            仅修改草稿绑定；保留模块、来源和历史发布状态。采用共享项可能覆盖预览中的
            DNS、Hosts、嗅探及 geodata-mode。
          </p>
        </>
      )}
    </div>
  )
}
