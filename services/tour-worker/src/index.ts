// Worker nền của SAHA Tour Hub. Chạy một hoặc nhiều bản: SKIP LOCKED giữ cho chúng không xử lý trùng.
import { createServer } from 'node:http'
import pg from 'pg'
import { drainOutbox, expireHolds, markStale, purgePayloads, retryEvents, type Log } from './tasks.ts'

const connectionString = process.env.WORKER_DATABASE_URL
if (!connectionString) {
  console.error('Thiếu biến môi trường WORKER_DATABASE_URL')
  process.exit(1)
}

const POLL_MS = Number(process.env.WORKER_POLL_MS) || 5_000
const PORT = Number(process.env.WORKER_HEALTH_PORT) || 3102
const pool = new pg.Pool({ connectionString, max: 5 })

// Log dạng JSON một dòng. Không ghi payload sự kiện hay dữ liệu khách.
const log: Log = (level, msg, extra = {}) => {
  console[level === 'info' ? 'log' : level](JSON.stringify({ at: new Date().toISOString(), level, msg, ...extra }))
}

// Kết nối đang rảnh bị database cắt (khởi động lại, failover) sẽ phát sự kiện 'error' trên pool. Không có
// handler thì Node coi là lỗi chưa bắt và cả worker sập; có handler thì lượt thăm dò sau tự kết nối lại.
pool.on('error', (err) => log('warn', 'mất kết nối database, sẽ thử lại', { message: err.message }))

const state = { startedAt: new Date(), lastTickAt: null as Date | null, lastErrorAt: null as Date | null, lastError: null as string | null, ticks: 0 }

type Task = { name: string; everyMs: number; run: () => Promise<number>; nextAt: number }
const tasks: Task[] = [
  { name: 'outbox', everyMs: POLL_MS, run: () => drainOutbox(pool, log), nextAt: 0 },
  { name: 'expire_holds', everyMs: 15_000, run: () => expireHolds(pool), nextAt: 0 },
  { name: 'retry_events', everyMs: 15_000, run: () => retryEvents(pool), nextAt: 0 },
  { name: 'mark_stale', everyMs: 60_000, run: () => markStale(pool), nextAt: 0 },
  { name: 'purge_payloads', everyMs: 6 * 60 * 60_000, run: () => purgePayloads(pool), nextAt: 0 },
]

let stopping = false
let timer: NodeJS.Timeout | undefined

async function tick() {
  const now = Date.now()
  for (const t of tasks) {
    if (stopping || now < t.nextAt) continue
    t.nextAt = now + t.everyMs
    try {
      const n = await t.run()
      if (n > 0) log('info', t.name, { count: n })
    } catch (err) {
      state.lastErrorAt = new Date()
      state.lastError = err instanceof Error ? err.message : String(err)
      log('error', t.name, { message: state.lastError })
    }
  }
  state.lastTickAt = new Date()
  state.ticks += 1
  if (!stopping) timer = setTimeout(tick, POLL_MS)
}

// Khỏe nghĩa là vòng lặp còn chạy gần đây VÀ database trả lời được.
const health = createServer(async (req, res) => {
  if (req.url !== '/health') {
    res.writeHead(404).end()
    return
  }
  let db = false
  try {
    await pool.query('select 1')
    db = true
  } catch {
    db = false
  }
  const fresh = state.lastTickAt !== null && Date.now() - state.lastTickAt.getTime() < POLL_MS * 6
  const ok = db && fresh
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok, db, loop_fresh: fresh, ...state }))
})

async function stop() {
  stopping = true
  if (timer) clearTimeout(timer)
  health.close()
  await pool.end()
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())

health.listen(PORT, () => log('info', 'worker đã chạy', { health: `http://localhost:${PORT}/health`, poll_ms: POLL_MS }))
void tick()
