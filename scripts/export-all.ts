/**
 * 批量导出所有岗位的 PDF。
 *
 * 需要 dev server 在跑（导出走服务端的 /api/.../export，与手点按钮同一条路径，
 * 避免两套导出实现产生分歧）。
 */
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const PORT = Number(process.env.PORT ?? 5178)
const ORIGIN = `http://127.0.0.1:${PORT}`

interface ExportResponse {
  ok: boolean
  error?: string
  filename?: string
  pages?: number
  bytes?: number
  ms?: number
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('-'))

  try {
    const probe = await fetch(`${ORIGIN}/api/bootstrap`)
    if (!probe.ok) throw new Error(String(probe.status))
  } catch {
    console.error(`连不上 ${ORIGIN}。请先在另一个终端跑 npm run dev。`)
    process.exit(1)
  }

  const dir = path.resolve(process.cwd(), 'data/positions')
  const entries = await readdir(dir, { withFileTypes: true })
  const ids = entries
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((id) => only.length === 0 || only.includes(id))

  if (ids.length === 0) {
    console.error(only.length ? `没有匹配的岗位：${only.join(', ')}` : 'data/positions/ 是空的')
    process.exit(1)
  }

  let failed = 0
  for (const id of ids) {
    const res = await fetch(`${ORIGIN}/api/positions/${encodeURIComponent(id)}/export`, {
      method: 'POST',
    })
    const data = (await res.json()) as ExportResponse
    if (!data.ok) {
      failed++
      console.error(`✗ ${id}：${data.error}`)
      continue
    }
    console.log(
      `✓ ${id} → ${data.filename}（${data.pages} 页，` +
        `${((data.bytes ?? 0) / 1024).toFixed(0)} KB，${data.ms}ms）`,
    )
  }

  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
