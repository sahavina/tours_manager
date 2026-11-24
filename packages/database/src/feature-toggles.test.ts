// Bật tắt tính năng theo doanh nghiệp: tắt một tính năng thì quyền thuộc tính năng đó mất với mọi thành viên.
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anon, as, closePool, makeWorld, owner, rpc, user, type World } from './test/harness'

let w: World
let slug: string
const has = async (who: string, perm: string) =>
  (await as<{ ok: boolean }>(user(who), `select public.has_org_permission($1, $2) as ok`, [w.org, perm]))[0]!.ok
const myPerms = async (who: string) => {
  const ctx = await rpc<any[]>(user(who), 'my_org_context')
  return ctx.find((o) => o.organization_id === w.org)
}
// Hàm tài chính cần finance.manage: được phép thì trả connection_not_found, không được thì ném forbidden.
const financeCall = (who: string) => rpc(user(who), 'settlement_preview', w.org, randomUUID(), 'x.csv', 'h', {}, [])

beforeAll(async () => {
  w = await makeWorld('feat')
  ;[{ slug }] = await owner<{ slug: string }>(`select slug from public.organizations where id = $1`, [w.org])
  await owner(`update public.tours set is_published = true where id = $1`, [w.tour])
})
afterAll(closePool)

describe('bật tắt tính năng', () => {
  it('mặc định mọi tính năng bật', async () => {
    const ctx = await myPerms(w.ownerId)
    expect(ctx.disabled_features).toEqual([])
    expect(ctx.permissions).toContain('finance.manage')
    expect((await financeCall(w.ownerId)).code).toBe('connection_not_found')
  })

  it('tắt tài chính: mất finance.* ở database và trong context, RPC tài chính bị chặn, quyền lõi còn nguyên', async () => {
    expect(await rpc(user(w.ownerId), 'org_set_features', w.org, ['finance'])).toMatchObject({ ok: true, disabled_features: ['finance'] })
    expect(await has(w.ownerId, 'finance.read')).toBe(false)
    expect(await has(w.accountant, 'finance.manage')).toBe(false)
    const ctx = await myPerms(w.ownerId)
    expect(ctx.disabled_features).toEqual(['finance'])
    expect(ctx.permissions.filter((p: string) => p.startsWith('finance.'))).toEqual([])
    await expect(financeCall(w.ownerId)).rejects.toThrow(/forbidden/)
    // Quyền lõi và tính năng khác không đổi.
    expect(await has(w.ownerId, 'booking.manage')).toBe(true)
    expect(await has(w.ownerId, 'org.manage')).toBe(true)
    expect(await has(w.operator, 'ops.manage')).toBe(true)
    // Ghi nhật ký.
    const logs = await owner(`select 1 from public.audit_logs where organization_id = $1 and action = 'features_update'`, [w.org])
    expect(logs.length).toBeGreaterThan(0)
  })

  it('bật lại: quyền cũ của từng người trở lại', async () => {
    await rpc(user(w.ownerId), 'org_set_features', w.org, [])
    expect(await has(w.accountant, 'finance.manage')).toBe(true)
    expect(await has(w.viewer, 'finance.read')).toBe(false)
    expect((await financeCall(w.ownerId)).code).toBe('connection_not_found')
  })

  it('tắt điều hành thì hướng dẫn viên mất giao diện của họ', async () => {
    expect(await has(w.guideUser, 'guide.portal')).toBe(true)
    await rpc(user(w.ownerId), 'org_set_features', w.org, ['operations'])
    expect(await has(w.guideUser, 'guide.portal')).toBe(false)
    expect(await has(w.operator, 'resource.read')).toBe(false)
    expect(await has(w.operator, 'departure.manage')).toBe(true)
    await rpc(user(w.ownerId), 'org_set_features', w.org, [])
  })

  it('tắt trang đặt tour: trang khách báo not_found, không nhận yêu cầu mới', async () => {
    expect((await rpc(anon, 'public_storefront', slug)).ok).toBe(true)
    await rpc(user(w.ownerId), 'org_set_features', w.org, ['storefront'])
    expect((await rpc(anon, 'public_storefront', slug)).code).toBe('not_found')
    expect((await rpc(anon, 'public_tour', slug, 'T1')).code).toBe('not_found')
    const req = await rpc(anon, 'public_booking_request', slug, 'O1', '2027-05-01', '08:00', '{"adult":1}',
      JSON.stringify({ name: 'Jane Doe', email: 'jane@example.com' }), null, null)
    expect(req.ok).toBe(false)
    await rpc(user(w.ownerId), 'org_set_features', w.org, [])
    expect((await rpc(anon, 'public_storefront', slug)).ok).toBe(true)
  })

  it('từ chối tính năng lạ và trùng lặp được gộp', async () => {
    expect((await rpc(user(w.ownerId), 'org_set_features', w.org, ['bookings'])).code).toBe('invalid_input')
    expect(await rpc(user(w.ownerId), 'org_set_features', w.org, ['reports', 'reports', 'imports']))
      .toMatchObject({ ok: true, disabled_features: ['imports', 'reports'] })
    await rpc(user(w.ownerId), 'org_set_features', w.org, [])
  })

  it('chỉ người có quyền cấu hình doanh nghiệp mới bật tắt được; người ngoài không đọc được', async () => {
    await expect(rpc(user(w.viewer), 'org_set_features', w.org, ['finance'])).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.agent), 'org_set_features', w.org, ['finance'])).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.outsider), 'org_set_features', w.org, [])).rejects.toThrow(/forbidden/)
    await expect(rpc(anon, 'org_set_features', w.org, [])).rejects.toThrow(/permission denied/)
    const [{ d }] = await owner<{ d: string[] }>(`select disabled_features as d from public.organizations where id = $1`, [w.org])
    expect(d).toEqual([])
  })

  it('không sửa thẳng cột được qua PostgREST, chỉ qua RPC', async () => {
    await expect(as(user(w.ownerId), `update public.organizations set disabled_features = '{finance}' where id = $1`, [w.org]))
      .rejects.toThrow(/permission denied/)
  })
})
