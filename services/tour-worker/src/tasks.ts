// Các tác vụ nền. Hàng đợi nằm trong PostgreSQL (FOR UPDATE SKIP LOCKED), không cần Redis. Giới hạn:
// thăm dò theo chu kỳ nên độ trễ bằng chu kỳ thăm dò, và lưu lượng rất lớn sẽ đè lên database. Đổi sang
// Redis/BullMQ khi cần: chỉ thay file này, các RPC worker_* không đổi.
import type { Pool, PoolClient } from 'pg'

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

/**
 * Xử lý outbox: dựng thông báo nội bộ và ghi nhận việc đẩy tình trạng chỗ. Với kết nối mô phỏng, việc
 * đẩy chỉ được ghi sync_job có nhãn simulated: KHÔNG có request nào đi ra ngoài, và connector thật
 * chưa tồn tại, nên kết nối không-mock có khả năng này bị ghi needs_connector thay vì báo thành công.
 */
export async function drainOutbox(pool: Pool, log: Log, limit = 50): Promise<number> {
  const { rows } = await pool.query('select * from public.worker_claim_outbox($1)', [limit])
  for (const e of rows) {
    try {
      await pool.query('select public.worker_notify($1)', [e.id])
      if (e.topic === 'availability.changed') {
        await pool.query(
          `insert into public.sync_jobs (organization_id, connection_id, kind, status, detail, finished_at)
           select c.organization_id, c.id, 'availability_push', 'done',
             jsonb_build_object('outcome', case when c.mode = 'mock' then 'simulated' else 'needs_connector' end, 'outbox_id', $2::bigint), now()
           from public.channel_connections c
           where c.organization_id = $1 and c.status <> 'disabled'
             and c.capabilities ->> 'provide_availability' = 'supported'
             and not exists (
               select 1 from public.sync_jobs j
               where j.connection_id = c.id and j.kind = 'availability_push' and j.created_at > now() - interval '1 minute'
             )`,
          [e.organization_id, e.id],
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

export async function markStale(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select public.worker_mark_stale_connections() as n')
  return rows[0]?.n ?? 0
}

export async function purgePayloads(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select public.worker_purge_payloads() as n')
  return rows[0]?.n ?? 0
}
