export function errorMessage(error: unknown, fallback = '操作未完成，请重试。'): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return (
    message.replace(/^Error invoking remote method '[^'\r\n]+':\s*(?:Error:\s*)?/u, '').trim() ||
    fallback
  )
}
