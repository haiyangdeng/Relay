export interface CompleteConfigurationPlan {
  evidenceId: string
  profileId: string
  configurationSHA256: string
  bundleSHA256: string
  readyForParserCheck: boolean
  stageOrder: string[]
  scriptLogLines: number
  dns: { requested: boolean; effective: boolean; autoDisabled: boolean; fingerprint?: string }
  dependencies: { id: string; kind: string; resolved: boolean }[]
  resources: number
  active: false
  warnings: string[]
}
export interface CompleteConfigurationResult {
  status: 'passed' | 'rejected' | 'unavailable' | 'cancelled' | 'uncertain'
  scope: 'complete-parser'
  configurationSHA256: string
  coreVersion?: string
  active: false
  runtimeAccepted: false
  warnings: string[]
}
