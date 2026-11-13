import type {
  SubscriptionPreparation,
  SubscriptionState
} from '../../../../shared/relay/subscription'
import type { RelayProfilePreparation } from '../../../../shared/relay/profiles'

export function RelaySubscriptionPanel({
  name,
  url,
  proxyPort,
  preparation,
  profile,
  state,
  busy,
  notice,
  onName,
  onURL,
  onPort,
  onPrepare,
  onCancel
}: {
  name: string
  url: string
  proxyPort: number
  preparation?: SubscriptionPreparation
  profile?: RelayProfilePreparation
  state?: SubscriptionState
  busy: boolean
  notice: string
  onName(value: string): void
  onURL(value: string): void
  onPort(value: number): void
  onPrepare(): void
  onDownload(): void
  onSave(): void
  onCancel(): void
}): React.JSX.Element {
  const pending = busy || state?.pending
  return (
    <section className="relay-panel relay-profiles">
      <h2>订阅快照导入 · 手动下载</h2>
      <p>
        仅支持Clash
        YAML／JSON，明确通过指定的本地HTTP代理请求，不自动回退直连。下载内容检查通过后保存为未启用副本。不持久保存订阅URL、不定时更新、不加载提供者或切换网络。
      </p>
      <label>
        副本名称
        <input
          value={name}
          maxLength={120}
          disabled={!!pending}
          onChange={(event) => onName(event.target.value)}
        />
      </label>
      <label>
        订阅地址（可能含凭据）
        <input
          type="password"
          value={url}
          maxLength={4096}
          autoComplete="off"
          spellCheck={false}
          disabled={!!pending}
          onChange={(event) => onURL(event.target.value)}
        />
      </label>
      <label>
        本地HTTP代理端口
        <input
          type="number"
          min={1024}
          max={65535}
          value={Number.isFinite(proxyPort) ? proxyPort : ''}
          disabled={!!pending}
          onChange={(event) => onPort(Number(event.target.value))}
        />
      </label>
      <p>
        不会验证代理端口归属。请指定可信的Relay自有HTTP端口或已配置的本地代理。点击导入后发出一次请求，限15秒、2MiB。本阶段不跟随重定向，不支持压缩或URI／Base64节点订阅。准备及下载检查结果保留60秒。
      </p>
      {preparation && (
        <p>
          正在导入：{preparation.name} · {preparation.origin} · 127.0.0.1:{preparation.proxyPort}
          （路径／查询参数不回显）
        </p>
      )}
      <div className="relay-action">
        <button disabled={!!pending || !name.trim() || !url} onClick={onPrepare}>
          下载并导入订阅
        </button>
        <button
          disabled={
            state?.phase === 'saving' ||
            !(state?.operationId || state?.stagedId || state?.preparedId || preparation)
          }
          onClick={onCancel}
        >
          取消本次请求／丢弃检查结果
        </button>
      </div>
      {profile && (
        <p>
          下载结构已检查 · {profile.bytes}字节 · SHA256：{profile.sha256} · 核心兼容性未验证，未启用
        </p>
      )}
      {state?.phase === 'saving' && (
        <p>正在保存私有副本，请等待同步结束；取消不会打断正在进行的写入。</p>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
