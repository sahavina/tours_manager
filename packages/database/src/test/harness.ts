// Công cụ cho test: mỗi lời gọi chạy trên một kết nối riêng, đúng role và JWT như PostgREST làm thật.
import { randomUUID } from 'node:crypto'
import pg from 'pg'

const pool = new pg.Pool({ connectionString: process.env.TOURS_TEST_DB, max: 20 })

export async function closePool() {
  await pool.end()
}

export type Actor = { sub?: string; role: 'authenticated' | 'anon' | 'service_role' }

export const anon: Actor = { role: 'anon' }
export const service: Actor = { role: 'service_role' }
export const user = (sub: string): Actor => ({ sub, role: 'authenticated' })

/** Chạy SQL dưới danh nghĩa một người dùng, trong giao dịch riêng, như một request PostgREST. */
export async function as<T = Record<string, unknown>>(
  actor: Actor,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const c = await pool.connect()
  try {
    await c.query('begin')
    await c.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ sub: actor.sub, role: actor.role }),
    ])
    await c.query(`set local role ${actor.role}`)
    const res = await c.query(sql, params)
    await c.query('commit')
    return res.rows as T[]
  } catch (e) {
    await c.query('rollback')
    throw e
  } finally {
    c.release()
  }
}

/** Gọi RPC trả jsonb. */
export async function rpc<T = any>(actor: Actor, fn: string, ...args: unknown[]): Promise<T> {
  const ph = args.map((_, i) => `$${i + 1}`).join(', ')
  const rows = await as<{ r: T }>(actor, `select public.${fn}(${ph}) as r`, args)
  return rows[0]!.r
}

/** Chạy bằng quyền owner để dựng dữ liệu và kiểm tra kết quả, không qua RLS. */
export async function owner<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params)
  return res.rows as T[]
}

export async function makeUser(email: string): Promise<string> {
  const id = randomUUID()
  await owner(`insert into auth.users (id, email) values ($1, $2)`, [id, email])
  return id
}

export type World = {
  org: string
  ownerId: string
  guideUser: string
  otherGuideUser: string
  operator: string
  accountant: string
  agent: string
  viewer: string
  outsider: string
  connection: string
  tour: string
  option: string
  transferOption: string
  guideId: string
  otherGuideId: string
  vehicleId: string
  departure: (date: string, capacity?: number) => Promise<string>
}

/** Một doanh nghiệp đầy đủ, tách biệt theo tiền tố, để các file test không dẫm lên nhau. */
export async function makeWorld(prefix: string): Promise<World> {
  const tag = `${prefix}-${randomUUID().slice(0, 8)}`
  const [o] = await owner<{ id: string }>(
    `insert into public.organizations (name, slug) values ($1, $2) returning id`,
    [`DN ${tag}`, tag],
  )
  const org = o!.id
  const ids: Record<string, string> = {}
  for (const [key, role] of [
    ['ownerId', 'owner'],
    ['guideUser', 'guide'],
    ['otherGuideUser', 'guide'],
    ['operator', 'operator'],
    ['accountant', 'accountant'],
    ['agent', 'booking_agent'],
    ['viewer', 'viewer'],
  ] as const) {
    const id = await makeUser(`${key}.${tag}@test.local`)
    ids[key] = id
    await owner(`insert into public.memberships (organization_id, user_id, role_key) values ($1, $2, $3)`, [
      org,
      id,
      role,
    ])
  }
  const outsider = await makeUser(`outsider.${tag}@test.local`)

  await owner(
    `insert into public.traveler_categories (organization_id, code, name, counts_as_seat, sort_order)
     values ($1, 'adult', 'Người lớn', true, 1), ($1, 'child', 'Trẻ em', true, 2), ($1, 'infant', 'Em bé', false, 3)`,
    [org],
  )

  const [conn] = await owner<{ id: string }>(
    `insert into public.channel_connections (organization_id, channel, account_name, hold_ttl_seconds)
     values ($1, 'viator', 'Mock', 900) returning id`,
    [org],
  )
  const [t] = await owner<{ id: string }>(
    `insert into public.tours (organization_id, code, name) values ($1, 'T1', 'Tour 1') returning id`,
    [org],
  )
  const [opt] = await owner<{ id: string }>(
    `insert into public.tour_options (organization_id, tour_id, code, name) values ($1, $2, 'O1', 'Không đón') returning id`,
    [org, t!.id],
  )
  const [opt2] = await owner<{ id: string }>(
    `insert into public.tour_options (organization_id, tour_id, code, name, has_transfer) values ($1, $2, 'O2', 'Có đón', true) returning id`,
    [org, t!.id],
  )
  await owner(
    `insert into public.channel_product_mappings
       (organization_id, connection_id, external_product_code, external_option_code, tour_option_id, is_verified)
     values ($1, $2, 'P1', '', $3, true), ($1, $2, 'P2', '', $4, true)`,
    [org, conn!.id, opt!.id, opt2!.id],
  )
  const [g] = await owner<{ id: string }>(
    `insert into public.guides (organization_id, profile_id, full_name) values ($1, $2, 'HDV A') returning id`,
    [org, ids.guideUser],
  )
  const [g2] = await owner<{ id: string }>(
    `insert into public.guides (organization_id, profile_id, full_name) values ($1, $2, 'HDV B') returning id`,
    [org, ids.otherGuideUser],
  )
  const [v] = await owner<{ id: string }>(
    `insert into public.vehicles (organization_id, name, seats) values ($1, 'Xe 4 chỗ', 4) returning id`,
    [org],
  )

  const departure = async (date: string, capacity = 10) => {
    const res = await rpc(user(ids.ownerId!), 'create_departure', org, t!.id, null, date, '08:00', 'Asia/Ho_Chi_Minh', capacity, null)
    if (!res.ok) throw new Error(`create_departure: ${res.code}`)
    return res.departure_id as string
  }

  return {
    org,
    ownerId: ids.ownerId!,
    guideUser: ids.guideUser!,
    otherGuideUser: ids.otherGuideUser!,
    operator: ids.operator!,
    accountant: ids.accountant!,
    agent: ids.agent!,
    viewer: ids.viewer!,
    outsider,
    connection: conn!.id,
    tour: t!.id,
    option: opt!.id,
    transferOption: opt2!.id,
    guideId: g!.id,
    otherGuideId: g2!.id,
    vehicleId: v!.id,
    departure,
  }
}

/** Sự kiện đầy đủ, chỉ cần ghi đè phần test quan tâm. */
export function bookingEvent(
  ref: string,
  date: string,
  over: { eventId?: string; version?: number; sourceAt?: string; type?: string; pax?: Record<string, number>; product?: string; data?: object; time?: string } = {},
) {
  return {
    event_id: over.eventId ?? `${ref}-${over.version ?? 1}`,
    type: over.type ?? 'booking.created',
    external_ref: ref,
    version: over.version ?? 1,
    source_at: over.sourceAt,
    data: {
      external_ref: ref,
      status: over.type === 'booking.cancelled' ? 'cancelled' : 'confirmed',
      channel_status: 'CONFIRMED',
      lead: { name: `Khách ${ref}`, email: `${ref}@example.com` },
      currency: 'USD',
      gross_amount: '100.00',
      items: [
        {
          product_code: over.product ?? 'P1',
          option_code: '',
          local_date: date,
          local_time: over.time ?? '08:00:00',
          pax: over.pax ?? { adult: 2 },
        },
      ],
      ...over.data,
    },
  }
}

export const seats = async (dep: string) => {
  const [r] = await owner<{ committed: number; held: number; available: number }>(
    `select public._pool_committed(d.inventory_pool_id) committed, public._pool_held(d.inventory_pool_id) held,
            public._pool_available(d.inventory_pool_id) available
     from public.departures d where d.id = $1`,
    [dep],
  )
  return r!
}
