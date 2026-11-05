// Phân quyền và tách doanh nghiệp. Bài phủ định luôn có đối chứng dương: "không thấy" phải là vì bị chặn,
// không phải vì không có dữ liệu.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, as, bookingEvent, closePool, makeWorld, owner, rpc, service, user, type World } from './test/harness'

let a: World
let b: World
let bookingA: string
let depA: string

beforeAll(async () => {
  a = await makeWorld('acc-a')
  b = await makeWorld('acc-b')
  depA = await a.departure('2030-01-01')
  const r = await rpc(service, 'ingest_channel_event', a.connection, bookingEvent('ACC-1', '2030-01-01', {
    data: { financials: { channel_fee: '20.00', expected_payout: '80.00' } } }))
  bookingA = r.booking_id
})
afterAll(closePool)

const TABLES = ['bookings', 'booking_items', 'tours', 'departures', 'customers', 'channel_connections', 'booking_financials', 'integration_events']

describe('hai doanh nghiệp', () => {
  it.each(TABLES)('chủ DN A đọc được %s của mình, chủ DN B không đọc được', async (t) => {
    const mine = await as(user(a.ownerId), `select 1 from public.${t} where organization_id = $1`, [a.org])
    expect(mine.length).toBeGreaterThan(0)
    const theirs = await as(user(b.ownerId), `select 1 from public.${t} where organization_id = $1`, [a.org])
    expect(theirs).toHaveLength(0)
  })

  it('view danh sách và view chỗ cũng không lộ chéo', async () => {
    expect((await as(user(a.ownerId), `select id from public.v_booking_list where id = $1`, [bookingA]))).toHaveLength(1)
    expect((await as(user(b.ownerId), `select id from public.v_booking_list where id = $1`, [bookingA]))).toHaveLength(0)
    expect((await as(user(a.ownerId), `select id from public.v_departure_availability where id = $1`, [depA]))).toHaveLength(1)
    expect((await as(user(b.ownerId), `select id from public.v_departure_availability where id = $1`, [depA]))).toHaveLength(0)
  })

  it('RPC chặn thao tác lên dữ liệu doanh nghiệp khác', async () => {
    await expect(rpc(user(b.ownerId), 'add_booking_note', bookingA, 'xâm nhập')).rejects.toThrow(/forbidden/)
    await expect(rpc(user(b.ownerId), 'set_departure_sale', depA, false)).rejects.toThrow(/forbidden/)
    await expect(rpc(user(b.ownerId), 'export_bookings', a.org, {})).rejects.toThrow(/forbidden/)
    await expect(rpc(user(b.ownerId), 'ingest_channel_event', a.connection, bookingEvent('X', '2030-01-01'))).rejects.toThrow(/forbidden/)
  })

  it('database chặn liên kết chéo doanh nghiệp bằng FK', async () => {
    await expect(owner(`insert into public.guide_assignments (organization_id, departure_id, guide_id) values ($1, $2, $3)`,
      [a.org, depA, b.guideId])).rejects.toThrow(/foreign key/)
    await expect(owner(`insert into public.booking_items (organization_id, booking_id, item_ref, tour_id) values ($1, $2, 'cross-org', $3)`,
      [a.org, bookingA, b.tour])).rejects.toThrow(/foreign key/)
  })

  it('không thể ghi tour vào doanh nghiệp khác', async () => {
    await expect(as(user(b.ownerId), `insert into public.tours (organization_id, code, name) values ($1, 'H', 'Hack')`, [a.org])).rejects.toThrow(/row-level security/)
  })

  it('người ngoài và anon không thấy gì', async () => {
    expect(await as(user(a.outsider), `select 1 from public.bookings`)).toHaveLength(0)
    await expect(as(anon, `select 1 from public.bookings`)).rejects.toThrow(/permission denied/)
    await expect(as(anon, `select public.my_org_context()`)).rejects.toThrow(/permission denied/)
  })
})

describe('hướng dẫn viên', () => {
  let assigned: string
  let other: string

  beforeAll(async () => {
    assigned = await a.departure('2030-02-01')
    other = await a.departure('2030-02-02')
    await rpc(service, 'ingest_channel_event', a.connection, bookingEvent('G-1', '2030-02-01', { data: { financials: { channel_fee: '12' } } }))
    await rpc(service, 'ingest_channel_event', a.connection, bookingEvent('G-2', '2030-02-02'))
    await rpc(user(a.operator), 'assign_guide', assigned, a.guideId, 'lead')
    await rpc(user(a.operator), 'assign_guide', other, a.otherGuideId, 'lead')
  })

  it('chỉ thấy chuyến được giao', async () => {
    const mine = await rpc(user(a.guideUser), 'guide_my_departures', '2030-01-01', '2030-12-31')
    expect(mine.map((d: any) => d.id)).toEqual([assigned])
  })

  it('xem được khách chuyến mình, không xem được chuyến người khác', async () => {
    const list = await rpc(user(a.guideUser), 'guide_manifest', assigned)
    expect(list.map((r: any) => r.code)).toHaveLength(1)
    expect(await rpc(user(a.guideUser), 'guide_manifest', other)).toEqual([])
  })

  it('danh sách khách không có tiền, phí hay lợi nhuận', async () => {
    const list = await rpc(user(a.guideUser), 'guide_manifest', assigned)
    const keys = Object.keys(list[0]).join(' ')
    expect(keys).not.toMatch(/gross|fee|amount|payout|profit|currency/)
  })

  it('không đọc trực tiếp được booking, tài chính, kết nối', async () => {
    for (const t of ['bookings', 'booking_financials', 'channel_connections', 'booking_items', 'expenses', 'integration_events']) {
      expect(await as(user(a.guideUser), `select 1 from public.${t} where organization_id = $1`, [a.org])).toHaveLength(0)
    }
  })

  it('điểm danh được chuyến mình, không được chuyến khác', async () => {
    const [item] = await owner<any>(`select id from public.booking_items where departure_id = $1`, [assigned])
    const [otherItem] = await owner<any>(`select id from public.booking_items where departure_id = $1`, [other])
    expect((await rpc(user(a.guideUser), 'set_attendance', assigned, item.id, 'picked_up', null)).ok).toBe(true)
    await expect(rpc(user(a.guideUser), 'set_attendance', other, otherItem.id, 'picked_up', null)).rejects.toThrow(/forbidden/)
  })

  it('booking hủy hoặc chuyển chuyến phản ánh vào danh sách và không xóa dấu vết điểm danh', async () => {
    const dep = await a.departure('2030-02-10')
    const dest = await a.departure('2030-02-11')
    const r = await rpc(service, 'ingest_channel_event', a.connection, bookingEvent('G-MV', '2030-02-10'))
    await rpc(user(a.operator), 'assign_guide', dep, a.guideId, 'lead')
    const [item] = await owner<any>(`select id from public.booking_items where booking_id = $1`, [r.booking_id])
    await rpc(user(a.guideUser), 'set_attendance', dep, item.id, 'no_show', 'Không thấy khách')
    await rpc(user(a.operator), 'move_booking_item', item.id, dest)

    const list = await rpc(user(a.guideUser), 'guide_manifest', dep)
    expect(list[0]).toMatchObject({ presence: 'moved', attendance: 'no_show' })

    const [att] = await owner<any>(`select status from public.attendance_records where booking_item_id = $1 and departure_id = $2`, [item.id, dep])
    expect(att.status).toBe('no_show')
  })
})

describe('vai trò', () => {
  it('nhân viên booking thấy booking nhưng không thấy phí kênh', async () => {
    expect(await as(user(a.agent), `select 1 from public.bookings where id = $1`, [bookingA])).toHaveLength(1)
    expect(await as(user(a.agent), `select 1 from public.booking_financials where booking_id = $1`, [bookingA])).toHaveLength(0)
    expect(await as(user(a.accountant), `select 1 from public.booking_financials where booking_id = $1`, [bookingA])).toHaveLength(1)
  })

  it('nhân viên booking lấy được người để gán phụ trách, chỉ có mã và tên, không gồm hướng dẫn viên', async () => {
    const list = await rpc(user(a.agent), 'member_assignable', a.org)
    expect(list.map((m: any) => m.user_id)).toContain(a.agent)
    expect(list.map((m: any) => m.user_id)).not.toContain(a.guideUser)
    expect(Object.keys(list[0]).sort()).toEqual(['name', 'user_id'])
    await expect(rpc(user(a.agent), 'member_list', a.org)).rejects.toThrow(/forbidden/)
    await expect(rpc(user(a.viewer), 'member_assignable', a.org)).rejects.toThrow(/forbidden/)
    await expect(rpc(user(b.ownerId), 'member_assignable', a.org)).rejects.toThrow(/forbidden/)

    const r = await rpc(user(a.agent), 'update_booking_internal', bookingA, { owner_id: a.agent })
    expect(r.ok).toBe(true)
    const [row] = await owner<any>(`select owner_id from public.bookings where id = $1`, [bookingA])
    expect(row.owner_id).toBe(a.agent)
  })

  it('chỉ xem không ghi được, kể cả qua RPC', async () => {
    await expect(rpc(user(a.viewer), 'add_booking_note', bookingA, 'x')).rejects.toThrow(/forbidden/)
    // RLS chặn UPDATE bằng cách khớp 0 dòng, không ném lỗi: phải đếm dòng, không dùng toThrow.
    expect(await as(user(a.viewer), `update public.tours set name = 'x' where organization_id = $1 returning id`, [a.org])).toHaveLength(0)
    expect(await as(user(a.ownerId), `update public.tours set name = name where organization_id = $1 returning id`, [a.org])).not.toHaveLength(0)
  })

  it('chỉ xem mặc định không có tài chính, được cấp riêng thì có', async () => {
    expect(await as(user(a.viewer), `select 1 from public.booking_financials where booking_id = $1`, [bookingA])).toHaveLength(0)
    await owner(`update public.memberships set granted_permissions = '{finance.read}' where user_id = $1`, [a.viewer])
    expect(await as(user(a.viewer), `select 1 from public.booking_financials where booking_id = $1`, [bookingA])).toHaveLength(1)
    await owner(`update public.memberships set granted_permissions = '{}' where user_id = $1`, [a.viewer])
  })

  it('xuất CSV cần quyền riêng và được ghi nhật ký', async () => {
    await expect(rpc(user(a.viewer), 'export_bookings', a.org, {})).rejects.toThrow(/forbidden/)
    const rows = await rpc(user(a.agent), 'export_bookings', a.org, {})
    expect(rows.length).toBeGreaterThan(0)
    const logs = await owner(`select 1 from public.audit_logs where organization_id = $1 and action = 'export'`, [a.org])
    expect(logs.length).toBeGreaterThan(0)
  })

  it('không ai ghi thẳng vào bookings hay giữ chỗ, kể cả chủ doanh nghiệp', async () => {
    await expect(as(user(a.ownerId), `update public.booking_items set committed_seats = 0 where organization_id = $1`, [a.org])).rejects.toThrow(/permission denied/)
    await expect(as(user(a.ownerId), `insert into public.bookings (organization_id, code) values ($1, 'X')`, [a.org])).rejects.toThrow(/permission denied/)
    await expect(as(user(a.ownerId), `update public.inventory_pools set capacity = 999 where organization_id = $1`, [a.org])).rejects.toThrow(/permission denied/)
  })

  it('hàm nội bộ và hàm worker không gọi được từ người dùng', async () => {
    await expect(as(user(a.ownerId), `select public._pool_available($1)`, ['00000000-0000-0000-0000-000000000000'])).rejects.toThrow(/permission denied/)
    await expect(as(user(a.ownerId), `select public.worker_expire_holds()`)).rejects.toThrow(/permission denied/)
  })

  it('nhật ký không sửa, không xóa được', async () => {
    await expect(owner(`delete from public.audit_logs where organization_id = $1`, [a.org])).rejects.toThrow(/append-only/)
    await expect(as(user(a.ownerId), `delete from public.audit_logs where organization_id = $1`, [a.org])).rejects.toThrow(/permission denied/)
  })

  it('doanh nghiệp không mất chủ và không tự khóa mình', async () => {
    const [p] = await owner<any>(`select email from public.profiles where id = $1`, [a.ownerId])
    expect(await rpc(user(a.ownerId), 'member_upsert', a.org, p.email, 'viewer')).toMatchObject({ ok: false, code: 'last_owner' })
    expect(await rpc(user(a.ownerId), 'member_upsert', a.org, p.email, 'owner', [], [], false)).toMatchObject({ ok: false, code: 'cannot_deactivate_self' })
  })
})
