import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { gygNotifyConfig, pushGygAvailability, type Log } from './tasks.ts'

// Pool giả: trả mục tiêu cho worker_gyg_availability, ghi lại các sync_job được chèn.
function fakePool(targets: unknown[]) {
  const inserts: unknown[][] = []
  const queries: string[] = []
  const pool = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push(sql)
      if (sql.includes('worker_gyg_availability')) return { rows: [{ r: targets }] }
      if (sql.includes('insert into public.sync_jobs')) inserts.push(params)
      return { rows: [] }
    },
  } as unknown as Pool
  return { pool, inserts, queries }
}

const logs: unknown[] = []
const log: Log = (level, msg, extra) => logs.push({ level, msg, extra })
const event = { id: 7, organization_id: 'org', aggregate_id: 'dep-1' }
const cfg = { baseUrl: 'https://gyg.test', username: 'u', password: 'p' }
const target = (connection_id: string, product_id: string) => ({
  connection_id,
  product_id,
  items: [{ local_date: '2030-06-10', local_time: '08:00:00', starts_at: '2030-06-10T01:00:00Z', vacancies: 3 }],
})

describe('báo số chỗ cho GetYourGuide', () => {
  it('thiếu cấu hình GYG_API_* thì không gửi, không đọc database', async () => {
    expect(gygNotifyConfig({ GYG_API_BASE: 'x', GYG_API_USERNAME: 'u' })).toBeNull()
    expect(gygNotifyConfig({ GYG_API_BASE: 'https://gyg.test', GYG_API_USERNAME: 'u', GYG_API_PASSWORD: 'p' })).toEqual(cfg)
    const { pool, queries } = fakePool([target('c1', 'P1')])
    expect(await pushGygAvailability(pool, log, event, null)).toEqual([])
    expect(queries).toHaveLength(0)
  })

  it('gửi từng sản phẩm, ghi sync_job done/failed, trả các kết nối đã xử lý', async () => {
    const { pool, inserts } = fakePool([target('c1', 'P1'), target('c1', 'P2'), target('c2', 'P3')])
    const bodies: any[] = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body))
      bodies.push(body)
      if (body.data.productId === 'P2') return new Response(JSON.stringify({ errorCode: 'INVALID_PRODUCT' }), { status: 400 })
      if (body.data.productId === 'P3') throw new Error('timeout')
      return new Response('{}', { status: 202 })
    }) as unknown as typeof fetch

    const handled = await pushGygAvailability(pool, log, event, cfg, fetchFn)
    expect(handled).toEqual(['c1', 'c2'])
    expect(bodies[0]).toEqual({ data: { productId: 'P1', availabilities: [{ dateTime: '2030-06-10T08:00:00+07:00', vacancies: 3 }] } })
    expect(inserts.map((p) => [p[1], p[2], (p[3] as any).outcome])).toEqual([
      ['c1', 'done', 'sent'],
      ['c1', 'failed', 'rejected'],
      ['c2', 'failed', 'failed'],
    ])
    expect(inserts[1]![3]).toMatchObject({ http_status: 400, error_code: 'INVALID_PRODUCT', product_id: 'P2', outbox_id: 7 })
  })
})
