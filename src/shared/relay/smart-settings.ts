export const SMART_COLLECTOR_DEFAULT_MIB = 100

// Fixed Smart Core uses MiB. Keep the upstream positive integer setting while
// rejecting values whose byte conversion cannot be represented exactly in JS.
export function smartCollectorSizeMiB(raw: unknown): number {
  if (
    typeof raw !== 'number' ||
    !Number.isSafeInteger(raw) ||
    raw < 1 ||
    !Number.isSafeInteger(raw * 1024 * 1024)
  )
    throw new Error('Smart采样文件大小必须为正整数MiB，且换算字节后仍为安全整数。')
  return raw
}
