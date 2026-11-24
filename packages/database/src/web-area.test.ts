// Khu Website: vai trò web_editor chỉ sửa phần hiển thị trên trang đặt tour, không chạm cột vận hành.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { as, closePool, makeUser, makeWorld, owner, rpc, user, type World } from './test/harness'

let w: World
let editor: string

beforeAll(async () => {
  w = await makeWorld('web')
  editor = await makeUser(`web-editor.${w.org}@test.local`)
  await owner(`insert into public.memberships (organization_id, user_id, role_key) values ($1, $2, 'web_editor')`, [w.org, editor])
})
afterAll(closePool)

const perms = async (u: string) => {
  const ctx = await rpc(user(u), 'my_org_context')
  return ctx.find((o: { organization_id: string }) => o.organization_id === w.org).permissions as string[]
}

describe('quyền khu Website', () => {
  it('web_editor có web.manage và catalog.read, không có booking hay sửa danh mục; chủ có web.manage', async () => {
    const p = await perms(editor)
    expect(p).toEqual(expect.arrayContaining(['web.manage', 'catalog.read']))
    expect(p).not.toContain('booking.read')
    expect(p).not.toContain('catalog.manage')
    expect(await perms(w.ownerId)).toContain('web.manage')
    expect(await perms(w.operator)).not.toContain('web.manage')
  })

  it('web_editor sửa được nội dung, công khai, giá web; không sửa được cột vận hành', async () => {
    await as(user(editor), `update public.tours set description = 'Mới', is_published = true, content_vi = '{"name":"Tên"}' where id = $1`, [w.tour])
    const [t] = await owner<{ description: string; is_published: boolean }>(`select description, is_published from public.tours where id = $1`, [w.tour])
    expect(t).toMatchObject({ description: 'Mới', is_published: true })
    await as(user(editor), `update public.tour_options set price_adult = 55, public_name = 'Shared' where id = $1`, [w.option])
    await expect(as(user(editor), `update public.tours set code = 'X1' where id = $1`, [w.tour])).rejects.toThrow(/web_only_columns/)
    await expect(as(user(editor), `update public.tour_options set default_capacity = 99 where id = $1`, [w.option])).rejects.toThrow(/web_only_columns/)
  })

  it('chủ doanh nghiệp vẫn sửa được cột vận hành; người điều hành không sửa được nội dung web', async () => {
    await as(user(w.ownerId), `update public.tour_options set cutoff_minutes = 30 where id = $1`, [w.option])
    const rows = await as(user(w.operator), `update public.tours set description = 'Op' where id = $1 returning id`, [w.tour])
    expect(rows).toEqual([])
  })

  it('web_editor sửa nội dung trang và email, không sửa tên doanh nghiệp; gửi thử được', async () => {
    await as(user(editor), `update public.organizations set storefront_settings = '{"cancel_free_hours": 12}', email_settings = '{"enabled": false}' where id = $1`, [w.org])
    await expect(as(user(editor), `update public.organizations set name = 'Đổi tên' where id = $1`, [w.org])).rejects.toThrow(/permission denied|web_only_columns/)
    expect((await rpc(user(editor), 'email_send_test', w.org, 'me@example.com')).ok).toBe(true)
    await expect(rpc(user(w.operator), 'email_send_test', w.org, 'me@example.com')).rejects.toThrow(/forbidden/)
  })

  it('tắt tính năng trang đặt tour thì mất web.manage', async () => {
    await rpc(user(w.ownerId), 'org_set_features', w.org, ['storefront'])
    expect(await perms(editor)).not.toContain('web.manage')
    await rpc(user(w.ownerId), 'org_set_features', w.org, [])
  })
})
