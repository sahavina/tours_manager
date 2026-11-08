// Tọa độ điểm đón: lưu, quyền, và không bị đồng bộ từ kênh xóa mất.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bookingEvent, closePool, makeWorld, owner, rpc, service, user, type World } from './test/harness'

let w: World
let other: World
beforeAll(async () => {
  w = await makeWorld('geo')
  other = await makeWorld('geo2')
})
afterAll(closePool)

const makeItem = async (world: World, ref: string, date: string, pickup?: object) => {
  await world.departure(date, 10).catch(() => undefined)
  const r = await rpc(service, 'ingest_channel_event', world.connection, bookingEvent(ref, date, pickup ? { data: { items: [{ product_code: 'P1', option_code: '', local_date: date, local_time: '08:00:00', pax: { adult: 2 }, pickup }] } } : {}))
  const [i] = await owner<{ id: string }>(`select id from public.booking_items where booking_id = $1`, [r.booking_id])
  return i!.id
}
const coords = async (item: string) =>
  (await owner<{ latitude: string; longitude: string; hotel_name: string }>(`select latitude, longitude, hotel_name from public.booking_pickups where booking_item_id = $1`, [item]))[0]

describe('tọa độ điểm đón', () => {
  it('lưu tọa độ cho nhiều dòng một lúc', async () => {
    const a = await makeItem(w, 'GEO-1', '2030-12-01', { hotel: 'Hotel Một' })
    const b = await makeItem(w, 'GEO-2', '2030-12-01')
    expect(await rpc(user(w.operator), 'set_pickup_coordinates', [a, b], 21.0245301, 105.8484024)).toMatchObject({ ok: true, updated: 2 })
    expect(await coords(a)).toMatchObject({ latitude: '21.024530', longitude: '105.848402', hotel_name: 'Hotel Một' })
    expect(await coords(b)).toMatchObject({ latitude: '21.024530' })
  })

  it('từ chối tọa độ sai và dòng không tồn tại', async () => {
    const a = await makeItem(w, 'GEO-3', '2030-12-02')
    expect(await rpc(user(w.operator), 'set_pickup_coordinates', [a], 95, 105)).toMatchObject({ ok: false, code: 'invalid_coordinates' })
    expect(await rpc(user(w.operator), 'set_pickup_coordinates', ['00000000-0000-0000-0000-000000000000'], 21, 105)).toMatchObject({ ok: false, code: 'item_not_found' })
  })

  it('cần quyền điều hành và không chạm doanh nghiệp khác', async () => {
    const a = await makeItem(w, 'GEO-4', '2030-12-03')
    const b = await makeItem(other, 'GEO-5', '2030-12-03')
    await expect(rpc(user(w.viewer), 'set_pickup_coordinates', [a], 21, 105)).rejects.toThrow(/forbidden/)
    await expect(rpc(user(other.ownerId), 'set_pickup_coordinates', [a], 21, 105)).rejects.toThrow(/forbidden/)
    await expect(rpc(user(w.ownerId), 'set_pickup_coordinates', [a, b], 21, 105)).rejects.toThrow(/forbidden/)
    expect((await coords(a))?.latitude ?? null).toBeNull()
  })

  it('kênh gửi lại booking không xóa tọa độ đã đặt', async () => {
    const a = await makeItem(w, 'GEO-6', '2030-12-04', { hotel: 'Hotel Hai' })
    await rpc(user(w.operator), 'set_pickup_coordinates', [a], 21.03, 105.85)
    await rpc(service, 'ingest_channel_event', w.connection, bookingEvent('GEO-6', '2030-12-04', {
      version: 2, type: 'booking.updated',
      data: { items: [{ product_code: 'P1', option_code: '', local_date: '2030-12-04', local_time: '08:00:00', pax: { adult: 2 }, pickup: { hotel: 'Hotel Hai' } }] },
    }))
    expect(await coords(a)).toMatchObject({ latitude: '21.030000', longitude: '105.850000' })
  })

  it('trả tọa độ đã biết của khách sạn trong đúng doanh nghiệp', async () => {
    const places = await rpc(user(w.operator), 'known_pickup_places', w.org)
    expect(places.find((x: any) => x.hotel_name === 'Hotel Một')).toMatchObject({ latitude: 21.02453 })
    expect(await rpc(user(other.ownerId), 'known_pickup_places', other.org)).toEqual([])
    await expect(rpc(user(other.ownerId), 'known_pickup_places', w.org)).rejects.toThrow(/forbidden/)
  })
})
