// Các tác vụ nền. Hàng đợi nằm trong PostgreSQL (FOR UPDATE SKIP LOCKED), không cần Redis. Giới hạn:
// thăm dò theo chu kỳ nên độ trễ bằng chu kỳ thăm dò, và lưu lượng rất lớn sẽ đè lên database. Đổi sang
// Redis/BullMQ khi cần: chỉ thay file này, các RPC worker_* không đổi.
import { mockAvailability, mockCatalog } from '@tours/channels'
import { sendAvailabilityUpdate, type NotifyConfig, type NotifyTarget } from '@tours/gyg'
import type { Pool, PoolClient } from 'pg'
import { sendOutboxEmails, smtpSender, type Sender } from './email.ts'

export type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) => void

async function inTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    const out = await fn(c)
    await c.query('commit')
    return out
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

export async function expireHolds(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select public.worker_expire_holds() as n')
  return rows[0]?.n ?? 0
}

export async function retryEvents(pool: Pool): Promise<number> {
  return inTx(pool, async (c) => {
    const { rows } = await c.query<{ r: { retried: number } }>('select public.worker_retry_events(50) as r')
    return rows[0]?.r.retried ?? 0
  })
}

/** Thông tin gọi GetYourGuide, chỉ có khi đủ cả ba biến môi trường. */
export function gygNotifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfig | null {
  const { GYG_API_BASE, GYG_API_USERNAME, GYG_API_PASSWORD } = env
  if (!GYG_API_BASE || !GYG_API_USERNAME || !GYG_API_PASSWORD) return null
  return { baseUrl: GYG_API_BASE, username: GYG_API_USERNAME, password: GYG_API_PASSWORD }
}

/**
 * Báo số chỗ mới của một chuyến cho GetYourGuide (bắt buộc theo tài liệu GetYourGuide). Trả id các kết nối
 * đã xử lý để phần ghi needs_connector bỏ qua chúng. Mỗi lần gửi ghi một sync_job, thành công hay lỗi.
 */
export async function pushGygAvailability(
  pool: Pool,
  log: Log,
  e: { id: number; organization_id: string; aggregate_id: string },
  cfg: NotifyConfig | null,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  if (!cfg) return []
  const { rows } = await pool.query<{ r: NotifyTarget[] }>('select public.worker_gyg_availability($1) as r', [e.aggregate_id])
  const targets = rows[0]?.r ?? []
  for (const t of targets) {
    let outcome: Record<string, unknown>
    try {
      const res = await sendAvailabilityUpdate(cfg, t, fetchFn)
      outcome = { outcome: res.ok ? 'sent' : 'rejected', http_status: res.status, error_code: res.errorCode ?? null }
      if (!res.ok) log('warn', 'GetYourGuide từ chối cập nhật chỗ', { connection_id: t.connection_id, status: res.status, error_code: res.errorCode })
    } catch (err) {
      outcome = { outcome: 'failed', message: err instanceof Error ? err.message : String(err) }
      log('error', 'không gửi được cập nhật chỗ tới GetYourGuide', { connection_id: t.connection_id, ...outcome })
    }
    await pool.query(
      `insert into public.sync_jobs (organization_id, connection_id, kind, status, detail, finished_at)
       values ($1, $2, 'availability_push', $3, $4, now())`,
      [e.organization_id, t.connection_id, outcome.outcome === 'sent' ? 'done' : 'failed', { ...outcome, product_id: t.product_id, outbox_id: e.id }],
    )
  }
  return [...new Set(targets.map((t) => t.connection_id))]
}

/**
 * Xử lý outbox: dựng thông báo nội bộ và ghi nhận việc đẩy tình trạng chỗ. Kết nối GetYourGuide thật được
 * báo chỗ khi đã cấu hình GYG_API_*. Với kết nối mô phỏng, việc đẩy chỉ được ghi sync_job có nhãn
 * simulated: KHÔNG có request nào đi ra ngoài; kết nối không-mock chưa có connector bị ghi needs_connector
 * thay vì báo thành công.
 */
export async function drainOutbox(
  pool: Pool, log: Log, limit = 50, gyg: NotifyConfig | null = gygNotifyConfig(), mail: Sender = smtpSender(),
): Promise<number> {
  const { rows } = await pool.query('select * from public.worker_claim_outbox($1)', [limit])
  for (const e of rows) {
    try {
      await pool.query('select public.worker_notify($1)', [e.id])
      // Email yêu cầu đặt từ website và email thử; lỗi gửi được ghi vào email_log, không làm hỏng outbox.
      if (e.topic === 'booking.created' || e.topic === 'email.test') await sendOutboxEmails(pool, log, Number(e.id), mail)
      if (e.topic === 'availability.changed') {
        const pushed = await pushGygAvailability(pool, log, e, gyg)
        await pool.query(
          `insert into public.sync_jobs (organization_id, connection_id, kind, status, detail, finished_at)
           select c.organization_id, c.id, 'availability_push', 'done',
             jsonb_build_object('outcome', case when c.mode = 'mock' then 'simulated' else 'needs_connector' end, 'outbox_id', $2::bigint), now()
           from public.channel_connections c
           where c.organization_id = $1 and c.status <> 'disabled'
             and c.capabilities ->> 'provide_availability' = 'supported'
             and not (c.id = any($3::uuid[]))
             and not exists (
               select 1 from public.sync_jobs j
               where j.connection_id = c.id and j.kind = 'availability_push' and j.created_at > now() - interval '1 minute'
             )`,
          [e.organization_id, e.id, pushed],
        )
      }
      await pool.query('select public.worker_finish_outbox($1, null)', [e.id])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('error', 'outbox thất bại', { id: e.id, topic: e.topic, correlation_id: e.correlation_id, message })
      await pool.query('select public.worker_finish_outbox($1, $2)', [e.id, message])
    }
  }
  return rows.length
}

/**
 * Đồng bộ danh mục cho kết nối đến hạn. Chỉ kết nối mô phỏng có nguồn dữ liệu. Kết nối thật được ghi lỗi
 * rõ ràng thay vì báo đã đồng bộ: chưa có connector, và lịch thì Supplier API của Viator không cho kéo về.
 */
export async function syncCatalogs(pool: Pool, log: Log): Promise<number> {
  const { rows } = await pool.query<{ id: string; channel: string; mode: string; mock_catalog_version: number }>(
    'select * from public.worker_catalog_due()',
  )
  let done = 0
  for (const c of rows) {
    if (c.mode !== 'mock' || (c.channel !== 'viator' && c.channel !== 'getyourguide')) {
      await pool.query('select public.worker_catalog_failed($1, $2, $3)', [c.id, 'needs_connector', 'Chưa có connector thật cho kết nối này'])
      log('warn', 'bỏ qua đồng bộ danh mục: chưa có connector', { connection_id: c.id })
      continue
    }
    const products = mockCatalog(c.channel, c.mock_catalog_version)
    await inTx(pool, async (tx) => {
      // RPC chỉ nhận chiều kênh từ service_role, giống cổng thật sau này.
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'service_role' })])
      await tx.query('select public.channel_catalog_ingest($1, $2, true)', [c.id, JSON.stringify(products)])
      await tx.query('select public.channel_availability_ingest($1, $2)', [c.id, JSON.stringify(mockAvailability(products, new Date()))])
    })
    done += 1
  }
  return done
}

export async function markStale(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select public.worker_mark_stale_connections() as n')
  return rows[0]?.n ?? 0
}

export async function purgePayloads(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select public.worker_purge_payloads() as n')
  return rows[0]?.n ?? 0
}
