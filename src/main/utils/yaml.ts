import yaml from 'yaml'

export function normalizeShortIds(content: string): string {
  return content.replace(
    /(^|\{|,)(\s*short-id:\s*)(?!['"]|null\b|Null\b|NULL\b|~)([^"'\s,}\n]+)/gm,
    '$1$2"$3"'
  )
}

export const parse = <T = unknown>(content: string): T => {
  return (yaml.parse(normalizeShortIds(content), { merge: true }) as T) || ({} as T)
}

export function stringify(content: unknown): string {
  return yaml.stringify(content)
}
