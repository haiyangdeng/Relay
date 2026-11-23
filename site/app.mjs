const workflows = {
  code: {
    client: 'Claude Code',
    detail: '客户端代理配置',
    icon: '#i-terminal',
    title: '终端照常使用，配置集中管理。',
    description:
      '检查 Relay 当前专用 HTTP 代理后，再应用 Claude Code 代理配置。修改前保存备份，保留无关配置与已有绕过项，支持恢复。',
    points: [
      '使用 Relay 当前拥有的专用代理端口',
      '已有终端会话需重启后读取新配置',
      '不会承诺拦截绕过代理的任意进程'
    ]
  },
  browser: {
    client: '专用浏览器',
    detail: '独立配置目录',
    icon: '#i-globe',
    title: '专门的入口，对应当前的代理。',
    description:
      '使用独立 Chrome 配置目录，通过 RelayBrowser 入口核对 Relay 当前专用代理。桌面登录可临时切换 HTTP/HTTPS 默认入口，并保存恢复记录。',
    points: [
      '代理归属与当前运行状态必须匹配',
      '不回退到其他代理软件或日常浏览器',
      '完成桌面登录后可恢复默认浏览器'
    ]
  },
  codex: {
    client: 'Codex',
    detail: '专用代理配置',
    icon: '#i-code',
    title: '为开发工具保留专用连接。',
    description:
      '在 AI 工作区集中管理 Codex 的代理设置，将需要经过代理的请求交给选定的专用出口。使用前核对客户端配置和实际连接状态。',
    points: [
      '专用出口与普通系统代理分别管理',
      '规则和绕过项仍影响实际连接路径',
      '不宣称拦截所有 Codex 进程的直连'
    ]
  }
}

const tabs = [...document.querySelectorAll('[data-workflow]')]
function selectWorkflow(tab) {
  const item = workflows[tab.dataset.workflow]
  if (!item) return
  for (const button of tabs) {
    const selected = button === tab
    button.setAttribute('aria-selected', String(selected))
    button.tabIndex = selected ? 0 : -1
  }
  document.querySelector('#workflow-panel').setAttribute('aria-labelledby', tab.id)
  document.querySelector('#flow-client').textContent = item.client
  document.querySelector('#flow-client-detail').textContent = item.detail
  document.querySelector('#flow-icon').setAttribute('href', item.icon)
  document
    .querySelector('.flow-diagram')
    .setAttribute('aria-label', `${item.client} 经 Relay 专用代理连接指定节点`)
  document.querySelector('#workflow-title').textContent = item.title
  document.querySelector('#workflow-description').textContent = item.description
  document.querySelector('#workflow-points').replaceChildren(
    ...item.points.map((point) => {
      const li = document.createElement('li')
      li.textContent = point
      return li
    })
  )
}
tabs.forEach((tab, index) => {
  tab.addEventListener('click', () => selectWorkflow(tab))
  tab.addEventListener('keydown', (event) => {
    let next
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = tabs.length - 1
    if (next !== undefined) {
      event.preventDefault()
      tabs[next].focus()
      selectWorkflow(tabs[next])
    }
  })
})

function githubRepository(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'github.com' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null
    if (!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)) return null
    return `${url.origin}${url.pathname.replace(/\/$/, '')}`
  } catch {
    return null
  }
}

function downloadableAsset(release, asset, repository) {
  if (
    release.status !== 'published' ||
    !repository ||
    !asset ||
    !/^[a-f0-9]{64}$/i.test(asset.sha256 ?? '')
  )
    return null
  if (
    typeof asset.filename !== 'string' ||
    !/^Relay-[A-Za-z0-9._-]+\.(zip|dmg|pkg)$/.test(asset.filename)
  )
    return null
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(release.version)) return null
  if (typeof release.publishedAt !== 'string' || !Number.isFinite(Date.parse(release.publishedAt)))
    return null
  try {
    const url = new URL(asset.url)
    const expected = `${repository}/releases/download/v${release.version}/${asset.filename}`
    if (url.href !== expected) return null
    return url.href
  } catch {
    return null
  }
}

function appVersion(release) {
  return release.version.replace(/-build\.\d+$/, '')
}

let manifest
const picker = document.querySelector('#release-version')
function renderRelease(version) {
  const release = manifest?.releases.find((item) => item.version === version)
  if (!release) return
  const repository = githubRepository(manifest.repositoryUrl)
  let ready = 0
  const cards = [...document.querySelectorAll('[data-arch]')]
  cards.forEach((card) => {
    const asset = release.assets.find((item) => item.arch === card.dataset.arch)
    const url = downloadableAsset(release, asset, repository)
    const button = card.querySelector('.download-button')
    const checksum = card.querySelector('.checksum')
    const metadata = card.querySelector('.asset-meta')
    button.replaceChildren(
      document.createTextNode(
        url ? `下载构建 ${asset.buildVersion ?? release.buildVersion}` : '待验证发布'
      )
    )
    button.removeAttribute('href')
    button.setAttribute('aria-disabled', String(!url))
    button.tabIndex = url ? 0 : -1
    checksum.hidden = !url
    checksum.open = false
    checksum.querySelector('code').textContent = ''
    checksum.querySelector('.copy-status').textContent = ''
    if (url) {
      ready += 1
      button.href = url
      metadata.textContent = asset.filename
      checksum.querySelector('code').textContent = asset.sha256.toLowerCase()
    } else {
      metadata.textContent = '安装包生成后，将在此提供下载及 SHA-256。'
    }
  })
  if (repository) {
    document.querySelector('#release-notes-link').href =
      `${repository}/releases/tag/v${release.version}`
  }
  document.querySelector('#minimum-os').textContent = `需要 ${release.minimumOS}`
  document.querySelector('#release-description').textContent = ready
    ? `V${appVersion(release)} · ${release.publishedAt.slice(0, 10)} 发布`
    : `V${appVersion(release)} 安装包待验证后发布。`
  document.querySelector('#release-status span:last-child').textContent =
    ready === cards.length
      ? '已发布 · 请按 Mac 芯片类型选择版本'
      : ready
        ? '部分安装包已发布 · 其余架构仍待验证'
        : '待验证发布 · 当前没有可下载的安装包'
  document.querySelector('.release-notes summary span:first-child').textContent =
    `V${appVersion(release)} 版本内容`
  document.querySelector('#release-notes-list').replaceChildren(
    ...release.notes.map((note) => {
      const li = document.createElement('li')
      li.textContent = note
      return li
    })
  )
}

function validManifest(value) {
  return (
    value &&
    value.schemaVersion === 1 &&
    typeof value.currentVersion === 'string' &&
    Array.isArray(value.releases) &&
    value.releases.length > 0 &&
    value.releases.some((r) => r.version === value.currentVersion) &&
    value.releases.every(
      (r) =>
        r &&
        /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(r.version) &&
        ['pending', 'published'].includes(r.status) &&
        typeof r.minimumOS === 'string' &&
        Array.isArray(r.assets) &&
        r.assets.every(
          (a) =>
            a &&
            ['arm64', 'x64'].includes(a.arch) &&
            /^[1-9]\d*$/.test(a.buildVersion ?? r.buildVersion ?? '')
        ) &&
        new Set(r.assets.map((a) => a.arch)).size === r.assets.length &&
        Array.isArray(r.notes) &&
        r.notes.every((n) => typeof n === 'string')
    ) &&
    new Set(value.releases.map((r) => r.version)).size === value.releases.length
  )
}

fetch('./releases.json', { cache: 'no-cache' })
  .then((response) => {
    if (!response.ok) throw new Error('manifest unavailable')
    return response.json()
  })
  .then((value) => {
    if (!validManifest(value)) throw new Error('manifest invalid')
    manifest = value
    const current = manifest.releases.find((release) => release.version === manifest.currentVersion)
    const available = current.assets.filter((asset) =>
      downloadableAsset(current, asset, githubRepository(manifest.repositoryUrl))
    ).length
    document.querySelector('.header-cta').firstChild.textContent = `V${appVersion(current)} `
    document.querySelector('.release-pill').textContent = `V${appVersion(current)}`
    document.querySelector('#release-strip-note').textContent = available
      ? '按 Mac 芯片类型选择对应安装包。'
      : '安装包将在验证完成后提供。'
    document
      .querySelector('.footer-note')
      .replaceChildren(
        document.createTextNode('基于开源，共同改进。'),
        document.createElement('br'),
        document.createTextNode(
          `GPL-3.0 · V${appVersion(current)}${available ? '' : ' 发布准备版'}`
        )
      )
    picker.replaceChildren(
      ...manifest.releases.map((release) => {
        const option = document.createElement('option')
        option.value = release.version
        const downloadable = release.assets.some((asset) =>
          downloadableAsset(release, asset, githubRepository(manifest.repositoryUrl))
        )
        option.textContent = `V${appVersion(release)} · ${downloadable ? release.publishedAt.slice(0, 10) : '待验证'}`
        return option
      })
    )
    picker.value = manifest.currentVersion
    const repo = githubRepository(manifest.repositoryUrl)
    if (repo) {
      const link = document.querySelector('#repository-link')
      link.href = repo
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.hidden = false
    }
    renderRelease(manifest.currentVersion)
  })
  .catch(() => {
    document.querySelector('#release-status span:last-child').textContent =
      '版本清单暂不可用 · 下载入口暂不开放'
  })
picker.addEventListener('change', () => renderRelease(picker.value))
document.querySelectorAll('.copy-checksum').forEach((button) => {
  button.addEventListener('click', async () => {
    const value = button.closest('.checksum').querySelector('code').textContent
    const status = button.parentElement.querySelector('.copy-status')
    try {
      await navigator.clipboard.writeText(value)
      status.textContent = '校验值已复制'
    } catch {
      status.textContent = '无法自动复制，请选择上方校验值复制。'
    }
  })
})
