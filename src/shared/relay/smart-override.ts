import { healthURL } from './health'
import { configurationEditDocument, type ConfigurationEditDocument } from './configuration-edit'
import { smartCollectorSizeMiB } from './smart-settings'

export const SMART_OVERRIDE_ID = 'smart-core-override'
export interface SmartOverrideSettings {
  useLightGBM: boolean
  collectData: boolean
  collectorSizeMiB: number
  healthURL: string
}

// Reuse Clash Party v2.0.4 ac294fed's Smart conversion/rule template.
// Keep explicit health URLs and reject worker failures before publishing config.
export function smartOverrideTemplate(settings: SmartOverrideSettings): string {
  const { useLightGBM, collectData } = settings
  if (typeof useLightGBM !== 'boolean' || typeof collectData !== 'boolean')
    throw new Error('Smart模型与采集开关必须为布尔值。')
  const collectorSize = smartCollectorSizeMiB(settings.collectorSizeMiB)
  const explicitURL = healthURL(settings.healthURL)
  return `
// 保存后由Relay的配置编译流程应用

function main(config) {
  try {
    // 确保配置对象存在
    if (!config || typeof config !== 'object') {
      console.log('[Smart Override] Invalid config object')
      return config
    }

    // 设置 Smart 内核的 profile 配置
    if (!config.profile) {
      config.profile = {}
    }
    config.profile['smart-collector-size'] = ${collectorSize}

    // 确保代理组配置存在
    if (!config['proxy-groups']) {
      config['proxy-groups'] = []
    }

    // 确保代理组是数组
    if (!Array.isArray(config['proxy-groups'])) {
      console.log('[Smart Override] proxy-groups is not an array, converting...')
      config['proxy-groups'] = []
    }

    // Target positions follow fixed Smart462 rules/common/base.go.
    // SUB-RULE targets a rule namespace, never a proxy/group name.
    const ruleTargetIndex = (parts) => {
      const type = parts[0].toUpperCase()
      if (parts.length < 2 || type === 'SUB-RULE') return -1
      if (type === 'MATCH') return 1
      if (['NOT', 'OR', 'AND', 'DOMAIN-REGEX', 'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX'].includes(type))
        return parts.length >= 3 ? parts.length - 1 : -1
      return parts.length >= 3 ? 2 : -1
    }
    const ruleLists = []
    if (Array.isArray(config.rules)) ruleLists.push({owner: config, key: 'rules'})
    if (config['sub-rules'] && typeof config['sub-rules'] === 'object' && !Array.isArray(config['sub-rules'])) {
      for (const key of Object.keys(config['sub-rules'])) {
        if (Array.isArray(config['sub-rules'][key])) ruleLists.push({owner: config['sub-rules'], key})
      }
    }
    const occupiedNames = new Set()
    for (const entry of [...(Array.isArray(config.proxies) ? config.proxies : []), ...config['proxy-groups']]) {
      if (!entry || typeof entry.name !== 'string' || !entry.name) continue
      if (occupiedNames.has(entry.name)) throw Error('Duplicate source proxy/group name')
      occupiedNames.add(entry.name)
    }
    const availableGroupName = (base) => {
      const characters = Array.from(base)
      let stem = base
      const limit = occupiedNames.size + 1
      for (let attempt = 1; attempt <= limit; attempt++) {
        const suffix = attempt === 1 ? '' : ' (' + attempt + ')'
        while (stem.length + suffix.length > 256) {
          characters.pop()
          stem = characters.join('')
        }
        const candidate = stem + suffix
        if (!occupiedNames.has(candidate)) {
          occupiedNames.add(candidate)
          return candidate
        }
      }
      throw Error('Smart group name unavailable')
    }

    // 首先检查是否存在 url-test 或 load-balance 代理组
    let hasUrlTestOrLoadBalance = false
    for (let i = 0; i < config['proxy-groups'].length; i++) {
      const group = config['proxy-groups'][i]
      if (group && group.type) {
        const groupType = group.type.toLowerCase()
        if (groupType === 'url-test' || groupType === 'load-balance') {
          hasUrlTestOrLoadBalance = true
          break
        }
      }
    }

    // 如果存在 url-test 或 load-balance 代理组，只进行类型转换
    if (hasUrlTestOrLoadBalance) {
      console.log('[Smart Override] Found url-test or load-balance groups, converting to smart type')
      
      // 记录需要更新引用的代理组名称映射
      const nameMapping = new Map()
      
      for (let i = 0; i < config['proxy-groups'].length; i++) {
        const group = config['proxy-groups'][i]
        if (group && group.type) {
          const groupType = group.type.toLowerCase()
          if (groupType === 'url-test' || groupType === 'load-balance') {
            console.log('[Smart Override] Converting group:', group.name, 'from', group.type, 'to smart')
            
            // 记录原名称和新名称的映射关系
            const originalName = group.name
            
            // 保留原有配置，只修改 type 和添加 Smart 特有配置
            group.type = 'smart'
            
            // 为代理组名称添加 (Smart Group) 后缀
            if (group.name && !group.name.includes('(Smart Group)')) {
              group.name = availableGroupName(group.name + '(Smart Group)')
              nameMapping.set(originalName, group.name)
            }
            
            // 添加 Smart 特有配置
            if (!group['policy-priority']) {
              group['policy-priority'] = ''  // policy-priority: <1 means lower priority, >1 means higher priority, the default is 1, pattern support regex and string
            }
            group.uselightgbm = ${useLightGBM}
            group.collectdata = ${collectData}
        if (!group.url) group.url = ${JSON.stringify(explicitURL)}
            
            // 移除 url-test 和 load-balance 特有的配置（tolerance 是 Smart 也支持的选项，保留）
            delete group.strategy
            delete group['hash-key']
            if (group.interval) delete group.interval
            if (group.lazy) delete group.lazy
            if (group.expected_status) delete group['expected-status']
          }
        }
      }
      
      // 更新配置文件中其他位置对代理组名称的引用
      if (nameMapping.size > 0) {
        console.log('[Smart Override] Updating references to renamed groups:', Array.from(nameMapping.entries()))
        
        // 更新代理组中的 proxies 字段引用
        if (config['proxy-groups'] && Array.isArray(config['proxy-groups'])) {
          config['proxy-groups'].forEach(group => {
            if (group && group.proxies && Array.isArray(group.proxies)) {
              group.proxies = group.proxies.map(proxyName => {
                if (nameMapping.has(proxyName)) {
                  console.log('[Smart Override] Updated proxy reference:', proxyName, '→', nameMapping.get(proxyName))
                  return nameMapping.get(proxyName)
                }
                return proxyName
              })
            }
          })
        }
        
        // 更新规则中的代理组引用
        for (const list of ruleLists) {
          list.owner[list.key] = list.owner[list.key].map(rule => {
            if (typeof rule === 'string') {
              // 按逗号分割规则，精确匹配策略组名称位置
              const parts = rule.split(',').map(part => part.trim())
              
              if (parts.length >= 2) {
                const targetIndex = ruleTargetIndex(parts)
                
                // 只替换策略组名称位置
                if (targetIndex !== -1 && nameMapping.has(parts[targetIndex])) {
                  const oldName = parts[targetIndex]
                  parts[targetIndex] = nameMapping.get(oldName)
                  console.log('[Smart Override] Updated rule reference:', oldName, '→', nameMapping.get(oldName))
                  return parts.join(',')
                }
              }
              return rule
            } else if (typeof rule === 'object' && rule !== null) {
              // 处理对象格式的规则
              ['target', 'proxy'].forEach(field => {
                if (rule[field] && nameMapping.has(rule[field])) {
                  console.log('[Smart Override] Updated rule object reference:', rule[field], '→', nameMapping.get(rule[field]))
                  rule[field] = nameMapping.get(rule[field])
                }
              })
            }
            return rule
          })
        }
        
        // 更新其他可能的配置字段引用
        ['mode', 'proxy-mode'].forEach(field => {
          if (config[field] && nameMapping.has(config[field])) {
            console.log('[Smart Override] Updated config field', field + ':', config[field], '→', nameMapping.get(config[field]))
            config[field] = nameMapping.get(config[field])
          }
        })
      }
      
      console.log('[Smart Override] Conversion completed, skipping other operations')
      return config
    }

    // 如果没有 url-test 或 load-balance 代理组，执行原有逻辑
    console.log('[Smart Override] No url-test or load-balance groups found, executing original logic')
    
    // 查找现有的 Smart 代理组并更新
    // smartGroupName 记录「实际存在且可被规则引用」的组名：命中已有组时是它自己的名字，
    // 新建时才是 'Smart Group'。规则替换必须用这个名字，否则会指向不存在的组。
    let smartGroupExists = false
    let smartGroupName = ''
    for (let i = 0; i < config['proxy-groups'].length; i++) {
      const group = config['proxy-groups'][i]
      if (group && group.type === 'smart') {
        smartGroupExists = true
        smartGroupName = group.name
        console.log('[Smart Override] Found existing smart group:', group.name)

        if (!group['policy-priority']) {
          group['policy-priority'] = ''  // policy-priority: <1 means lower priority, >1 means higher priority, the default is 1, pattern support regex and string
        }
        group.uselightgbm = ${useLightGBM}
        group.collectdata = ${collectData}
        if (!group.url) group.url = ${JSON.stringify(explicitURL)}
        break
      }
    }

    // 如果没有 Smart 组且有可用代理，创建示例组
    if (!smartGroupExists && config.proxies && Array.isArray(config.proxies) && config.proxies.length > 0) {
      console.log('[Smart Override] Creating new smart group with', config.proxies.length, 'proxies')

      // 获取所有代理的名称
      const proxyNames = config.proxies
        .filter(proxy => proxy && typeof proxy === 'object' && proxy.name)
        .map(proxy => proxy.name)

      if (proxyNames.length > 0) {
        const smartGroup = {
          name: availableGroupName('Smart Group'),
          type: 'smart',
          url: ${JSON.stringify(explicitURL)},
          'policy-priority': '',  // policy-priority: <1 means lower priority, >1 means higher priority, the default is 1, pattern support regex and string
          uselightgbm: ${useLightGBM},
          collectdata: ${collectData},
          proxies: proxyNames
        }
        config['proxy-groups'].unshift(smartGroup)
        smartGroupName = smartGroup.name
        console.log('[Smart Override] Created smart group at first position with proxies:', proxyNames)
      } else {
        console.log('[Smart Override] No valid proxies found, skipping smart group creation')
      }
    } else if (!smartGroupExists) {
      console.log('[Smart Override] No proxies available, skipping smart group creation')
    }

    // 处理规则替换
    // 只有在确实存在可引用的 smart 组时才改写规则。否则（订阅只有 proxy-providers、
    // 没有顶层 proxies，因而没能建组）会把规则目标指向一个不存在的组，内核直接启动失败。
    if (!smartGroupName) {
      console.log('[Smart Override] No usable smart group, skipping rule replacement')
    } else if (ruleLists.length) {
      console.log('[Smart Override] Processing rules, original count:', ruleLists.reduce((count, list) => count + list.owner[list.key].length, 0))

      // 收集所有代理组名称
      const proxyGroupNames = new Set()
      if (config['proxy-groups'] && Array.isArray(config['proxy-groups'])) {
        config['proxy-groups'].forEach(group => {
          if (group && group.name) {
            proxyGroupNames.add(group.name)
          }
        })
      }

      // 添加常见的内置目标
      const builtinTargets = new Set([
        'DIRECT',
        'REJECT',
        'REJECT-DROP',
        'PASS',
        'COMPATIBLE'
      ])

      // 添加常见的规则参数，不应该替换
      const ruleParams = new Set(['no-resolve', 'force-remote-dns', 'prefer-ipv6'])

      console.log('[Smart Override] Found', proxyGroupNames.size, 'proxy groups:', Array.from(proxyGroupNames))

      let replacedCount = 0
      for (const list of ruleLists) {
      list.owner[list.key] = list.owner[list.key].map(rule => {
        if (typeof rule === 'string') {
          // 处理字符串格式的规则
          const parts = rule.split(',').map(part => part.trim())
          if (parts.length >= 2) {
            const targetIndex = ruleTargetIndex(parts)
            const targetValue = targetIndex === -1 ? '' : parts[targetIndex]

            if (targetIndex !== -1 && targetValue) {
              // 检查是否应该替换
              const shouldReplace = !builtinTargets.has(targetValue) &&
                                   (proxyGroupNames.has(targetValue) ||
                                    !ruleParams.has(targetValue))

              if (shouldReplace) {
                parts[targetIndex] = smartGroupName
                replacedCount++
                console.log('[Smart Override] Replaced rule target:', targetValue, '→', smartGroupName)
                return parts.join(',')
              }
            }
          }
        } else if (typeof rule === 'object' && rule !== null) {
          // 处理对象格式
          let targetField = ''
          let targetValue = ''

          if (rule.target) {
            targetField = 'target'
            targetValue = rule.target
          } else if (rule.proxy) {
            targetField = 'proxy'
            targetValue = rule.proxy
          }

          if (targetField && targetValue) {
            const shouldReplace = !builtinTargets.has(targetValue) &&
                                 (proxyGroupNames.has(targetValue) ||
                                  !ruleParams.has(targetValue))

            if (shouldReplace) {
              rule[targetField] = smartGroupName
              replacedCount++
              console.log('[Smart Override] Replaced rule target:', targetValue, '→', smartGroupName)
            }
          }
        }
        return rule
      })
      }

      console.log('[Smart Override] Rules processed, replaced', replacedCount, 'non-DIRECT rules with', smartGroupName)
    } else {
      console.log('[Smart Override] No rules found or rules is not an array')
    }

    console.log('[Smart Override] Configuration processed successfully')
    return config
  } catch (error) {
    console.error('[Smart Override] Error processing config:', error)
    throw error
  }
}
`
}

export function smartOverrideContent(document: unknown): string | undefined {
  return configurationEditDocument(document).globalOverrides.find(
    (item) => item.id === SMART_OVERRIDE_ID
  )?.content
}

export function updateSmartOverride(
  document: unknown,
  settings?: SmartOverrideSettings
): ConfigurationEditDocument {
  const next = configurationEditDocument(document)
  next.globalOverrides = next.globalOverrides.filter((item) => item.id !== SMART_OVERRIDE_ID)
  if (settings)
    next.globalOverrides.push({
      id: SMART_OVERRIDE_ID,
      kind: 'js',
      role: 'smart',
      content: smartOverrideTemplate(settings)
    })
  return configurationEditDocument(next)
}
