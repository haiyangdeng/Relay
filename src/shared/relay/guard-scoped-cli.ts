export interface ScopedCLIState {
  phase: 'idle' | 'starting' | 'running' | 'exited' | 'stopping' | 'uncertain' | 'blocked'
  pending: boolean
  output: string
  truncated: boolean
  exitCode?: number
  protectionVerified: false
  scope: 'explicitNormalTLSProcessTree'
}
export function scopedCLIRequest(raw: unknown): { prompt: string; apiKey: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('受限 CLI 请求无效。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',') !== 'apiKey,prompt' ||
    typeof value.prompt !== 'string' ||
    !value.prompt.trim() ||
    BufferLength(value.prompt) > 16384 ||
    value.prompt.includes('\0') ||
    typeof value.apiKey !== 'string' ||
    value.apiKey.length < 1 ||
    value.apiKey.length > 4096 ||
    /[\r\n\0]/u.test(value.apiKey)
  )
    throw new Error('只接受本次提示与内存 API key，不接受路径、命令或就绪标记。')
  return { prompt: value.prompt, apiKey: value.apiKey }
}
const BufferLength = (value: string): number => new TextEncoder().encode(value).length

export function scopedCLIState(raw: unknown): ScopedCLIState {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('CLI 状态未确认。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).some(
      (key) =>
        ![
          'phase',
          'pending',
          'output',
          'truncated',
          'exitCode',
          'protectionVerified',
          'scope'
        ].includes(key)
    ) ||
    !['idle', 'starting', 'running', 'exited', 'stopping', 'uncertain', 'blocked'].includes(
      String(value.phase)
    ) ||
    typeof value.pending !== 'boolean' ||
    typeof value.output !== 'string' ||
    value.output.length > 32768 ||
    typeof value.truncated !== 'boolean' ||
    (value.exitCode !== undefined &&
      (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode))) ||
    value.protectionVerified !== false ||
    value.scope !== 'explicitNormalTLSProcessTree'
  )
    throw new Error('受限 CLI 回执不可确认。')
  return {
    phase: value.phase as ScopedCLIState['phase'],
    pending: value.pending,
    output: value.output,
    truncated: value.truncated,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode as number }),
    protectionVerified: false,
    scope: 'explicitNormalTLSProcessTree'
  }
}
