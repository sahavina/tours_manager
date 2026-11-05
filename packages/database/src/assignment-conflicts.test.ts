// Cảnh báo HDV và xe bị xếp vào hai chuyến chồng giờ.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePool, makeWorld, owner, rpc, user, type World } from './test/harness'

let w: World
beforeAll(async () => {
  w = await makeWorld('clash')
})
afterAll(closePool)

const trip = async (world: World, date: string, time: string, option: string | null = null) => {
  const r = await rpc(user(world.ownerId), 'create_departure', world.org, world.tour, option, date, time, 'Asia/Ho_Chi_Minh', 10, null)
  if (!r.ok) throw new Error(r.code)
  return r.departure_id as string
}
const assignGuide = (world: World, dep: string, guide = world.guideId) => rpc(user(world.operator), 'assign_guide', dep, guide, 'lead')
const levels = async (world: World, dep: string) =>
  (await rpc(user(world.operator), 'assignment_conflicts', dep)).map((c: any) => `${c.kind}:${c.level}`)
const setTourDuration = (world: World, minutes: number | null) =>
  owner(`update public.tours set duration_minutes = $1 where id = $2`, [minutes, world.tour])

describe('trùng lịch HDV và xe', () => {
  it('cùng giờ khởi hành là trùng, kể cả khi chưa có thời lượng', async () => {
    const a = await trip(w, '2030-09-01', '08:00', w.option)
    const b = await trip(w, '2030-09-01', '08:00', w.transferOption)
    await assignGuide(w, a)
    expect(await levels(w, b)).toEqual(['guide:overlap'])
    // Chuyến đang được gán không tự trùng với chính nó.
    expect(await levels(w, a)).toEqual([])
  })

  it('có thời lượng thì phân biệt được chồng giờ và không chồng giờ', async () => {
    const world = await makeWorld('clash2')
    await setTourDuration(world, 120)
    const a = await trip(world, '2030-09-02', '08:00', world.option)
    const near = await trip(world, '2030-09-02', '09:00', world.option)
    const after = await trip(world, '2030-09-02', '10:00', world.option)
    await assignGuide(world, a)
    expect(await levels(world, near)).toEqual(['guide:overlap'])
    // 08:00 + 2 tiếng kết thúc đúng 10:00: nối chuyến được, không tính thời gian di chuyển.
    expect(await levels(world, after)).toEqual([])
  })

  it('thiếu thời lượng và cùng ngày thì báo có thể trùng, khác ngày thì không', async () => {
    const world = await makeWorld('clash3')
    const a = await trip(world, '2030-09-03', '08:00', world.option)
    const sameDay = await trip(world, '2030-09-03', '15:00', world.option)
    const otherDay = await trip(world, '2030-09-04', '08:00', world.option)
    await assignGuide(world, a)
    expect(await levels(world, sameDay)).toEqual(['guide:possible'])
    expect(await levels(world, otherDay)).toEqual([])
  })

  it('thời lượng của gói được ưu tiên hơn thời lượng của tour', async () => {
    const world = await makeWorld('clash4')
    await setTourDuration(world, 600)
    await owner(`update public.tour_options set duration_minutes = 60 where id = $1`, [world.option])
    const a = await trip(world, '2030-09-05', '08:00', world.option)
    const b = await trip(world, '2030-09-05', '09:30', world.option)
    await assignGuide(world, a)
    expect(await levels(world, b)).toEqual([])
    // Gói kia không có thời lượng riêng nên dùng 600 phút của tour, và chồng lên chuyến đang có.
    const c = await trip(world, '2030-09-05', '07:00', world.transferOption)
    expect(await levels(world, c)).toEqual(['guide:overlap'])
  })

  it('xe cũng được kiểm tra, chuyến đã hủy thì không tính', async () => {
    const world = await makeWorld('clash5')
    const a = await trip(world, '2030-09-06', '08:00', world.option)
    const b = await trip(world, '2030-09-06', '08:00', world.transferOption)
    await rpc(user(world.operator), 'assign_vehicle', a, world.vehicleId)
    expect(await levels(world, b)).toEqual(['vehicle:overlap'])
    await owner(`update public.departures set status = 'cancelled' where id = $1`, [a])
    expect(await levels(world, b)).toEqual([])
  })

  it('bảng điều hành chỉ báo khi chính HDV hoặc xe của chuyến bị trùng', async () => {
    const world = await makeWorld('clash6')
    const a = await trip(world, '2030-09-07', '08:00', world.option)
    const b = await trip(world, '2030-09-07', '08:00', world.transferOption)
    await assignGuide(world, a)
    const row = async (id: string) => (await rpc(user(world.operator), 'ops_board', world.org, '2030-09-07', '2030-09-07')).find((d: any) => d.id === id)
    expect(await row(b)).toMatchObject({ guide_clash: 0, vehicle_clash: 0, possible_clash: 0 })
    await assignGuide(world, b)
    expect(await row(a)).toMatchObject({ guide_clash: 1, vehicle_clash: 0 })
    expect(await row(b)).toMatchObject({ guide_clash: 1, vehicle_clash: 0 })
    // Đổi sang HDV khác thì hết trùng.
    const [ga] = await owner<{ id: string }>(`select id from public.guide_assignments where departure_id = $1`, [b])
    await rpc(user(world.operator), 'unassign_guide', ga!.id)
    await assignGuide(world, b, world.otherGuideId)
    expect(await row(b)).toMatchObject({ guide_clash: 0 })
  })

  it('người ngoài doanh nghiệp không xem được', async () => {
    const a = await trip(w, '2030-09-08', '08:00', w.option)
    await expect(rpc(user(w.outsider), 'assignment_conflicts', a)).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.guideUser), 'assignment_conflicts', a)).rejects.toThrow(/forbidden/)
  })
})
