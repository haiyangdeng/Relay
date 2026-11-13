import { resolve, sep } from 'path'
import { fileURLToPath } from 'url'

export function allowedPreviewRequest(raw: string, root: string): boolean {
  if (raw.startsWith('data:') || raw.startsWith('blob:') || raw.startsWith('devtools:')) return true
  try {
    const url = new URL(raw)
    if (url.protocol !== 'file:' || url.hostname) return false
    const path = resolve(fileURLToPath(url))
    return path.startsWith(resolve(root) + sep)
  } catch {
    return false
  }
}
