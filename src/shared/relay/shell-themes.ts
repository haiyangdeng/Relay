import type { RelayShellTheme } from './shell'

export const officialThemeURL =
  'https://github.com/mihomo-party-org/theme-hub/releases/download/latest/themes.zip'
export interface OnlineThemeSummary {
  path: string
  name: string
  size: number
  sha256: string
}
export interface UnsupportedThemeSummary {
  path: string
  declaredSize: number
  reason: 'css-too-large' | 'invalid-theme-text' | 'name-conflict'
  crcAndLengthVerified: boolean
  utf8AndCSSVerified: boolean
}
export type OnlineThemeResult =
  | { status: 'cancelled' }
  | {
      status: 'ready'
      acquisitionId: string
      sourceURL: string
      archiveSHA256: string
      archiveSize: number
      candidates: OnlineThemeSummary[]
      unsupported: UnsupportedThemeSummary[]
    }
export interface OnlineThemeDraftRequest {
  acquisitionId: string
  path: string
  themes: RelayShellTheme[]
}
