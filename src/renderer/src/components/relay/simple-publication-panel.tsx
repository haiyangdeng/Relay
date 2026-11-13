import type { SimplePanelController, SimplePanelState } from './simple-panel-state'
import { hasUnsavedModules, isPublicationBlocking } from './simple-panel-state'
import { mayAbandonPublication, publicationDescription } from './simple-publication-state'

export function SimplePublicationPanel({
  state,
  controller,
  busy
}: {
  state: SimplePanelState
  controller: SimplePanelController
  busy: boolean
}): React.JSX.Element {
  const locked = busy || state.pending,
    pub = state.publicationState,
    mayPrepare =
      !!state.modules &&
      !hasUnsavedModules(state) &&
      !state.moduleRevisionStale &&
      !state.needsRecovery &&
      !state.sourceForm &&
      !!state.metadata &&
      !!state.preview?.valid &&
      !!state.name.trim() &&
      !!pub?.initialized &&
      !isPublicationBlocking(state)
  return (
    <div className="relay-simple-publication">
      <h3>发布固定版本</h3>
      <p>
        发布会记录固定历史版本并保留独立配置副本。另存副本按钮只另存，不发布；均不自动启用配置。
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void controller.readPublicationState()}>
          查看发布状态
        </button>
        <button
          disabled={locked || !!pub?.pending || !!pub?.closing}
          onClick={() => void controller.recoverPublication()}
        >
          只读核对发布记录
        </button>
      </div>
      {state.publicationReadInvalid && (
        <p>发布摘要未确认；保留现场并阻止新写入。请显式查看或只读核对，不会自动恢复。</p>
      )}
      {pub ? (
        <p>{publicationDescription(pub)}</p>
      ) : (
        <p>尚未显式查看本次发布状态，不会自动读取或继续未完成事务。</p>
      )}
      {state.publicationNeedsInspection && (
        <p>
          发布持久状态尚需显式核对；普通写入、预览及另存保持等待，不会用草稿恢复按钮清除发布记录。
        </p>
      )}
      <div className="relay-action">
        <button
          disabled={locked || !mayPrepare}
          onClick={() => void controller.preparePublication(true)}
        >
          发布已保存草稿
        </button>
      </div>
      {state.publicationPreparation && (
        <p>
          正在执行操作 {state.publicationPreparation.operationId} · SHA256{' '}
          {state.publicationPreparation.preparation.sha256}。编辑或其它操作会退役本次发布准备。
        </p>
      )}
      {pub?.operationId && (
        <p>
          记录操作：{pub.operationId} · 标记版本：{pub.markerRevision || '未确认'}
        </p>
      )}
      {pub?.profile && (
        <p>
          已知配置副本：{pub.profile.id} · SHA256 {pub.profile.sha256}
        </p>
      )}
      {mayAbandonPublication(pub) && (
        <div className="relay-action">
          <button disabled={locked} onClick={() => void controller.abandonPublication()}>
            {pub?.classification === 'complete' && pub.needsRetirement
              ? '明确收尾已完成发布记录'
              : '明确放弃未完成意图（保留全部副本）'}
          </button>
        </div>
      )}
      <p>
        放弃只处理本次意图，不删除任何Profile、旧历史或恢复磁盘文件，不称作回滚。副本身份未确认或记录不确定时保留现场。
      </p>
      {state.publicationResult && (
        <p>
          {state.publicationResult.status === 'published'
            ? '回执已确认发布事实'
            : state.publicationResult.status === 'abandoned'
              ? '回执已确认放弃意图'
              : '回执仍需核对'}{' '}
          · 操作 {state.publicationResult.operationId}
          {state.publicationResult.needsRecovery ? ' · 记录收尾待核对' : ''} · 未自动启用配置
        </p>
      )}
    </div>
  )
}
