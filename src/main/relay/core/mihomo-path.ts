// With a canonical URL Go can discard RawPath. Chi then uses the decoded path,
// and Mihomo's getEscapeParam unescapes it again. Keep RawPath when a literal
// escape-looking name (e.g. "Policy%2F") could otherwise identify another group.
export function mihomoPathSegment(name: string): string {
  if (!/%[0-9a-f]{2}/iu.test(name)) return encodeURIComponent(name)
  return [...Buffer.from(name)].map((byte) => '%' + byte.toString(16).padStart(2, '0')).join('')
}
