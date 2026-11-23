import { Button } from '@heroui/react'
import { useEffect, useRef, useState } from 'react'
import { FaLocationCrosshairs } from 'react-icons/fa6'
import { MdOutlineSpeed } from 'react-icons/md'
import { IoChevronDown } from 'react-icons/io5'
import { Link } from 'react-router-dom'
import CollapseInput from '@renderer/components/base/collapse-input'
import { errorMessage } from '@renderer/utils/error-message'
import { probeMeasurementSummary } from '../../../../shared/relay/isolated-probes'
import type { RelayStoredProfile } from '../../../../shared/relay/profiles'
import type {
  IsolatedProbeResult,
  IsolatedProbeState
} from '../../../../shared/relay/isolated-probes'
import type { CachedProxyGroup } from './proxy-library-model'
import { executeIsolatedProbe } from './isolated-probe-action'

const invoke = (channel: string, input?: unknown): Promise<unknown> =>
  window.electron.ipcRenderer.invoke(channel, input)

export function RelayCachedProxyGroup({
  group,
  profile,
  locked,
  selectedMember,
  canSelect,
  onSelect,
  beginProbe,
  endProbe
}: {
  group: CachedProxyGroup
  profile: RelayStoredProfile
  locked: boolean
  selectedMember?: string
  canSelect(member: string): boolean
  onSelect(member: string): void
  beginProbe(): boolean
  endProbe(): void
}): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const [needsCleanup, setNeedsCleanup] = useState(false)
  const [measurements, setMeasurements] = useState<
    Map<string, IsolatedProbeResult['measurements'][number]>
  >(new Map())
  const mounted = useRef(true)
  const cancelled = useRef(false)
  const runningId = useRef<string | undefined>(undefined)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      cancelled.current = true
      if (runningId.current)
        void invoke('relayIsolatedProbeCancel', { evidenceId: runningId.current }).catch(() => {})
    }
  }, [])

  const members = group.members.filter((member) =>
    member.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  )
  const additionalMembers = [...measurements].filter(
    ([name]) => !group.members.some((member) => member.name === name)
  )
  const test = async (): Promise<void> => {
    if (locked || !beginProbe()) return
    cancelled.current = false
    setOpen(true)
    setPending(true)
    setMeasurements(new Map())
    setNeedsCleanup(false)
    setNotice('正在检查环境并测速…')
    try {
      const state = (await invoke('relayIsolatedProbeState')) as IsolatedProbeState
      if (state.pending || state.uncertain) {
        setNeedsCleanup(true)
        throw new Error('已有探测正在执行或需要收尾，请先在网络信息中处理。')
      }
      const result = await executeIsolatedProbe(
        {
          profile: { id: profile.id, sha256: profile.sha256 },
          target: group.name,
          kind: 'groupDelay',
          provider: 'ip.sb'
        },
        invoke,
        {
          cancelled: () => cancelled.current || !mounted.current,
          prepared: (plan) => {
            runningId.current = plan.evidenceId
          }
        }
      )
      if (!mounted.current) return
      if (cancelled.current || result.status === 'cancelled') {
        setNotice('已取消测速。')
      } else {
        setMeasurements(new Map(result.measurements.map((row) => [row.name, row])))
        setNotice(probeMeasurementSummary(result))
      }
    } catch (error) {
      if (mounted.current) setNotice(errorMessage(error, '测速未完成，请重试。'))
    } finally {
      runningId.current = undefined
      try {
        const state = (await invoke('relayIsolatedProbeState')) as IsolatedProbeState
        if (mounted.current) setNeedsCleanup(state.uncertain || state.pending)
      } catch {
        if (mounted.current) setNeedsCleanup(true)
      }
      if (mounted.current) setPending(false)
      endProbe()
    }
  }
  const cancel = (): void => {
    cancelled.current = true
    setNotice('正在取消测速…')
    if (runningId.current)
      void invoke('relayIsolatedProbeCancel', { evidenceId: runningId.current }).catch(() => {
        if (mounted.current) {
          setNeedsCleanup(true)
          setNotice('取消状态未确认，请在网络信息中核对。')
        }
      })
  }

  return (
    <section
      className="rounded-xl border border-default-200 bg-content1 overflow-hidden"
      data-relay-cached-group={group.name}
      aria-label={`代理组 ${group.name}`}
    >
      <div className="flex flex-wrap items-center gap-1 px-3 py-2 min-h-14">
        <button
          type="button"
          className="flex-1 min-w-20 text-left py-1"
          aria-label={`${open ? '收起' : '展开'} ${group.name}`}
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="block truncate text-sm font-medium">{group.name}</span>
          <span className="text-default-500 text-xs">
            {group.typeLabel} · {search ? `${members.length} / ` : ''}
            {group.totalMembers} 个声明成员{selectedMember ? ` · 已选 ${selectedMember}` : ''}
          </span>
        </button>
        <div className="flex items-center ml-auto">
          <CollapseInput
            title={`搜索 ${group.name} 节点`}
            aria-label={`搜索 ${group.name} 节点`}
            value={search}
            onFocus={() => setOpen(true)}
            onValueChange={(value) => {
              setSearch(value)
              setOpen(true)
            }}
          />
          <span title="代理运行后可定位当前节点。">
            <Button
              aria-label={`定位 ${group.name} 当前节点`}
              isIconOnly
              isDisabled
              size="sm"
              variant="light"
            >
              <FaLocationCrosshairs className="text-lg text-foreground-500" />
            </Button>
          </span>
          <Button
            title="测速已保存的静态节点（不切换当前节点）"
            aria-label={`测速 ${group.name}`}
            isIconOnly
            size="sm"
            variant="light"
            isDisabled={locked}
            isLoading={pending}
            onPress={() => void test()}
          >
            <MdOutlineSpeed className="text-lg text-foreground-500" />
          </Button>
          <Button
            aria-label={`${open ? '收起' : '展开'} ${group.name} 节点`}
            aria-expanded={open}
            isIconOnly
            size="sm"
            variant="light"
            onPress={() => setOpen((value) => !value)}
          >
            <IoChevronDown className={`text-lg text-foreground-500 ${open ? '' : '-rotate-90'}`} />
          </Button>
        </div>
      </div>
      {open && (
        <>
          <div className="px-3 pb-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
            {members.map((member) => {
              const measured = measurements.has(member.name)
              const measurement = measurements.get(member.name)
              const delay = measurement?.milliseconds
              return (
                <button
                  key={member.name}
                  type="button"
                  aria-pressed={selectedMember === member.name}
                  disabled={locked || !canSelect(member.name)}
                  onClick={() => onSelect(member.name)}
                  className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-default-100 px-3 py-2 text-left text-sm aria-pressed:bg-primary/20 aria-pressed:ring-1 aria-pressed:ring-primary"
                  title={member.name}
                >
                  <span className="truncate">{member.name}</span>
                  <span
                    title={measurement?.error}
                    className={`shrink-0 text-xs ${measured && delay !== null ? 'text-success' : 'text-default-400'}`}
                  >
                    {measured
                      ? measurement?.error
                        ? '失败'
                        : delay === null
                          ? '超时'
                          : `${delay} ms`
                      : member.kind === 'group'
                        ? '代理组'
                        : member.kind === 'builtin'
                          ? '内置'
                          : member.kind === 'unknown'
                            ? '未解析'
                            : '未测速'}
                  </span>
                </button>
              )
            })}
          </div>
          {!members.length && (
            <p className="px-3 pb-3 text-xs text-default-500">没有匹配的节点。</p>
          )}
          {group.unresolved && (
            <p className="px-3 pb-3 text-xs text-default-500">
              {group.unresolvedReasons.join('；')}。
            </p>
          )}
          {additionalMembers.length > 0 && (
            <div className="px-3 pb-3 text-xs space-y-1" aria-label="组内其他直属成员测速结果">
              <p className="text-default-500">组内其他直属成员</p>
              {additionalMembers.map(([name, measurement]) => (
                <div key={name} className="flex justify-between gap-2">
                  <span className="truncate">{name}</span>
                  <span
                    title={measurement.error}
                    className={
                      measurement.milliseconds === null ? 'text-default-400' : 'text-success'
                    }
                  >
                    {measurement.error
                      ? '失败'
                      : measurement.milliseconds === null
                        ? '超时'
                        : `${measurement.milliseconds} ms`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {(notice || pending || needsCleanup) && (
        <div className="px-3 pb-3 flex flex-wrap items-center gap-2 text-xs">
          <p role="status">{notice}</p>
          {pending && (
            <Button size="sm" variant="flat" onPress={cancel}>
              取消测速
            </Button>
          )}
          {needsCleanup && (
            <Link to="/relay?panel=network" className="text-primary">
              查看探测收尾
            </Link>
          )}
        </div>
      )}
    </section>
  )
}
