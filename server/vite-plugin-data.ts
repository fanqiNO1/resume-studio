/**
 * data/ 的读写 REST API，以 Vite 中间件形式提供。
 *
 * 为什么做成 Vite 插件而不是独立 server：`npm run dev` 一条命令就能跑起全套，
 * 不用管两个进程的启动顺序与端口。
 *
 * 写入策略（AGENTS.md §2 第 1 条）：
 *   - 一律原子写：写 .tmp 再 rename，避免半截文件
 *   - 覆盖前先把旧内容备份到 data/.trash/
 *   - 删除 = 移到 data/.trash/，不真删
 */
import { readFile, writeFile, rename, mkdir, readdir, rm, stat, cp } from 'node:fs/promises'
import path from 'node:path'
import type { Connect, Plugin, ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { exportPositionPdf, closeBrowser } from './export'

const DATA_DIR = path.resolve(process.cwd(), 'data')
const POSITIONS_DIR = path.join(DATA_DIR, 'positions')
const TEMPLATES_DIR = path.join(DATA_DIR, 'templates')
const TRASH_DIR = path.join(DATA_DIR, '.trash')

/**
 * 示例数据目录：仓库里只存这个，真实的 data/ 被 .gitignore 忽略。
 *
 * 首次启动时若 data/ 不存在，就从 data.sample/ 复制一份过去 —— 这样 clone
 * 下来直接就能跑，同时**不会**有人不小心把自己的简历 push 上去。
 */
const SAMPLE_DIR = path.resolve(process.cwd(), 'data.sample')

/** 岗位 id 直接来自目录名，必须严格校验以防路径穿越 */
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/

function assertId(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, `非法 id：${id}`)
  return id
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** 稳定序列化：2 空格缩进、末尾换行。让 git diff 可读。 */
function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 原子写 + 覆盖前备份 */
async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })

  let previous: string | null = null
  try {
    previous = await readFile(filePath, 'utf8')
  } catch {
    // 新文件，无需备份
  }
  if (previous !== null && previous !== content) {
    const rel = path.relative(DATA_DIR, filePath).replace(/[/\\]/g, '__')
    const backup = path.join(TRASH_DIR, 'autosave', `${timestamp()}__${rel}`)
    await mkdir(path.dirname(backup), { recursive: true })
    await writeFile(backup, previous, 'utf8')
    void pruneAutosave()
  }

  const tmp = `${filePath}.tmp`
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, filePath)
}

/**
 * 自动备份保留上限。
 *
 * 定在 500 而不是更激进的数字：这里存的是你的真实简历历史，删掉不可逆
 * （AGENTS.md §2 第 1 条）。500 份足够覆盖「今天改崩了想退回去」，又能把
 * 目录规模钉死。当前仓库里是 208 份，也就是说这个上限暂时不会删任何东西。
 * 觉得留太多就把这个数调小。
 */
const AUTOSAVE_KEEP = 500
/** 清理节流：写入很频繁，不必每次都 readdir 整个目录 */
const PRUNE_INTERVAL_MS = 10 * 60 * 1000
let lastPrune = 0

/**
 * 清理过量的自动备份。
 *
 * 之前只写不删，几天就攒了两百多个文件。除了占地方，还会耗尽系统的 inotify
 * 配额，让 dev server 以 ENOSPC 崩在启动阶段（vite.config.ts 已把这个目录
 * 排除出监听，这里再从源头限制数量）。
 *
 * 文件名以 ISO 时间戳开头，按名字排序即按时间排序，不用 stat 每个文件。
 * 失败只记日志不抛：清理归档失败不该影响保存。
 */
async function pruneAutosave(force = false): Promise<void> {
  const now = Date.now()
  if (!force && now - lastPrune < PRUNE_INTERVAL_MS) return
  lastPrune = now

  const dir = path.join(TRASH_DIR, 'autosave')
  try {
    const names = (await readdir(dir)).sort()
    for (const name of names.slice(0, Math.max(0, names.length - AUTOSAVE_KEEP))) {
      await rm(path.join(dir, name), { force: true })
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn('[data] 清理自动备份失败：', err)
    }
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, 'utf8')) as T
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

/**
 * 列出岗位：扫目录，不读索引文件。
 * 这样用户 `cp -r` 一个目录就是一次 fork，应用自动认领（见 AGENTS.md §5）。
 */
async function listPositions(): Promise<{ id: string; position: unknown }[]> {
  if (!(await exists(POSITIONS_DIR))) return []
  const dirs = await readdir(POSITIONS_DIR, { withFileTypes: true })
  const out: { id: string; position: unknown }[] = []
  for (const d of dirs) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue
    const file = path.join(POSITIONS_DIR, d.name, 'position.json')
    if (!(await exists(file))) continue
    try {
      out.push({ id: d.name, position: await readJson(file) })
    } catch (err) {
      console.error(`[data] 跳过无法解析的岗位 ${d.name}:`, err)
    }
  }
  const order = (p: unknown) =>
    (p as { meta?: { order?: number } })?.meta?.order ?? Number.MAX_SAFE_INTEGER
  return out.sort((a, b) => order(a.position) - order(b.position) || a.id.localeCompare(b.id))
}

async function listTemplates(): Promise<unknown[]> {
  if (!(await exists(TEMPLATES_DIR))) return []
  const files = await readdir(TEMPLATES_DIR)
  const out: unknown[] = []
  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      out.push(await readJson(path.join(TEMPLATES_DIR, f)))
    } catch (err) {
      console.error(`[data] 跳过无法解析的模板 ${f}:`, err)
    }
  }
  return out
}

async function localItems(id: string): Promise<Record<string, unknown>> {
  const file = path.join(POSITIONS_DIR, id, 'local-items.json')
  if (!(await exists(file))) return {}
  return readJson(file)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      // 简历 JSON 不该超过 8MB；超过说明出了问题，早失败
      if (size > 8 * 1024 * 1024) reject(new HttpError(413, '请求体过大'))
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(body)
}

/** 递归复制岗位目录，但不带导出产物 —— fork 复制的是覆盖层，不是旧 PDF */
async function forkPosition(from: string, to: string): Promise<void> {
  const src = path.join(POSITIONS_DIR, from)
  const dest = path.join(POSITIONS_DIR, to)
  if (!(await exists(src))) throw new HttpError(404, `岗位不存在：${from}`)
  if (await exists(dest)) throw new HttpError(409, `岗位已存在：${to}`)
  await cp(src, dest, {
    recursive: true,
    filter: (s) => !s.endsWith('.pdf'),
  })
}

async function trashPosition(id: string): Promise<string> {
  const src = path.join(POSITIONS_DIR, id)
  if (!(await exists(src))) throw new HttpError(404, `岗位不存在：${id}`)
  const dest = path.join(TRASH_DIR, `${timestamp()}__${id}`)
  await mkdir(TRASH_DIR, { recursive: true })
  await rename(src, dest)
  return path.relative(DATA_DIR, dest)
}

async function restorePosition(trashName: string): Promise<string> {
  const src = path.join(TRASH_DIR, trashName)
  if (!(await exists(src))) throw new HttpError(404, '回收站里找不到该记录')
  // 目录名格式为 <时间戳>__<岗位 id>
  const sep = trashName.indexOf('__')
  const id = assertId(sep >= 0 ? trashName.slice(sep + 2) : trashName)
  const dest = path.join(POSITIONS_DIR, id)
  if (await exists(dest)) throw new HttpError(409, `岗位已存在：${id}`)
  await rename(src, dest)
  return id
}

/**
 * 首次启动时用示例数据初始化 data/。
 *
 * 只在 data/profile.json 缺失时触发，已经有内容一律不碰。
 */
async function seedDataFromSample(): Promise<void> {
  if (await exists(path.join(DATA_DIR, 'profile.json'))) return
  if (!(await exists(path.join(SAMPLE_DIR, 'profile.json')))) return
  await cp(SAMPLE_DIR, DATA_DIR, { recursive: true })
  console.log('[data] 未发现 data/，已用 data.sample/ 初始化（示例数据，可直接编辑或删除）')
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const p = url.pathname
  if (!p.startsWith('/api/')) return false

  // ---- 一次性拉取全部数据（前端启动时用） ----
  if (p === '/api/bootstrap' && req.method === 'GET') {
    const positions = await listPositions()
    const withLocals = await Promise.all(
      positions.map(async (e) => ({ ...e, localItems: await localItems(e.id) })),
    )
    sendJson(res, 200, {
      profile: await readJson(path.join(DATA_DIR, 'profile.json')),
      positions: withLocals,
      templates: await listTemplates(),
    })
    return true
  }

  if (p === '/api/profile' && req.method === 'PUT') {
    const body = await readBody(req)
    // 先 parse 验证是合法 JSON，再落盘；不校验 schema（前端已校验，服务端不重复业务逻辑）
    const parsed: unknown = JSON.parse(body)
    await atomicWrite(path.join(DATA_DIR, 'profile.json'), serialize(parsed))
    sendJson(res, 200, { ok: true })
    return true
  }

  const posMatch = p.match(/^\/api\/positions\/([^/]+)(\/.*)?$/)
  if (posMatch) {
    const id = assertId(decodeURIComponent(posMatch[1]))
    const rest = posMatch[2] ?? ''

    if (rest === '' && req.method === 'PUT') {
      const parsed: unknown = JSON.parse(await readBody(req))
      await atomicWrite(path.join(POSITIONS_DIR, id, 'position.json'), serialize(parsed))
      sendJson(res, 200, { ok: true })
      return true
    }

    if (rest === '' && req.method === 'DELETE') {
      const trashed = await trashPosition(id)
      sendJson(res, 200, { ok: true, trashed })
      return true
    }

    if (rest === '/local-items' && req.method === 'PUT') {
      const parsed: unknown = JSON.parse(await readBody(req))
      await atomicWrite(path.join(POSITIONS_DIR, id, 'local-items.json'), serialize(parsed))
      sendJson(res, 200, { ok: true })
      return true
    }

    if (rest === '/export' && req.method === 'POST') {
      const port = Number(process.env.__RESUME_PORT__ ?? 5178)
      const result = await exportPositionPdf({ id, port, dataDir: DATA_DIR })
      sendJson(res, 200, { ok: true, ...result })
      return true
    }

    if (rest === '/pdf' && req.method === 'GET') {
      const name = url.searchParams.get('name') ?? ''
      const file = path.join(POSITIONS_DIR, id, name)
      if (!name.endsWith('.pdf') || path.dirname(file) !== path.join(POSITIONS_DIR, id)) {
        throw new HttpError(400, '非法文件名')
      }
      if (!(await exists(file))) throw new HttpError(404, 'PDF 尚未生成')
      const buf = await readFile(file)
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/pdf')
      res.setHeader('Content-Length', String(buf.length))
      // 通过端口转发在另一台机器上访问时，这个响应头让浏览器直接下载
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      res.end(buf)
      return true
    }
  }

  if (p === '/api/positions' && req.method === 'POST') {
    const payload = JSON.parse(await readBody(req)) as {
      id: string
      forkFrom?: string
      position?: unknown
    }
    const id = assertId(payload.id)
    if (payload.forkFrom) {
      await forkPosition(assertId(payload.forkFrom), id)
    }
    if (payload.position) {
      await atomicWrite(path.join(POSITIONS_DIR, id, 'position.json'), serialize(payload.position))
    }
    sendJson(res, 200, { ok: true, id })
    return true
  }

  if (p === '/api/trash' && req.method === 'GET') {
    if (!(await exists(TRASH_DIR))) {
      sendJson(res, 200, { entries: [] })
      return true
    }
    const items = await readdir(TRASH_DIR, { withFileTypes: true })
    sendJson(res, 200, {
      entries: items.filter((d) => d.isDirectory()).map((d) => d.name),
    })
    return true
  }

  if (p === '/api/trash/restore' && req.method === 'POST') {
    const { name } = JSON.parse(await readBody(req)) as { name: string }
    const id = await restorePosition(name)
    sendJson(res, 200, { ok: true, id })
    return true
  }

  throw new HttpError(404, `未知接口：${req.method} ${p}`)
}

export function dataApiPlugin(): Plugin {
  return {
    name: 'resume-data-api',
    configureServer(server: ViteDevServer) {
      const port = server.config.server.port ?? 5178
      process.env.__RESUME_PORT__ = String(port)

      // 启动时先收一次：老仓库里可能已经攒了上百个备份
      void pruneAutosave(true)
      // data/ 不存在时用示例数据兜底，保证 clone 下来就能跑
      void seedDataFromSample()

      const middleware: Connect.NextHandleFunction = (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next()
        handle(req, res).then(
          (handled) => {
            if (!handled) next()
          },
          (err: unknown) => {
            const status = err instanceof HttpError ? err.status : 500
            const message = err instanceof Error ? err.message : String(err)
            if (status >= 500) console.error('[data api]', err)
            sendJson(res, status, { ok: false, error: message })
          },
        )
      }
      server.middlewares.use(middleware)

      server.httpServer?.on('close', () => {
        void closeBrowser()
      })
    },
    async buildEnd() {
      await closeBrowser()
    },
  }
}

export { DATA_DIR, POSITIONS_DIR, serialize, atomicWrite, listPositions, listTemplates }
