import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  LegacyClashMigrationReport,
  LegacySubStoreSummary
} from '../../../../shared/relay/legacy-clash'
import type { LegacyRelayMigrationReport } from '../../../../shared/relay/legacy-relay'
import {
  RelayBackupPanel,
  LegacySubStoreMigrationSummary,
  LegacyRelayMigrationSummary,
  LegacyClashMigrationSummary
} from './backup-panel'

describe('Local backup UI scope', () => {
  it('narrows only metadata inspection while preserving the default backup mutation busy gate', () => {
    const onBusy = vi.fn()
    const props = { busy: true, onBusy, onRestoreNotice: vi.fn() }
    const html = renderToStaticMarkup(
      createElement(RelayBackupPanel, { ...props, inspectBusy: false })
    )
    expect(html).toMatch(/<button>只读检查旧Relay配置/)
    expect(html).toMatch(/<button disabled="">从备份恢复…/)
    expect(html).toMatch(/<button disabled="">导入所选未启用配置副本/)
    expect(html).not.toContain('确认恢复这份备份')
    const blocked = renderToStaticMarkup(createElement(RelayBackupPanel, props))
    expect(blocked).toMatch(/<button disabled="">只读检查旧Relay配置/)
    expect(onBusy).not.toHaveBeenCalled()
  })
  it('does not select files or restore on render and labels credential and runtime boundaries', () => {
    const onBusy = vi.fn()
    const html = renderToStaticMarkup(
      createElement(RelayBackupPanel, { busy: false, onBusy, onRestoreNotice: vi.fn() })
    )
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('密码、请求头及密钥')
    expect(html).toContain('不会自动恢复旧授权或启动核心')
    expect(html).toContain('本地备份不会自动上传')
    expect(html).toContain('选择旧Clash备份并检查')
    expect(html).toContain('留空只迁移配置缓存，不创建远程订阅来源')
    expect(html).toContain('旧版v1与未知记录不能强制续作')
    expect(html).toContain('读取恢复记录')
    expect(html).not.toContain('确认恢复这份备份')
    expect(html).toMatch(/<button disabled="">取消恢复准备/)
    expect(html).not.toContain('单独确认本次续作')
    expect(html).toMatch(/<button disabled="">取消本次续作准备/)
    expect(html).not.toContain('Sub-Store逐项迁移报告')
    expect(html).toContain('只读检查旧Relay配置')
    expect(html).toContain('不会自动扫描')
    expect(html).toMatch(/<button disabled="">导入所选未启用配置副本/)
    expect(html).not.toContain('旧Relay检查结果')
  })
  it('shows partial known-schema definition mappings and retained tasks without exposing URLs or bodies', () => {
    const summary: LegacySubStoreSummary = {
      schema: '2.0',
      subscriptions: 1,
      collections: 0,
      items: [
        {
          kind: 'subscription',
          oldName: '旧基础订阅',
          newName: 'relay-import-sub-fixture',
          disposition: 'accepted',
          reason: '基础定义候选，自动流量查询关闭'
        },
        {
          kind: 'collection',
          oldName: '缺少引用的集合',
          disposition: 'retained',
          reason: '引用未被本次完整接纳；整项保留'
        },
        {
          kind: 'section',
          oldName: 'artifacts',
          disposition: 'retained',
          reason: '旧任务与脚本只留原件'
        }
      ]
    }
    const unsafeExtraFields = {
      ...summary,
      url: 'PRIVATE-url',
      content: 'PRIVATE-content',
      token: 'PRIVATE-token'
    }
    const html = renderToStaticMarkup(
      createElement(LegacySubStoreMigrationSummary, { summary: unsafeExtraFields })
    )
    for (const text of [
      '2.0数组',
      '接纳订阅',
      '1',
      '静态集合',
      '0',
      'noFlow=true',
      '自动流量查询默认关闭',
      '不启动Sub-Store',
      '旧基础订阅',
      'relay-import-sub-fixture',
      '候选接纳',
      '缺少引用的集合',
      '保留原件',
      '引用未被本次完整接纳',
      'artifacts',
      '旧任务与脚本只留原件'
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('PRIVATE')
    expect(html).not.toContain('尚未写入')
    expect(html).not.toContain('<button')
  })

  it('shares a sanitized zero-profile Clash report without implying no candidate or a completed write', () => {
    const report: LegacyClashMigrationReport = {
      format: 'clash-party-legacy-zip',
      archiveSHA256: 'a'.repeat(64),
      containsSecrets: true,
      counts: {
        profiles: 0,
        sources: 0,
        overrides: 0,
        rulePatches: 0,
        applied: 0,
        retained: 1,
        'decision-required': 0
      },
      profiles: [],
      files: [
        {
          path: 'tasks.json',
          bytes: 8,
          sha256: 'b'.repeat(64),
          disposition: 'retained',
          reason: '旧任务仅留原件'
        }
      ]
    }
    const extra = { ...report, secretKey: 'PRIVATE-secret', url: 'PRIVATE-url' }
    const html = renderToStaticMarkup(createElement(LegacyClashMigrationSummary, { report: extra }))
    expect(html).toContain('旧Clash迁移检查报告')
    expect(html).toContain('配置 0项')
    expect(html).toContain('旧任务仅留原件')
    expect(html).toContain('是否写入当前资料以本次恢复状态为准')
    expect(html).not.toContain('PRIVATE')
    expect(html).not.toContain('尚未写入')
    expect(html).not.toContain('<button')
  })
  it('distinguishes a fixed-origin Relay copy report from Clash ZIP reports and preserves original-only boundaries', () => {
    const report: LegacyRelayMigrationReport = {
      format: 'relay-legacy-profiles-v1',
      origin: 'Relay-Preview',
      sourceSHA256: 'a'.repeat(64),
      originalArchiveSHA256: 'b'.repeat(64),
      containsSecrets: true,
      profiles: [
        {
          legacyId: 'old-id',
          legacySHA256: 'c'.repeat(64),
          legacyRevision: 'd'.repeat(64),
          profileId: 'new-id',
          profileSHA256: 'c'.repeat(64)
        }
      ],
      warnings: ['一个损坏UUID条目未接纳']
    }
    const withPrivateFields = {
      ...report,
      text: 'PRIVATE-body',
      metadata: 'PRIVATE-metadata',
      path: '/PRIVATE/home'
    }
    const html = renderToStaticMarkup(
      createElement(LegacyRelayMigrationSummary, { report: withPrivateFields })
    )
    for (const text of [
      '旧Relay配置副本报告',
      'Relay-Preview',
      'old-id',
      'new-id',
      '复制为新的未启用配置',
      '旧原件保留',
      '未搬走或清空旧根',
      '再次显式检查并复制',
      '没有自动去重',
      '原件归档摘要',
      '一个损坏UUID条目未接纳'
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('PRIVATE')
    expect(html).not.toContain('旧Clash迁移检查报告')
    expect(html).not.toContain('<button')
  })
})
