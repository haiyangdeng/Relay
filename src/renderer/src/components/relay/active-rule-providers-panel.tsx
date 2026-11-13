import { Button, Input } from '@heroui/react'
import SettingCard from '../base/base-setting-card'
import { includesIgnoreCase } from '../../utils/includes'
import { useRelayActiveRuleProviders } from '../../hooks/use-relay-active-rule-providers'

export function RelayActiveRuleProvidersPanel({
  busy,
  onBusy,
  tunSessionId
}: {
  busy: boolean
  onBusy(value: boolean): void
  tunSessionId?: string
}): React.JSX.Element {
  const data = useRelayActiveRuleProviders({ busy, onBusy, tunSessionId }),
    locked = busy || data.pending,
    row = data.rows.find((item) => item.name === data.provider),
    matches = row
      ? data.resources.filter((item) => item.kind === row.kind && item.behavior === row.behavior)
      : [],
    selected = matches.find((item) => item.id === data.resourceId),
    linked = data.groups.find((group) => group.includes(data.provider)) ?? [],
    available = !!tunSessionId && !data.quarantined
  return (
    <section className="relay-panel" aria-label="活动规则提供者">
      <h2>当前自有TUN · 规则提供者运行文件</h2>
      <p>
        读取当前会话的规则提供者，并用已缓存且格式、行为相同的正文替换。替换可能改变新连接的规则匹配；共享同一文件的整组提供者都会受到影响。
      </p>
      <div className="relay-action">
        <Button isDisabled={locked || !available} onPress={() => void data.read()}>
          读取当前提供者回执
        </Button>
        <Button isDisabled={locked} onPress={() => void data.listCache()}>
          读取规则缓存摘要
        </Button>
      </div>
      {!tunSessionId && <p>尚未有符合条件的当前自有TUN会话；没有探测或自动读取。</p>}
      {data.quarantined && (
        <p role="alert">本会话已隔离，清空或重新打开界面不能解除；不会采纳未知结果或自动重试。</p>
      )}
      <SettingCard>
        <Input
          aria-label="筛选活动提供者"
          value={data.filter}
          onValueChange={data.setFilter}
          isDisabled={locked}
        />
        {data.rows
          .filter((item) => includesIgnoreCase(item.name, data.filter))
          .map((item) => (
            <div
              key={item.name}
              className="flex min-w-0 items-center gap-2 border-b border-divider py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="break-words">{item.name}</div>
                <div className="text-xs text-foreground-500">
                  {item.kind} · {item.behavior} · {item.ruleCount}条 · {item.bytes}字节
                </div>
              </div>
              <Button
                isDisabled={locked}
                aria-pressed={data.provider === item.name}
                onPress={() => data.chooseProvider(item.name)}
              >
                选择 {item.name}
              </Button>
            </div>
          ))}
        {!data.rows.length && <p>尚无已读提供者列表；未默认选中首项。</p>}
      </SettingCard>
      {row && (
        <div>
          <p>
            已选择：{row.name}；同组所有名称：{linked.join('、')}。一次发布可能影响该组全部提供者。
          </p>
          <p>
            上次读取的本地运行文件SHA256（不是Core内存摘要）：<code>{row.fileSHA256}</code>
          </p>
          <label>
            匹配的私有规则缓存
            <select
              aria-label="匹配规则缓存"
              value={data.resourceId}
              disabled={locked}
              onChange={(event) => data.chooseResource(event.target.value)}
            >
              <option value="">请选择</option>
              {matches.map((item) => (
                <option key={`${item.id}:${item.sha256}`} value={item.id}>
                  {item.name} · {item.kind} · {item.behavior} · {item.sha256}
                </option>
              ))}
            </select>
          </label>
          {!matches.length && <p>没有同格式和行为的缓存；仅读取缓存摘要，不会自动转换或下载。</p>}
        </div>
      )}
      <Button
        isDisabled={locked || !available || !data.snapshot || !row || !selected}
        onPress={() => void data.replace()}
      >
        确认替换运行文件…
      </Button>
      <Button isDisabled={locked || !available || !row || !selected} onPress={data.enqueue}>
        加入待替换列表
      </Button>
      {data.queue.length > 0 && (
        <div>
          <p>按顺序逐个替换运行文件。取消或遇到异常时，后续项目不会提交，已完成的项目保留。</p>
          <ul>
            {data.queue.map(({ provider, resource }) => (
              <li key={provider}>
                {provider} · {resource.name} · <code>{resource.sha256}</code>{' '}
                <Button size="sm" isDisabled={locked} onPress={() => data.removeQueued(provider)}>
                  移出 {provider}
                </Button>
              </li>
            ))}
          </ul>
          <Button
            isDisabled={locked || !available || !data.snapshot}
            onPress={() => void data.replaceQueue()}
          >
            逐项确认替换列表…
          </Button>
        </div>
      )}
      {!data.snapshot && data.rows.length > 0 && (
        <p>选择变化已撤销操作回执；以上为上次列表，仅供选择，请显式重新读取。</p>
      )}
      {data.snapshot && (
        <p>
          已读配置修订 {data.snapshot.configurationRevision}；提供者代际{' '}
          {data.snapshot.generationSHA256}。
        </p>
      )}
      {data.readAt && (
        <p>读取时间：{new Date(data.readAt).toISOString()}；缓存摘要与活动文件分别核对。</p>
      )}
      {data.notice && <p role="status">{data.notice}</p>}
    </section>
  )
}
