import { randomUUID } from 'crypto'
import {
  profileEvidence,
  stripProfileControls,
  type RelayProfilePreparation,
  type RelayProfileInventory,
  type RelayProfileSaveResult,
  type RelayProfileNodes,
  type RelayProfileGroups,
  type RelayProfileRules,
  type RelayProfileRuleProviders,
  type RelayProfileExportResult,
  type RelayStoredProfile
} from '../../../shared/relay/profiles'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import { parseSimpleRule, ruleSetNames, SIMPLE_RULE_TYPES } from '../../../shared/simple-rules'
import { defaultSimpleDraft } from '../../../shared/simple-config'
import type { ResourceInfo } from '../../../shared/relay/resources'
import { parse } from '../../utils/yaml'
import { inspectRuntimeConfiguration } from '../configuration/schema'
import { resourceRuleEntries, type ResourceValidationJob } from '../resources/check-definition'
import { resourceHash } from '../resources/source'
import { inspectProfile, analyzeProfile, reservedProfileTargets } from './inspect'
import { plainConfigurationMap } from './document'
import { inspectNode } from './nodes'
import { supportedGroup } from './groups'
import { supportedInlineRuleProvider } from './rule-providers'
import { ProfileWriteUncertain } from './store'
import { renameProfileOutbound } from './rename'
import { profileHash, type ProfileSource } from './source'

export interface ProfilePublicationToken {
  readonly purpose: 'simple-publication'
}

export function createProfileService(adapters: {
  pick(): Promise<ProfileSource | undefined>
  confirm(preparation: RelayProfilePreparation, purpose?: 'simple-publication'): Promise<boolean>
  save(name: string, text: string): Promise<RelayStoredProfile>
  list(): Promise<RelayProfileInventory>
  read?(
    selection: RelayProfileSelection
  ): Promise<{ profile: RelayStoredProfile; text: string; revision: string }>
  confirmExport?(profile: RelayStoredProfile): Promise<boolean>
  writeExport?(name: string, bytes: Buffer, recheck: () => Promise<void>): Promise<boolean>
  readRuleResource?(
    selection: RelayProfileSelection
  ): Promise<{ info: ResourceInfo; bytes: Buffer; revision: string }>
  convertRuleMRS?(job: ResourceValidationJob): Promise<{ entries: string[]; sourceRules: number }>
  now?(): number
}) {
  let generatedEpoch = 0
  let busy = false
  let listing = false
  let proof:
    | {
        report: RelayProfilePreparation
        source: ProfileSource
        at: number
        publication?: ProfilePublicationToken
      }
    | undefined
  const now = adapters.now ?? Date.now,
    waiters: (() => void)[] = []
  const end = (): void => {
    busy = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const prepareSource = (
    source: ProfileSource,
    ruleSnapshot?: RelayProfilePreparation['ruleSnapshot'],
    purpose?: ProfilePublicationToken
  ): RelayProfilePreparation => {
    const report: RelayProfilePreparation = {
      evidenceId: randomUUID(),
      name: source.name,
      sha256: profileHash(source.text),
      bytes: Buffer.byteLength(source.text),
      inspection: inspectProfile(source.text),
      ...(ruleSnapshot ? { ruleSnapshot } : {})
    }
    if (report.inspection.structure === 'passed')
      proof = { report, source, at: now(), ...(purpose ? { publication: purpose } : {}) }
    return structuredClone(report)
  }
  const prepareGeneratedSource = async (
    source: ProfileSource,
    purpose?: ProfilePublicationToken
  ): Promise<RelayProfilePreparation> => {
    if (busy) throw new Error('请先完成或取消本次配置操作。')
    busy = true
    proof = undefined
    const preparedEpoch = generatedEpoch
    try {
      if (
        !plainConfigurationMap(source) ||
        typeof source.name !== 'string' ||
        !source.name ||
        source.name.length > 120 ||
        stripProfileControls(source.name) !== source.name ||
        /[\\/]/u.test(source.name) ||
        typeof source.text !== 'string' ||
        typeof source.assertCurrent !== 'function' ||
        typeof source.readAgain !== 'function'
      )
        throw new Error()
      const held = Object.freeze({
        name: source.name,
        text: source.text,
        assertCurrent: source.assertCurrent,
        readAgain: source.readAgain
      })
      await held.assertCurrent()
      if (preparedEpoch !== generatedEpoch) throw new Error()
      const report = prepareSource(held, undefined, purpose)
      if (report.inspection.structure !== 'passed') throw new Error()
      return report
    } catch {
      proof = undefined
      throw new Error('生成副本已失效或结构未通过；未保存或启用配置。')
    } finally {
      end()
    }
  }
  const savePrepared = async (
    raw: unknown,
    authority?: ProfilePublicationToken,
    beforePersist?: () => Promise<void>
  ): Promise<RelayProfileSaveResult> => {
    const id = profileEvidence(raw),
      current = proof
    if (
      current?.publication
        ? current.publication !== authority || typeof beforePersist !== 'function'
        : authority !== undefined
    )
      throw new Error('请重新选择并检查配置。')
    const generatedSaveEpoch = current?.source.assertCurrent ? generatedEpoch : undefined
    const timely = (): boolean => !!current && now() >= current.at && now() - current.at <= 60000
    const fresh = (): boolean =>
      !!current && proof === current && current.report.evidenceId === id && timely()
    if (busy) throw new Error('请先完成或取消本次配置操作。')
    if (!fresh() || !current) throw new Error('请重新选择并检查配置。')
    busy = true
    try {
      if (current.source.assertCurrent) {
        await current.source.assertCurrent()
        if (!fresh()) throw new Error()
      }
      const confirmed = current.publication
        ? await adapters.confirm(structuredClone(current.report), 'simple-publication')
        : await adapters.confirm(structuredClone(current.report))
      if (current.source.assertCurrent) {
        await current.source.assertCurrent()
        if (!fresh()) throw new Error()
      }
      if (!confirmed) return { status: 'cancelled', warnings: ['已取消，未保存或启用配置。'] }
      if (!fresh()) throw new Error()
      proof = undefined // Single use once confirmed; a failed save is not automatically replayed.
      const text = await current.source.readAgain()
      if (generatedSaveEpoch !== undefined && generatedSaveEpoch !== generatedEpoch)
        throw new Error()
      if (!timely() || profileHash(text) !== current.report.sha256) throw new Error()
      if (authority) {
        if (typeof beforePersist !== 'function' || !current.source.assertCurrent) throw new Error()
        await beforePersist()
        if (
          generatedSaveEpoch !== generatedEpoch ||
          !timely() ||
          profileHash(text) !== current.report.sha256
        )
          throw new Error()
        await current.source.assertCurrent()
        if (
          generatedSaveEpoch !== generatedEpoch ||
          !timely() ||
          profileHash(text) !== current.report.sha256
        )
          throw new Error()
      }
      const profile = await adapters.save(current.report.name, text)
      return {
        status: 'saved',
        profile,
        warnings: ['已保存独立副本；未切换配置、启动核心或修改网络。核心兼容性仍待验证。']
      }
    } catch (error) {
      proof = undefined
      return {
        status: error instanceof ProfileWriteUncertain ? 'uncertain' : 'failed',
        warnings: [
          error instanceof ProfileWriteUncertain
            ? error.message
            : '保存未完成或来源已改变，请重新选择配置；没有自动重试或启用配置。'
        ]
      }
    } finally {
      end()
    }
  }
  return {
    isBusy: (): boolean => busy,
    isListing: (): boolean => listing,
    whenIdle: (): Promise<void> =>
      busy ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    clear(): void {
      ++generatedEpoch
      proof = undefined
    },
    async prepareNew(raw: unknown): Promise<RelayProfilePreparation> {
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      busy = true
      proof = undefined
      try {
        if (
          !plainConfigurationMap(raw) ||
          Object.keys(raw).join(',') !== 'name' ||
          typeof raw.name !== 'string'
        )
          throw new Error()
        const name = raw.name.trim()
        if (
          !name ||
          name.length > 108 ||
          stripProfileControls(name) !== name ||
          /[\\/]/u.test(name) ||
          ['.', '..'].includes(name)
        )
          throw new Error()
        const draft = defaultSimpleDraft()
        const configuration: Record<string, unknown> = { mode: 'rule' }
        for (const key of [
          'proxies',
          'proxy-providers',
          'proxy-groups',
          'rules',
          'rule-providers',
          'sub-rules',
          'hosts'
        ])
          configuration[key] = parse(draft.modules[key])
        // Only the pure empty editing modules are reused. The upstream general,
        // DNS and TUN defaults carry listeners/public endpoints and are excluded.
        const text = JSON.stringify(configuration, null, 2) + '\n'
        const report = prepareSource({ name: name + '.json', text, readAgain: async () => text })
        if (report.inspection.structure !== 'passed') throw new Error()
        return report
      } catch {
        proof = undefined
        throw new Error(
          '空白配置准备未通过。名称须为1至108个字符，不接受路径、控制字符或自定义正文。'
        )
      } finally {
        end()
      }
    },
    async export(raw: unknown): Promise<RelayProfileExportResult> {
      const selection = profileSelection(raw)
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      const { read, confirmExport, writeExport } = adapters
      if (!read || !confirmExport || !writeExport) throw new Error('配置原文导出尚未接通。')
      busy = true
      let bytes: Buffer | undefined
      try {
        const source = await read(selection),
          preparedAt = now()
        if (!(await confirmExport(structuredClone(source.profile)))) return { status: 'cancelled' }
        const recheck = async (): Promise<void> => {
          if (now() < preparedAt || now() - preparedAt > 60000) throw new Error()
          const latest = await read(selection)
          if (
            latest.revision !== source.revision ||
            profileHash(latest.text) !== selection.sha256 ||
            profileHash(source.text) !== selection.sha256
          )
            throw new Error()
        }
        await recheck()
        bytes = Buffer.from(source.text)
        if (!(await writeExport(source.profile.name, bytes, recheck)))
          return { status: 'cancelled' }
        return { status: 'exported' }
      } catch {
        throw new Error('配置导出未确认。请核对来源、保存位置和其他操作后重新选择；不会自动重试。')
      } finally {
        bytes?.fill(0)
        end()
      }
    },
    async readNodes(raw: unknown): Promise<RelayProfileNodes> {
      const selection = profileSelection(raw)
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      if (!adapters.read) throw new Error('节点编辑尚未接通。')
      busy = true
      try {
        const source = await adapters.read(selection)
        const parsed = analyzeProfile(source.text)
        const nodes = parsed.data?.proxies ?? []
        if (
          !parsed.data ||
          !Array.isArray(nodes) ||
          nodes.length > 500 ||
          !nodes.every(plainConfigurationMap)
        )
          throw new Error()
        return structuredClone({ profile: source.profile, nodes })
      } catch {
        throw new Error('未能读取节点草稿，来源可能已变化或超过500个节点。')
      } finally {
        end()
      }
    },
    async readGroups(raw: unknown): Promise<RelayProfileGroups> {
      const selection = profileSelection(raw)
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      if (!adapters.read) throw new Error('代理组编辑尚未接通。')
      busy = true
      try {
        const source = await adapters.read(selection),
          data = analyzeProfile(source.text).data
        const groups = data?.['proxy-groups'] ?? [],
          nodes = data?.proxies ?? []
        if (
          !data ||
          !Array.isArray(groups) ||
          groups.length > 500 ||
          !groups.every(plainConfigurationMap) ||
          !Array.isArray(nodes) ||
          !nodes.every(plainConfigurationMap)
        )
          throw new Error()
        return structuredClone({
          profile: source.profile,
          groups,
          targets: [
            ...reservedProfileTargets,
            ...[...nodes, ...groups].map((item) => String(item.name))
          ],
          providers: Object.keys(data['proxy-providers'] ?? {})
        })
      } catch {
        throw new Error('未能读取代理组草稿，来源可能已变化或超过500个组。')
      } finally {
        end()
      }
    },
    async readRules(raw: unknown): Promise<RelayProfileRules> {
      const selection = profileSelection(raw)
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      if (!adapters.read) throw new Error('规则编辑尚未接通。')
      busy = true
      try {
        const source = await adapters.read(selection),
          data = analyzeProfile(source.text).data
        if (!data) throw new Error()
        const nodes = data.proxies ?? [],
          groups = data['proxy-groups'] ?? [],
          rules = data.rules ?? []
        if (
          !Array.isArray(nodes) ||
          !Array.isArray(groups) ||
          ![...nodes, ...groups].every(plainConfigurationMap) ||
          !Array.isArray(rules) ||
          rules.length > 10000 ||
          !rules.every((value): value is string => typeof value === 'string')
        )
          throw new Error()
        return structuredClone({
          profile: source.profile,
          rules,
          targets: [
            ...reservedProfileTargets,
            ...[...nodes, ...groups].map((item) => String(item.name))
          ],
          providers: Object.keys(data['rule-providers'] ?? {}),
          subRules: Object.keys(data['sub-rules'] ?? {})
        })
      } catch {
        throw new Error('未能读取规则草稿，来源可能已变化或超过10000条规则。')
      } finally {
        end()
      }
    },
    async readRuleProviders(raw: unknown): Promise<RelayProfileRuleProviders> {
      const selection = profileSelection(raw)
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      if (!adapters.read) throw new Error('规则提供者编辑尚未接通。')
      busy = true
      try {
        const source = await adapters.read(selection),
          data = analyzeProfile(source.text).data
        const providers = data?.['rule-providers'] ?? {}
        if (
          !data ||
          !plainConfigurationMap(providers) ||
          Object.keys(providers).length > 200 ||
          !Object.values(providers).every(plainConfigurationMap)
        )
          throw new Error()
        const definitions: Record<string, Record<string, unknown>> = {}
        for (const [name, definition] of Object.entries(providers)) {
          if (!plainConfigurationMap(definition)) throw new Error()
          definitions[name] = definition
        }
        return structuredClone({ profile: source.profile, providers: definitions })
      } catch {
        throw new Error('未能读取规则提供者，来源可能已变化或超过200项。')
      } finally {
        end()
      }
    },
    async prepareRuleSnapshot(raw: unknown): Promise<RelayProfilePreparation> {
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      const { read, readRuleResource } = adapters
      if (!read || !readRuleResource) throw new Error('规则资源固化尚未接通。')
      busy = true
      proof = undefined
      try {
        if (
          !plainConfigurationMap(raw) ||
          Object.keys(raw).sort().join(',') !== 'profile,provider,resource' ||
          typeof raw.provider !== 'string'
        )
          throw new Error()
        const provider = raw.provider
        if (
          !provider.trim() ||
          provider !== provider.trim() ||
          provider.length > 256 ||
          stripProfileControls(provider) !== provider ||
          /[,/\\]/u.test(provider) ||
          ['.', '..'].includes(provider)
        )
          throw new Error()
        const selection = profileSelection(raw.profile),
          resourceSelection = profileSelection(raw.resource)
        const source = await read(selection),
          data = analyzeProfile(source.text).data
        if (
          !data ||
          profileHash(source.text) !== selection.sha256 ||
          !plainConfigurationMap(data['rule-providers']) ||
          !Object.hasOwn(data['rule-providers'], provider)
        )
          throw new Error()
        const current = data['rule-providers'][provider]
        const resource = await readRuleResource(resourceSelection),
          info = resource.info
        if (
          !plainConfigurationMap(current) ||
          !['file', 'http', 'inline'].includes(String(current.type)) ||
          !['rule-yaml', 'rule-text', 'rule-mrs'].includes(info.kind) ||
          !info.behavior ||
          current.behavior !== info.behavior ||
          resource.bytes.length > 2 * 1024 * 1024 ||
          info.sha256 !== resourceSelection.sha256 ||
          resourceHash(resource.bytes) !== resourceSelection.sha256
        )
          throw new Error()
        const job: ResourceValidationJob = {
          descriptor: {
            name: info.name,
            kind: info.kind,
            behavior: info.behavior,
            selector: info.selector
          },
          bytes: resource.bytes,
          sha256: info.sha256
        }
        let entries: ReturnType<typeof resourceRuleEntries>
        if (info.kind === 'rule-mrs') {
          if (!adapters.convertRuleMRS || !['domain', 'ipcidr'].includes(info.behavior))
            throw new Error()
          // The fixed-core worker owns binary decoding and its bounded,
          // network-denied conversion. Never decode MRS as UTF-8 or fall back.
          const converted = await adapters.convertRuleMRS(job)
          entries = {
            entries: converted.entries,
            expected: converted.entries.length,
            needsDependencies: false
          }
        } else {
          new TextDecoder('utf-8', { fatal: true }).decode(resource.bytes)
          entries = resourceRuleEntries(job, true)
        }
        const inline = { type: 'inline', behavior: info.behavior, payload: entries.entries }
        if (entries.needsDependencies || !supportedInlineRuleProvider(inline)) throw new Error()
        const text =
          JSON.stringify(
            { ...data, 'rule-providers': { ...data['rule-providers'], [provider]: inline } },
            null,
            2
          ) + '\n'
        if (inspectProfile(text).structure !== 'passed') throw new Error()
        return prepareSource(
          {
            name: source.profile.name.slice(0, 106) + '-snapshot.json',
            text,
            readAgain: async () => {
              const latest = await read(selection),
                asset = await readRuleResource(resourceSelection)
              if (
                latest.revision !== source.revision ||
                profileHash(latest.text) !== selection.sha256 ||
                asset.revision !== resource.revision ||
                asset.info.sha256 !== info.sha256 ||
                resourceHash(asset.bytes) !== info.sha256
              )
                throw new Error()
              return text
            }
          },
          {
            provider,
            resourceSHA256: info.sha256,
            rules: entries.expected ?? 0,
            behavior: info.behavior
          }
        )
      } catch {
        throw new Error(
          '规则资源固化未通过：仅支持行为一致、摘要有效的受控YAML／文本资源及固定核心转换的MRS内联规则；不读取原始路径或访问来源URL。'
        )
      } finally {
        end()
      }
    },
    async prepareRuleProviders(raw: unknown): Promise<RelayProfilePreparation> {
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      if (!adapters.read) throw new Error('规则提供者编辑尚未接通。')
      busy = true
      proof = undefined
      try {
        if (
          !plainConfigurationMap(raw) ||
          Object.keys(raw).sort().join(',') !== 'profile,providers' ||
          !plainConfigurationMap(raw.providers) ||
          Object.keys(raw.providers).length > 200 ||
          !Object.values(raw.providers).every(plainConfigurationMap) ||
          Buffer.byteLength(JSON.stringify(raw.providers)) > 512 * 1024
        )
          throw new Error()
        const nextProviders = raw.providers
        for (const name of Object.keys(nextProviders))
          if (
            !name.trim() ||
            name !== name.trim() ||
            name.length > 256 ||
            name.includes(',') ||
            [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
          )
            throw new Error()
        if (
          !inspectRuntimeConfiguration(JSON.stringify({ 'rule-providers': raw.providers }))
            .configuration
        )
          throw new Error()
        const selection = profileSelection(raw.profile),
          read = adapters.read,
          source = await read(selection)
        const data = analyzeProfile(source.text).data
        if (!data) throw new Error()
        const previous = data['rule-providers'] ?? {},
          rest = { ...data }
        const nodes = data.proxies ?? [],
          groups = data['proxy-groups'] ?? []
        if (
          !Array.isArray(nodes) ||
          !Array.isArray(groups) ||
          ![...nodes, ...groups].every(plainConfigurationMap)
        )
          throw new Error()
        const targets = new Set([
          ...reservedProfileTargets,
          ...[...nodes, ...groups].map((item) => String(item.name))
        ])
        for (const definition of Object.values(nextProviders))
          if (
            plainConfigurationMap(definition) &&
            definition.proxy &&
            !targets.has(String(definition.proxy))
          )
            throw new Error()
        delete rest['rule-providers']
        for (const removed of Object.keys(previous).filter(
          (name) => !Object.hasOwn(nextProviders, name)
        )) {
          // Resource references also occur in DNS selector keys and TUN arrays.
          // Refuse ambiguous occurrences rather than silently rewriting another field.
          const mentions = (value: unknown): boolean =>
            typeof value === 'string'
              ? value.includes(removed)
              : !!value &&
                typeof value === 'object' &&
                Object.entries(value).some(
                  ([key, child]) => key.includes(removed) || mentions(child)
                )
          if (mentions(rest) || mentions(raw.providers)) throw new Error()
        }
        const text =
          JSON.stringify({ ...data, 'rule-providers': structuredClone(raw.providers) }, null, 2) +
          '\n'
        if (inspectProfile(text).structure !== 'passed') throw new Error()
        return prepareSource({
          name: source.profile.name.slice(0, 108) + '-edited.json',
          text,
          readAgain: async () => {
            const latest = await read(selection)
            if (
              latest.revision !== source.revision ||
              profileHash(latest.text) !== profileHash(source.text)
            )
              throw new Error()
            return text
          }
        })
      } catch {
        throw new Error(
          '规则提供者编辑未通过：检查固定核心字段、名称、数量及大小；移除的名称仍有可能引用时会被拒绝。'
        )
      } finally {
        end()
      }
    },
    async prepareRules(raw: unknown): Promise<RelayProfilePreparation> {
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      if (!adapters.read) throw new Error('规则编辑尚未接通。')
      busy = true
      proof = undefined
      try {
        if (
          !plainConfigurationMap(raw) ||
          Object.keys(raw).sort().join(',') !== 'profile,rules' ||
          !Array.isArray(raw.rules) ||
          raw.rules.length > 10000
        )
          throw new Error()
        const selection = profileSelection(raw.profile),
          read = adapters.read,
          source = await read(selection)
        const data = analyzeProfile(source.text).data
        if (!data) throw new Error()
        const nodes = data.proxies ?? [],
          groups = data['proxy-groups'] ?? []
        if (
          !Array.isArray(nodes) ||
          !Array.isArray(groups) ||
          ![...nodes, ...groups].every(plainConfigurationMap)
        )
          throw new Error()
        const targets = new Set([
          ...reservedProfileTargets,
          ...[...nodes, ...groups].map((item) => String(item.name))
        ])
        const providers = data['rule-providers'] ?? {},
          subRules = data['sub-rules'] ?? {}
        let remaining = 2 * 1024 * 1024
        for (const rule of raw.rules) {
          if (
            typeof rule !== 'string' ||
            !rule.trim() ||
            rule.length > 8192 ||
            [...rule].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
          )
            throw new Error()
          remaining -= Buffer.byteLength(rule)
          if (remaining < 0) throw new Error()
          let depth = 0
          for (const char of rule) {
            if (char === '(') depth++
            else if (char === ')') depth--
            if (depth < 0 || depth > 32) throw new Error()
          }
          if (depth) throw new Error()
          const parsed = parseSimpleRule(rule)
          if (
            !SIMPLE_RULE_TYPES.includes(parsed.type) ||
            !parsed.target ||
            (parsed.type !== 'MATCH' && !parsed.payload) ||
            (parsed.options.includes('src') && parsed.options.includes('no-resolve')) ||
            !(parsed.type === 'SUB-RULE'
              ? Object.hasOwn(subRules, parsed.target)
              : targets.has(parsed.target)) ||
            ruleSetNames(rule).some((name) => !Object.hasOwn(providers, name))
          )
            throw new Error()
        }
        const text = JSON.stringify({ ...data, rules: structuredClone(raw.rules) }, null, 2) + '\n'
        if (inspectProfile(text).structure !== 'passed') throw new Error()
        return prepareSource({
          name: source.profile.name.slice(0, 108) + '-edited.json',
          text,
          readAgain: async () => {
            const latest = await read(selection)
            if (
              latest.revision !== source.revision ||
              profileHash(latest.text) !== profileHash(source.text)
            )
              throw new Error()
            return text
          }
        })
      } catch {
        throw new Error(
          '规则编辑未通过：检查列表大小、单行语法、目标／规则集／子规则引用或互斥选项；核心兼容性须另行检查。'
        )
      } finally {
        end()
      }
    },
    async prepareNodeEdit(
      raw: unknown,
      collection: 'nodes' | 'groups' = 'nodes'
    ): Promise<RelayProfilePreparation> {
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      if (!adapters.read) throw new Error('节点编辑尚未接通。')
      busy = true
      proof = undefined
      try {
        if (
          !plainConfigurationMap(raw) ||
          !(
            collection === 'groups'
              ? ['add', 'update', 'remove', 'reorder', 'rename']
              : ['add', 'update', 'remove', 'rename']
          ).includes(String(raw.action))
        )
          throw new Error()
        const keys = [
          'profile',
          'action',
          ...(raw.action === 'reorder'
            ? ['order']
            : [
                ...(raw.action === 'add' ? [] : ['originalName']),
                ...(raw.action === 'remove'
                  ? []
                  : [
                      raw.action === 'rename'
                        ? 'newName'
                        : collection === 'groups'
                          ? 'group'
                          : 'node'
                    ])
              ])
        ]
        if (Object.keys(raw).sort().join(',') !== keys.sort().join(',')) throw new Error()
        const selection = profileSelection(raw.profile)
        const read = adapters.read
        const source = await read(selection)
        const parsed = analyzeProfile(source.text)
        if (!parsed.data) throw new Error()
        let data = parsed.data
        const key = collection === 'groups' ? 'proxy-groups' : 'proxies',
          nodes = data[key] ?? []
        if (!Array.isArray(nodes) || nodes.length > 500 || !nodes.every(plainConfigurationMap))
          throw new Error()
        const index = nodes.findIndex((node) => node.name === raw.originalName)
        if (
          !['add', 'reorder'].includes(String(raw.action)) &&
          (typeof raw.originalName !== 'string' || index < 0)
        )
          throw new Error()
        if (raw.action === 'rename') {
          if (
            typeof raw.originalName !== 'string' ||
            typeof raw.newName !== 'string' ||
            profileHash(source.text) !== selection.sha256
          )
            throw new Error()
          data = renameProfileOutbound(data, collection, raw.originalName, raw.newName)
        } else if (raw.action === 'reorder') {
          if (
            !Array.isArray(raw.order) ||
            raw.order.length !== nodes.length ||
            new Set(raw.order).size !== nodes.length
          )
            throw new Error()
          const ordered: Record<string, unknown>[] = []
          for (const name of raw.order) {
            const found = nodes.find((item) => item.name === name)
            if (!found) throw new Error()
            ordered.push(found)
          }
          nodes.splice(0, nodes.length, ...ordered)
        } else if (raw.action === 'remove') {
          const references = (value: unknown): boolean =>
            typeof value === 'string'
              ? value.split(',').some((part) => part.trim() === raw.originalName)
              : !!value && typeof value === 'object' && Object.values(value).some(references)
          const rest = { ...data, [key]: nodes.filter((_, position) => position !== index) }
          if (references(rest)) throw new Error('referenced')
          nodes.splice(index, 1)
        } else {
          const item = collection === 'groups' ? raw.group : raw.node
          if (
            !plainConfigurationMap(item) ||
            Buffer.byteLength(JSON.stringify(item)) > 64 * 1024 ||
            !(collection === 'groups' ? supportedGroup(item) : inspectNode(item).supported)
          )
            throw new Error()
          if (raw.action === 'update') {
            if (item.name !== raw.originalName) throw new Error('rename')
            nodes[index] = structuredClone(item)
          } else {
            if (nodes.length >= 500) throw new Error()
            nodes.push(structuredClone(item))
          }
        }
        if (raw.action !== 'rename') data[key] = nodes
        const text = JSON.stringify(data, null, 2) + '\n'
        if (inspectProfile(text).structure !== 'passed') throw new Error()
        return prepareSource({
          name: source.profile.name.slice(0, 108) + '-edited.json',
          text,
          readAgain: async () => {
            const latest = await read(selection)
            if (
              latest.revision !== source.revision ||
              profileHash(latest.text) !== profileHash(source.text)
            )
              throw new Error()
            return text
          }
        })
      } catch {
        throw new Error(
          collection === 'groups'
            ? '代理组编辑未通过：检查类型、成员、提供者、循环引用或排列；改名须使用独立入口且全部引用可确认。普通更新须保留名称，已引用组不可删除。'
            : '节点编辑未通过：检查节点类型、字段、重复名称及引用；改名须使用独立入口且全部引用可确认。普通更新须保留原名称，已引用节点不可删除。'
        )
      } finally {
        end()
      }
    },
    // Callable Main-only capability, never a renderer/source-object IPC input.
    async prepareGenerated(source: ProfileSource): Promise<RelayProfilePreparation> {
      return prepareGeneratedSource(source)
    },
    async preparePublication(
      source: ProfileSource
    ): Promise<{ report: RelayProfilePreparation; token: ProfilePublicationToken }> {
      const token: ProfilePublicationToken = Object.freeze({ purpose: 'simple-publication' })
      const report = await prepareGeneratedSource(source, token)
      return { report, token }
    },
    async prepare(raw: unknown): Promise<RelayProfilePreparation | undefined> {
      if (raw !== undefined) throw new Error('从系统文件选择器导入，不接受路径或正文参数。')
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      busy = true
      proof = undefined
      try {
        const source = await adapters.pick()
        if (!source) return undefined
        return prepareSource(source)
      } catch {
        throw new Error('未能安全读取选中的配置，没有保存或启用配置。')
      } finally {
        end()
      }
    },
    async save(raw: unknown): Promise<RelayProfileSaveResult> {
      return savePrepared(raw)
    },
    async savePublication(
      token: ProfilePublicationToken,
      beforePersist: () => Promise<void>
    ): Promise<RelayProfileSaveResult> {
      if (!proof?.publication || proof.publication !== token || typeof beforePersist !== 'function')
        throw new Error('发布凭据已失效。')
      return savePrepared({ evidenceId: proof.report.evidenceId }, token, beforePersist)
    },
    async list(raw: unknown): Promise<RelayProfileInventory> {
      if (raw !== undefined) throw new Error('配置列表不接受路径或筛选参数。')
      if (busy) throw new Error('请先完成或取消本次配置操作。')
      busy = true
      listing = true
      try {
        return await adapters.list()
      } catch {
        throw new Error('配置列表读取未完成，未修改或删除已有条目。')
      } finally {
        listing = false
        end()
      }
    }
  }
}
