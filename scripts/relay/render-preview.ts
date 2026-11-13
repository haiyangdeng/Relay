import { writeMaintenancePreview } from './maintenance-preview'

try {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--output') throw new Error()
  await writeMaintenancePreview(args[1])
  process.stdout.write('已生成静态HTML演示，没有启动App、浏览器、原生后台或网络。\n')
} catch {
  process.stderr.write(
    '静态导出未完成。用法：pnpm exec tsx --tsconfig tsconfig.web.json scripts/relay/render-preview.ts --output <新的.html路径>；不会覆盖已有文件。\n'
  )
  process.exitCode = 1
}
