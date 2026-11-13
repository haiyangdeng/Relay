import type { DedicatedListenerSummary } from './dedicated-listeners'

export interface AiClientAssociation {
  owned: {
    instanceId: string | undefined
    configurationRevision: string | undefined
    running: boolean
    pid: number | undefined
    httpPort: number | undefined
    dedicated: DedicatedListenerSummary | undefined
    httpLive: boolean
    socksLive: boolean
  }
  claudeCode: {
    // The port the caller intends to write into ~/.claude/settings.json env.
    requestedPort: number | undefined
    // True only for a live fixed-node dedicated HTTP listener. False => Code configuration must be
    // refused (no live owned entry to associate with).
    listenerLive: boolean
    refusesIfNotLive: true
  }
  codex: {
    configPath: string
    exists: boolean
    neverWrites: true
  }
  browserProxy: {
    httpPort: number | undefined
    ownedLive: boolean
    note: string
  }
  loopbackDirect: {
    // Login callbacks to 127.0.0.1 stay direct: the client env NO_PROXY merge
    // always contains loopback; the dedicated listeners never capture loopback
    // because the OS routes 127.0.0.1 connections directly.
    containsLoopback: true
    regression: string
  }
  warnings: string[]
}
