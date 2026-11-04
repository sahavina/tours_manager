// Đồng bộ danh mục và lịch từ kênh. Bất biến quan trọng nhất: đồng bộ KHÔNG ghi vào dữ liệu nội bộ.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mockAvailability, mockCatalog, VIATOR_DECLARED, VIATOR_MOCK } from '@tours/channels'
import { as, bookingEvent, closePool, makeWorld, owner, rpc as baseRpc, seats, service, user, type Actor, type World } from './test/harness'

// Driver pg đổi mảng JS thành mảng Postgres; hai hàm *_ingest nhận jsonb nên phải gửi chuỗi JSON.
const rpc = (actor: Actor, fn: string, ...args: unknown[]) =>
  baseRpc(actor, fn, ...args.map((a) => (fn.endsWith('_ingest') && Array.isArray(a) ? JSON.stringify(a) : a)))

let w: World
const P = (over: object = {}) => ({ product_code: 'C1', title: 'Tên kênh', description: 'Mô tả kênh', destination: 'Hà Nội', duration_minutes: 120, language: 'en', start_times: ['08:00'], status: 'ACTIVE', ...over })
const product = async (code = 'C1') => (await owner<any>(`select * from public.channel_products where organization_id = $1 and external_product_code = $2`, [w.org, code]))[0]

beforeAll(async () => {
  w = await makeWorld('cat')
})
afterAll(closePool)

describe('nhận danh mục', () => {
  it('chỉ cần mã và tên: đúng phần Viator nêu trong tài liệu, trường còn lại để trống', async () => {
    const r = await rpc(service, 'channel_catalog_ingest', w.connection, [{ product_code: 'MIN', title: 'Tối thiểu', status: 'ACTIVE' }])
    expect(r).toMatchObject({ ok: true, created: 1, invalid: 0 })
  })

  it('dòng thiếu mã bị đếm là không hợp lệ, không làm hỏng cả lượt', async () => {
    const r = await rpc(service, 'channel_catalog_ingest', w.connection, [{ title: 'Không mã' }, P({ product_code: 'OK1' })])
    expect(r).toMatchObject({ created: 1, invalid: 1 })
  })

  it('gửi lại cùng nội dung không tạo trùng và không báo thay đổi', async () => {
    await rpc(service, 'channel_catalog_ingest', w.connection, [P()])
    const r = await rpc(service, 'channel_catalog_ingest', w.connection, [P()])
    expect(r).toMatchObject({ created: 0, changed: 0, unchanged: 1 })
    expect((await owner(`select 1 from public.channel_products where organization_id = $1 and external_product_code = 'C1'`, [w.org]))).toHaveLength(1)
  })

  it('che thông tin nhạy cảm trong dữ liệu nguồn', async () => {
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'SEC', api_key: 'x' })])
    expect((await product('SEC')).latest.api_key).toBe('[đã che]')
  })

  it('chỉ danh sách đầy đủ mới đánh dấu đã gỡ; gửi lại thì sống lại', async () => {
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'R1' }), P({ product_code: 'R2' })])
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'R1' })], false)
    expect((await product('R2')).removed_at).toBeNull()
    const r = await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'R1' })], true)
    expect(r.removed).toBeGreaterThan(0)
    expect((await product('R2')).removed_at).not.toBeNull()
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'R2' })])
    expect((await product('R2')).removed_at).toBeNull()
  })
})

describe('đồng bộ không ghi đè nội bộ', () => {
  it('sản phẩm mới không tự tạo tour; đổi nội dung chỉ gắn cờ, tour giữ nguyên', async () => {
    const before = await owner(`select count(*) n from public.tours where organization_id = $1`, [w.org])
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'K1', title: 'Bản đầu' })])
    expect(await owner(`select count(*) n from public.tours where organization_id = $1`, [w.org])).toEqual(before)

    const p = await product('K1')
    const made = await rpc(user(w.ownerId), 'channel_catalog_create_internal', p.id, null, 'K1T', 'K1O')
    expect(made.ok).toBe(true)
    await owner(`update public.tours set name = 'Tên đã chỉnh nội bộ' where id = $1`, [made.tour_id])

    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'K1', title: 'Kênh đổi tên', description: 'Mô tả mới' })])
    const after = await product('K1')
    expect(after.has_changes).toBe(true)
    expect(after.baseline.title).toBe('Bản đầu')
    const [t] = await owner<any>(`select name from public.tours where id = $1`, [made.tour_id])
    expect(t.name).toBe('Tên đã chỉnh nội bộ')
  })

  it('duyệt chỉ áp đúng trường đã chọn; mảng rỗng giữ nguyên bản nội bộ', async () => {
    const p = await product('K1')
    const [o] = await owner<any>(`select tour_id from public.tour_options where id = $1`, [p.tour_option_id])
    expect((await rpc(user(w.ownerId), 'channel_catalog_review', p.id, ['description'])).applied).toBe(1)
    const [t] = await owner<any>(`select name, description from public.tours where id = $1`, [o.tour_id])
    expect(t).toEqual({ name: 'Tên đã chỉnh nội bộ', description: 'Mô tả mới' })
    expect((await product('K1')).has_changes).toBe(false)

    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'K1', title: 'Lần nữa', description: 'Mô tả mới' })])
    await rpc(user(w.ownerId), 'channel_catalog_review', p.id, [])
    const [t2] = await owner<any>(`select name from public.tours where id = $1`, [o.tour_id])
    expect(t2.name).toBe('Tên đã chỉnh nội bộ')
    expect((await product('K1')).has_changes).toBe(false)
  })

  it('kênh bỏ trống một trường thì duyệt cũng không xóa dữ liệu nội bộ', async () => {
    await rpc(service, 'channel_catalog_ingest', w.connection, [{ product_code: 'K1', title: 'Chỉ có tên' }])
    const p = await product('K1')
    await rpc(user(w.ownerId), 'channel_catalog_review', p.id, ['description', 'destination'])
    const [t] = await owner<any>(`select t.description from public.tours t join public.tour_options o on o.tour_id = t.id where o.id = $1`, [p.tour_option_id])
    expect(t.description).toBe('Mô tả mới')
  })

  it('tạo tour trùng mã bị từ chối, không để lại dữ liệu dở', async () => {
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'K2' })])
    const p = await product('K2')
    expect(await rpc(user(w.ownerId), 'channel_catalog_create_internal', p.id, null, 'K1T', 'K2O')).toMatchObject({ ok: false, code: 'duplicate_code' })
    expect(await rpc(user(w.ownerId), 'channel_catalog_create_internal', p.id, null, 'K2T', 'K1O')).toMatchObject({ ok: false, code: 'duplicate_code' })
    expect(await owner(`select 1 from public.tours where organization_id = $1 and code = 'K2T'`, [w.org])).toHaveLength(0)
    expect((await product('K2')).tour_option_id).toBeNull()
  })
})

describe('ghép mã', () => {
  it('ghép xong thì ánh xạ được xác nhận và booking đang chờ tự xếp chuyến', async () => {
    const dep = await w.departure('2032-01-10')
    const b = await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('CAT-B1', '2032-01-10', { product: 'L1' }))
    expect(b.queued).toBe(true)
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'L1' })])
    const p = await product('L1')
    const r = await rpc(user(w.ownerId), 'channel_catalog_link', p.id, w.option)
    expect(r.placed).toBe(1)
    expect((await seats(dep)).committed).toBe(2)
    const [m] = await owner<any>(`select is_verified, tour_option_id from public.channel_product_mappings where connection_id = $1 and external_product_code = 'L1'`, [w.connection])
    expect(m).toEqual({ is_verified: true, tour_option_id: w.option })
  })

  it('bỏ qua được và ghép lại thì hết bỏ qua', async () => {
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'L2' })])
    const p = await product('L2')
    await rpc(user(w.ownerId), 'channel_catalog_ignore', p.id, true)
    expect((await product('L2')).is_ignored).toBe(true)
    await rpc(user(w.ownerId), 'channel_catalog_link', p.id, w.option)
    expect((await product('L2')).is_ignored).toBe(false)
  })
})

describe('lịch và số chỗ', () => {
  it('ảnh chụp lịch không đổi sức chứa nội bộ, và cho đối chiếu chênh lệch', async () => {
    const dep = await w.departure('2032-02-01', 10)
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'A1' })])
    const p = await product('A1')
    await rpc(user(w.ownerId), 'channel_catalog_link', p.id, w.option)
    const before = await seats(dep)
    const r = await rpc(service, 'channel_availability_ingest', w.connection, [
      { product_code: 'A1', local_date: '2032-02-01', local_time: '08:00', vacancies: 3 },
      { product_code: 'A1', local_date: '2032-02-02', local_time: '08:00', vacancies: 5 },
      { product_code: 'KHONG-CO', local_date: '2032-02-01', vacancies: 1 },
    ])
    expect(r).toMatchObject({ saved: 2, skipped: 1 })
    expect(await seats(dep)).toEqual(before)

    const cmp = await rpc(user(w.ownerId), 'channel_availability_compare', p.id, '2032-02-01', '2032-02-02')
    expect(cmp[0]).toMatchObject({ vacancies: 3, internal_available: 10, departure_id: dep })
    expect(cmp[1]).toMatchObject({ vacancies: 5, internal_available: null, departure_id: null })
  })

  it('gửi lại lịch cập nhật chứ không nhân đôi', async () => {
    await rpc(service, 'channel_availability_ingest', w.connection, [{ product_code: 'A1', local_date: '2032-02-01', local_time: '08:00', vacancies: 1 }])
    const p = await product('A1')
    const rows = await owner<any>(`select vacancies from public.channel_availability_snapshots where channel_product_id = $1 and local_date = '2032-02-01'`, [p.id])
    expect(rows).toEqual([{ vacancies: 1 }])
  })

  it('tạo chuyến thiếu theo lịch, sức chứa do người nhập, không đụng chuyến đã có', async () => {
    const p = await product('A1')
    const r = await rpc(user(w.ownerId), 'channel_availability_create_departures', p.id, '2032-02-01', '2032-02-02', 16)
    // 02-01 đã có chuyến chung của tour nhưng slot riêng của gói thì chưa, nên tạo 2; chạy lại phải bỏ qua cả 2.
    expect(r.created).toBeGreaterThan(0)
    const again = await rpc(user(w.ownerId), 'channel_availability_create_departures', p.id, '2032-02-01', '2032-02-02', 16)
    expect(again).toMatchObject({ created: 0, skipped: r.created })
    const [d] = await owner<any>(`select p.capacity from public.departures d join public.inventory_pools p on p.id = d.inventory_pool_id
      where d.tour_option_id = $1 and d.local_date = '2032-02-02'`, [w.option])
    expect(d.capacity).toBe(16)
    expect(await rpc(user(w.ownerId), 'channel_availability_create_departures', p.id, '2032-02-01', '2032-02-02', null)).toMatchObject({ ok: false, code: 'invalid_capacity' })
  })
})

describe('mô phỏng không giả làm thật', () => {
  it('lượt mô phỏng được ghi nhãn simulated và không tạo mốc liên lạc thật', async () => {
    await rpc(service, 'channel_catalog_ingest', w.connection, [P({ product_code: 'M1' })])
    const [j] = await owner<any>(`select detail from public.sync_jobs where connection_id = $1 and kind = 'catalog_sync' order by created_at desc limit 1`, [w.connection])
    expect(j.detail.outcome).toBe('simulated')
    const [c] = await owner<any>(`select last_success_at, catalog_last_synced_at from public.channel_connections where id = $1`, [w.connection])
    expect(c.last_success_at).toBeNull()
    expect(c.catalog_last_synced_at).not.toBeNull()
  })

  it('kết nối thật chưa có connector: worker ghi lỗi, không ghi đã đồng bộ', async () => {
    const [c] = await owner<any>(`insert into public.channel_connections (organization_id, channel, account_name, mode, status, catalog_sync_enabled)
      values ($1, 'viator', 'Thật chưa có connector', 'sandbox', 'not_configured', true) returning id`, [w.org])
    const due = await owner<any>(`select * from public.worker_catalog_due() where id = $1`, [c.id])
    expect(due).toHaveLength(1)
    await owner(`select public.worker_catalog_failed($1, 'needs_connector', 'Chưa có connector thật')`, [c.id])
    const [row] = await owner<any>(`select catalog_last_synced_at, catalog_last_error from public.channel_connections where id = $1`, [c.id])
    expect(row.catalog_last_synced_at).toBeNull()
    expect(row.catalog_last_error).toMatch(/connector/)
    expect(await owner(`select 1 from public.worker_catalog_due() where id = $1`, [c.id])).toHaveLength(0)
  })

  it('người dùng không thể đẩy danh mục giả vào kết nối thật', async () => {
    const [c] = await owner<any>(`select id from public.channel_connections where organization_id = $1 and mode = 'sandbox' limit 1`, [w.org])
    await expect(rpc(user(w.ownerId), 'channel_catalog_ingest', c.id, [P()])).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.ownerId), 'channel_mock_bump_catalog', c.id)).rejects.toThrow(/forbidden/)
  })

  it('khả năng khai cho Viator thật phản ánh đúng tài liệu', () => {
    expect(VIATOR_MOCK.capabilities.availability_pull).toBe('supported')
    expect(VIATOR_DECLARED.availability_pull).toBe('unsupported')
    expect(VIATOR_DECLARED.catalog_pull).toBe('unverified')
  })

  it('danh mục mô phỏng có mã SIM, đổi phiên bản thì đổi nội dung, và đi qua RPC thật', async () => {
    const v1 = mockCatalog('viator', 1)
    const v2 = mockCatalog('viator', 2)
    expect(v1.every((p) => p.product_code.includes('SIM'))).toBe(true)
    expect(v2).not.toEqual(v1)
    const r1 = await rpc(service, 'channel_catalog_ingest', w.connection, v1, false)
    expect(r1.created).toBe(v1.length)
    const r2 = await rpc(service, 'channel_catalog_ingest', w.connection, v2, false)
    expect(r2.changed).toBeGreaterThan(0)
    const items = mockAvailability(v2, new Date('2032-03-01T00:00:00Z'), 3)
    expect((await rpc(service, 'channel_availability_ingest', w.connection, items)).skipped).toBe(0)
  })
})

describe('phân quyền', () => {
  it('người thiếu quyền không đọc được và không thao tác được', async () => {
    const p = await product('C1')
    expect(await as(user(w.agent), `select 1 from public.channel_products where id = $1`, [p.id])).toHaveLength(0)
    expect(await as(user(w.accountant), `select 1 from public.channel_products where id = $1`, [p.id])).toHaveLength(1)
    await expect(rpc(user(w.agent), 'channel_catalog_link', p.id, w.option)).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.operator), 'channel_catalog_create_internal', p.id, null, 'X', 'Y')).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.agent), 'channel_availability_compare', p.id, '2032-01-01', '2032-01-02')).rejects.toThrow(/forbidden/)
  })

  it('doanh nghiệp khác không đọc, không ghép được; không ghép sang gói của doanh nghiệp khác', async () => {
    const other = await makeWorld('cat2')
    const p = await product('C1')
    expect(await as(user(other.ownerId), `select 1 from public.channel_products where id = $1`, [p.id])).toHaveLength(0)
    await expect(rpc(user(other.ownerId), 'channel_catalog_link', p.id, other.option)).rejects.toThrow(/forbidden/)
    expect(await rpc(user(w.ownerId), 'channel_catalog_link', p.id, other.option)).toMatchObject({ ok: false, code: 'option_not_found' })
  })

  it('hàm worker không gọi được từ người dùng', async () => {
    await expect(as(user(w.ownerId), `select * from public.worker_catalog_due()`)).rejects.toThrow(/permission denied/)
  })
})
