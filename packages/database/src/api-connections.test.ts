// Màn Kết nối API: tạo kết nối API, lưu địa chỉ cổng, không đọc được tên bí mật.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { as, closePool, makeWorld, owner, rpc, user, type World } from './test/harness'

let w: World
beforeAll(async () => {
  w = await makeWorld('apiconn')
})
afterAll(closePool)

describe('kết nối API', () => {
  it('tạo kết nối Sandbox, chưa cấu hình, chưa đăng ký; GetYourGuide giữ chỗ 60 phút', async () => {
    const r = await rpc(user(w.ownerId), 'api_connection_create', w.org, 'getyourguide', 'GetYourGuide API')
    expect(r.ok).toBe(true)
    const [c] = await owner<any>(`select mode::text, status::text, approval_status, hold_ttl_seconds from public.channel_connections where id = $1`, [r.connection_id])
    expect(c).toEqual({ mode: 'sandbox', status: 'not_configured', approval_status: 'not_requested', hold_ttl_seconds: 3600 })
    expect((await rpc(user(w.ownerId), 'api_connection_create', w.org, 'getyourguide', 'GetYourGuide API')).code).toBe('duplicate_connection')
    expect((await rpc(user(w.ownerId), 'api_connection_create', w.org, 'manual', 'X')).code).toBe('invalid_input')
  })

  it('chỉ người có connection.manage tạo được', async () => {
    await expect(rpc(user(w.viewer), 'api_connection_create', w.org, 'viator', 'Viator API')).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.outsider), 'api_connection_create', w.org, 'viator', 'Viator API')).rejects.toThrow(/forbidden/)
  })

  it('lưu, xóa địa chỉ cổng; từ chối http và khoảng trắng; xóa mã nhà cung cấp bằng chuỗi rỗng', async () => {
    const { connection_id: id } = await rpc(user(w.ownerId), 'api_connection_create', w.org, 'viator', 'Viator API')
    expect((await rpc(user(w.ownerId), 'connection_update', id, { endpoint_url: 'https://gw.example.com', supplier_account_ref: '5613730' })).ok).toBe(true)
    expect((await rpc(user(w.ownerId), 'connection_update', id, { endpoint_url: 'http://gw.example.com' })).code).toBe('invalid_endpoint_url')
    expect((await rpc(user(w.ownerId), 'connection_update', id, { endpoint_url: 'https://a b' })).code).toBe('invalid_endpoint_url')
    const [a] = await as<any>(user(w.viewer), `select endpoint_url, supplier_account_ref from public.channel_connections where id = $1`, [id])
    expect(a).toEqual({ endpoint_url: 'https://gw.example.com', supplier_account_ref: '5613730' })
    // Lưu trường khác không làm mất địa chỉ cổng.
    await rpc(user(w.ownerId), 'connection_update', id, { approval_status: 'pending' })
    expect((await owner<any>(`select endpoint_url from public.channel_connections where id = $1`, [id]))[0].endpoint_url).toBe('https://gw.example.com')
    await rpc(user(w.ownerId), 'connection_update', id, { endpoint_url: '', supplier_account_ref: '' })
    expect((await owner<any>(`select endpoint_url, supplier_account_ref from public.channel_connections where id = $1`, [id]))[0]).toEqual({ endpoint_url: null, supplier_account_ref: null })
  })

  it('tài khoản nhập file GetYourGuide (Production) không phải kết nối API: cổng từ chối, worker không báo chỗ', async () => {
    const [imp] = await owner<{ id: string }>(
      `insert into public.channel_connections (organization_id, channel, account_name, mode, status, approval_status)
       values ($1, 'getyourguide', 'Nhập từ báo cáo', 'production', 'not_configured', 'not_required') returning id`,
      [w.org],
    )
    await owner(
      `insert into public.channel_product_mappings (organization_id, connection_id, external_product_code, external_option_code, tour_option_id, is_verified)
       values ($1, $2, 'IMPORT-CODE', '', $3, true)`,
      [w.org, imp!.id, w.option],
    )
    const dep = await w.departure('2030-08-01', 6)
    const [{ r }] = await owner<{ r: any[] }>(`select public.worker_gyg_availability($1) as r`, [dep])
    expect(r.map((t) => t.connection_id)).not.toContain(imp!.id)
    await expect(rpc({ role: 'service_role' }, 'gateway_gyg_products', imp!.id, 'x')).rejects.toThrow(/forbidden/)
  })

  it('người dùng vẫn không đọc được tên bí mật', async () => {
    await expect(as(user(w.ownerId), `select credential_ref from public.channel_connections where organization_id = $1`, [w.org])).rejects.toThrow(/permission denied/)
  })
})
