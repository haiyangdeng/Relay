import { mkdtemp, realpath, mkdir, writeFile, rm, symlink } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  captureProtectedConfiguration,
  captureSystemRuntime,
  compareProtectedConfiguration,
  hostRestorationAccepted,
  probeClaudeTransport,
  sameClaudeTransport
} from './acceptance'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})
async function fixture(): Promise<string> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-acceptance-'))
  homes.push(home)
  return home
}
async function save(home: string, relative: string, value: string): Promise<void> {
  const path = join(home, relative)
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { mode: 0o600 })
}
describe('Host restoration acceptance observes existing protection without rewriting it', () => {
  it('records absence and protected hashes without exposing bodies or creating configuration', async () => {
    const home = await fixture()
    await save(home, '.claude/settings.json', '{"env":{"PRIVATE_TOKEN":"SECRET"}}')
    const before = await captureProtectedConfiguration(home, 'a'.repeat(64)),
      after = await captureProtectedConfiguration(home, 'a'.repeat(64))
    expect(compareProtectedConfiguration(before, after)).toEqual([])
    expect(JSON.stringify(before)).not.toContain('SECRET')
    expect(JSON.stringify(before)).not.toContain(home)
    expect(before.entries.find((entry) => entry.label === 'codex-settings')?.exists).toBe(false)
  })
  it('detects changed Code settings, effective Clash data and new provider/override sources', async () => {
    const home = await fixture(),
      before = await captureProtectedConfiguration(home, 'a'.repeat(64))
    await save(home, '.claude/settings.json', '{}')
    await save(
      home,
      'Library/Application Support/mihomo-party/work/config.yaml',
      'dns: {enable: true}'
    )
    await save(
      home,
      'Library/Application Support/mihomo-party/overrides/private.js',
      'const SECRET = 1'
    )
    const after = await captureProtectedConfiguration(home, 'b'.repeat(64))
    expect(compareProtectedConfiguration(before, after)).toEqual([
      'clash-overrides-inventory',
      'clash-work/config.yaml',
      'claude-code-settings',
      'edge-known-managed-policies'
    ])
    expect(JSON.stringify(after)).not.toContain('SECRET')
  })
  it('tracks browser DNS/WebRTC/proxy fields while ignoring unrelated live browser metadata', async () => {
    const home = await fixture(),
      path = 'Library/Application Support/Claude Private Browser/Default/Preferences'
    await save(
      home,
      path,
      JSON.stringify({ webrtc: { ip_handling_policy: 'disable_non_proxied_udp' }, window: 1 })
    )
    const before = await captureProtectedConfiguration(home, 'a'.repeat(64))
    await save(
      home,
      path,
      JSON.stringify({ window: 2, webrtc: { ip_handling_policy: 'disable_non_proxied_udp' } })
    )
    expect(
      compareProtectedConfiguration(
        before,
        await captureProtectedConfiguration(home, 'a'.repeat(64))
      )
    ).toEqual([])
    await save(home, path, JSON.stringify({ webrtc: { ip_handling_policy: 'default' } }))
    expect(
      compareProtectedConfiguration(
        before,
        await captureProtectedConfiguration(home, 'a'.repeat(64))
      )
    ).toEqual(['legacy-chrome-webrtc'])
  })
  it('rejects symlinks instead of following a replaced configuration source', async () => {
    const home = await fixture()
    await save(home, 'private', '{}')
    await mkdir(join(home, '.claude'), { mode: 0o700 })
    await symlink(join(home, 'private'), join(home, '.claude/settings.json'))
    await expect(captureProtectedConfiguration(home, 'a'.repeat(64))).rejects.toThrow('未确认')
  })
  it('uses only the explicit local proxy, strips curl defaults, and does not execute authenticated requests or retry failures', async () => {
    const run = vi.fn(async (_arguments: string[]) => '404')
    const before = await probeClaudeTransport(7890, run)
    expect(run).toHaveBeenCalledTimes(2)
    for (const [args] of run.mock.calls) {
      expect(args).toContain('-q')
      expect(args).toContain('--noproxy')
      expect(args).toContain('http://127.0.0.1:7890')
      expect(args).not.toContain('-k')
      expect(args).not.toContain('--location')
      expect(args).not.toContain('--header')
    }
    expect(sameClaudeTransport(before, await probeClaudeTransport(7890, run))).toBe(true)
    const failed = vi.fn(async () => {
      throw new Error('PRIVATE')
    })
    await expect(probeClaudeTransport(7890, failed)).rejects.toThrow('不直连重试')
    expect(failed).toHaveBeenCalledOnce()
  })
  it('never accepts proxy restoration alone, an unclosed PAC or a preflight-only run as complete', () => {
    const success = {
      submitted: true,
      proxyRestored: true,
      configurationUnchanged: true,
      systemRuntimeRestored: true,
      transportRestored: true,
      temporaryResourcesClosed: true,
      checksPassed: true
    }
    expect(hostRestorationAccepted(success)).toBe(true)
    for (const key of Object.keys(success))
      expect(hostRestorationAccepted({ ...success, [key]: false })).toBe(false)
  })
  it('requires recognizable runtime reads and stores only effective proxy/DNS digests', async () => {
    const run = vi.fn(async (argument: '--proxy' | '--dns') =>
      argument === '--proxy' ? '<dictionary> { PRIVATE_PROXY }' : 'DNS configuration\nPRIVATE_DNS'
    )
    const snapshot = await captureSystemRuntime(run)
    expect(snapshot.effectiveProxyRevision).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE')
    await expect(
      captureSystemRuntime(async () => 'AuthorizationCreate() failed: -60008')
    ).rejects.toThrow('未确认')
  })
})
