import { AimOutlined, EnvironmentOutlined, FlagOutlined, NodeIndexOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Empty, Space, Tag, Tooltip } from 'antd'
import { buildPickupRoute, geocodeQueries, optimizeOrder, placeNameMatches, routeKm, shortPlaceName, streetQuery, type PickupLane, type PickupStop } from '@tours/core'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, Loading } from '../../components/common'
import { rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'
import { LANE_COLORS, PickupMap } from './PickupMap'

const km = (n: number) => `${n.toFixed(1).replace('.', ',')} km`

function Stop({ stop, index, color, picking, onPick }: { stop: PickupStop; index: number; color: string; picking: boolean; onPick?: () => void }) {
  const warnings = [
    stop.outOfOrder && 'Giờ đón sớm hơn điểm trước',
    stop.afterDeparture && 'Giờ đón không sớm hơn giờ khởi hành',
    stop.mixedTimes && 'Các booking ghi giờ đón khác nhau',
  ].filter(Boolean) as string[]
  return (
    <li className="pickup-stop">
      <span className="pickup-node" style={{ background: color }}>{index + 1}</span>
      <div className="pickup-body">
        <div className="pickup-head">
          {stop.time ? <b>{stop.time}</b> : <Tag color="gold">Chưa có giờ</Tag>}
          <Tooltip title={stop.full}>
            <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(stop.full)}`} target="_blank" rel="noreferrer noopener">
              <EnvironmentOutlined /> {stop.name}
            </a>
          </Tooltip>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          {stop.pax} khách · {stop.bookings.join(', ')}{stop.area ? ` · ${stop.area}` : ''}
        </div>
        {!stop.position && (
          <div style={{ marginTop: 4 }}>
            <Tag>Chưa có vị trí</Tag>
            {onPick && <Button size="small" type={picking ? 'primary' : 'default'} icon={<AimOutlined />} onClick={onPick}>{picking ? 'Bấm lên bản đồ...' : 'Đặt trên bản đồ'}</Button>}
          </div>
        )}
        {warnings.map((w) => <Tag key={w} color="red" style={{ marginTop: 4 }}>{w}</Tag>)}
      </div>
    </li>
  )
}

/** Thứ tự đề xuất cho một xe: điểm chưa có vị trí giữ ở cuối, vì không biết nó nằm đâu. */
function proposeOrder(lane: PickupLane) {
  const located = lane.stops.filter((s) => s.position)
  if (located.length < 2) return null
  const points = located.map((s) => s.position!)
  const order = optimizeOrder(points)
  const next = order.map((i) => located[i]!)
  const before = routeKm(points)
  const after = routeKm(order.map((i) => points[i]!))
  return { stops: [...next, ...lane.stops.filter((s) => !s.position)], before, after, changed: next.some((s, i) => s.key !== located[i]!.key) && before - after > 0.05 }
}

const nominatim = async (q: string, signal: AbortSignal) => {
  // Viewbox ưu tiên khu vực Hà Nội nhưng không giới hạn. Nominatim chỉ cho một yêu cầu mỗi giây.
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=vn&viewbox=105.6,21.25,106.05,20.85&q=${encodeURIComponent(q)}`, { signal })
  if (!res.ok) throw new Error(`Dịch vụ tìm vị trí trả lỗi ${res.status}`)
  const [hit] = await res.json() as Array<{ lat: string; lon: string; name?: string }>
  await new Promise((r) => setTimeout(r, 1100))
  return hit
}

/** Chỉ gửi tên và địa chỉ khách sạn, không gửi thông tin khách. Trả về null khi không chắc, để người dùng đặt tay. */
async function geocode(stop: PickupStop, signal: AbortSignal) {
  for (const q of geocodeQueries(stop.full)) {
    const hit = await nominatim(q, signal)
    if (hit && placeNameMatches(stop.name, hit.name)) return { lat: Number(hit.lat), lng: Number(hit.lon), approximate: false }
  }
  // Photon chịu được lỗi chính tả nhưng luôn trả về một kết quả gần nhất, nên bắt buộc tên phải khớp.
  const res = await fetch(`https://photon.komoot.io/api/?limit=1&lat=21.03&lon=105.85&q=${encodeURIComponent(stop.name)}`, { signal })
  if (res.ok) {
    const f = (await res.json() as { features?: Array<{ geometry: { coordinates: [number, number] }; properties: { name?: string; countrycode?: string } }> }).features?.[0]
    if (f && f.properties.countrycode === 'VN' && placeNameMatches(stop.name, f.properties.name)) {
      return { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], approximate: false }
    }
  }
  const street = streetQuery(stop.full)
  const hit = street ? await nominatim(street, signal) : null
  return hit ? { lat: Number(hit.lat), lng: Number(hit.lon), approximate: true } : null
}

/** Bản đồ và sơ đồ đón của từng xe. Tọa độ và thứ tự chỉ được lưu khi người điều hành bấm. */
export function PickupDiagram({ departure, rows, departureTime, loading, error }: {
  departure: string
  rows?: Row[]
  departureTime?: string
  loading: boolean
  error: unknown
}) {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const manage = can('ops.manage')
  const [pickingKey, setPickingKey] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [notFound, setNotFound] = useState<string[]>([])
  const [approximate, setApproximate] = useState<string[]>([])
  const stopper = useRef<AbortController | null>(null)
  useEffect(() => () => stopper.current?.abort(), [])

  const vehicles = useQuery({
    queryKey: ['departure', departure, 'assignments-lite'],
    queryFn: async () => unwrap(await supabase.from('vehicle_assignments').select('id, vehicles(name, seats)').eq('departure_id', departure)) as unknown as Row[],
  })
  const active = useMemo(() => (rows ?? []).filter((r) => r.presence === 'active'), [rows])
  const route = useMemo(() => buildPickupRoute(
    active as never,
    (vehicles.data ?? []).map((v) => ({ id: v.id, name: v.vehicles?.name ?? 'Xe', seats: v.vehicles?.seats })),
    departureTime,
  ), [active, vehicles.data, departureTime])

  const refresh = () => qc.invalidateQueries({ queryKey: ['departure', departure] })
  const saveCoords = (items: string[], lat: number, lng: number) => rpcOk('set_pickup_coordinates', { p_items: items, p_lat: lat, p_lng: lng })

  const place = useMutation({
    mutationFn: ({ stop, lat, lng }: { stop: PickupStop; lat: number; lng: number }) => saveCoords(stop.items, lat, lng),
    onSuccess: () => { setPickingKey(null); refresh() },
    onError: (e: Error) => { message.error(e.message); refresh() },
  })

  const missingStops = route.lanes.flatMap((l) => l.stops).filter((s) => !s.position)
  const locate = async () => {
    const control = new AbortController()
    stopper.current = control
    setNotFound([])
    setApproximate([])
    setProgress({ done: 0, total: missingStops.length })
    const failed: string[] = []
    const rough: string[] = []
    try {
      const known = await rpc<Row[]>('known_pickup_places', { p_org: orgId })
      const byName = new Map(known.map((k) => [shortPlaceName(k.hotel_name).toLowerCase(), k]))
      let done = 0
      for (const stop of missingStops) {
        const hit = byName.get(stop.name.toLowerCase())
        const at = hit ? { lat: Number(hit.latitude), lng: Number(hit.longitude), approximate: false } : await geocode(stop, control.signal)
        if (at) {
          await saveCoords(stop.items, at.lat, at.lng)
          if (at.approximate) rough.push(stop.name)
        } else failed.push(stop.name)
        done += 1
        setProgress({ done, total: missingStops.length })
        await refresh()
      }
      setNotFound(failed)
      setApproximate(rough)
      if (failed.length) message.warning(`Không tìm được ${failed.length} điểm. Hãy đặt tay trên bản đồ.`)
      else message.success('Đã tìm xong vị trí. Hãy xem lại các điểm trên bản đồ.')
    } catch (e) {
      if (!control.signal.aborted) message.error(e instanceof Error ? e.message : 'Không tìm được vị trí')
    } finally {
      setProgress(null)
    }
  }

  const apply = useMutation({
    mutationFn: (lane: PickupLane & { next: PickupStop[] }) => {
      // Giữ nguyên thứ tự của các xe khác; booking chưa có điểm đón nằm cuối.
      const itemsOf = (stops: PickupStop[]) => stops.flatMap((s) => s.items)
      const ordered = route.lanes.flatMap((l) => (l.key === lane.key ? itemsOf(lane.next) : itemsOf(l.stops)))
      const rest = active.map((r) => r.item_id as string).filter((id) => !ordered.includes(id))
      return rpcOk('reorder_pickups', { p_departure: departure, p_items: [...ordered, ...rest] })
    },
    onSuccess: () => { message.success('Đã đổi thứ tự đón. Hãy kiểm tra lại giờ đón.'); refresh() },
    onError: (e: Error) => message.error(e.message),
  })

  if (error) return <ErrorState error={error} />
  if (loading) return <Loading />
  if (route.lanes.length === 0 && route.missing.length === 0) return <Empty description="Chuyến chưa có khách" />

  const pickingStop = route.lanes.flatMap((l) => l.stops).find((s) => s.key === pickingKey)

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="Khoảng cách và đề xuất thứ tự tính theo đường chim bay, chưa tính đường một chiều và kẹt xe. Đường nét đứt trên bản đồ không phải đường xe chạy. Hãy xem lại trước khi áp dụng." />
      {manage && missingStops.length > 0 && (
        <Space wrap style={{ marginBottom: 12 }}>
          <Button type="primary" icon={<AimOutlined />} loading={Boolean(progress)} onClick={() => void locate()}>
            {progress ? `Đang tìm ${progress.done}/${progress.total}` : `Tìm vị trí ${missingStops.length} điểm đón`}
          </Button>
          <span className="muted">Gửi tên và địa chỉ khách sạn đến OpenStreetMap, không gửi thông tin khách. Vị trí tìm tự động có thể sai, kéo điểm trên bản đồ để sửa.</span>
        </Space>
      )}
      {notFound.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`Không tìm được: ${notFound.join(', ')}. Bấm "Đặt trên bản đồ" ở điểm đó.`} />}
      {approximate.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`Vị trí gần đúng theo tên phố: ${approximate.join(', ')}. Hãy kéo điểm đến đúng khách sạn.`} />}
      {pickingStop && <Alert type="info" style={{ marginBottom: 12 }} message={`Bấm lên bản đồ để đặt vị trí cho ${pickingStop.name}.`} action={<Button size="small" onClick={() => setPickingKey(null)}>Hủy</Button>} />}

      <PickupMap lanes={route.lanes} editable={manage} picking={Boolean(pickingStop)}
        onMove={(stop, lat, lng) => place.mutate({ stop, lat, lng })}
        onPick={(lat, lng) => { if (pickingStop) place.mutate({ stop: pickingStop, lat, lng }) }} />

      <div className="pickup-lanes">
        {route.lanes.map((lane, laneIndex) => {
          const color = LANE_COLORS[laneIndex % LANE_COLORS.length]!
          const proposal = proposeOrder(lane)
          return (
            <section key={lane.key} className="pickup-lane">
              <div className="pickup-lane-head">
                <b><span className="pickup-dot" style={{ background: color }} />{lane.name}</b>
                {lane.seats != null
                  ? <Tag color={lane.pax > lane.seats ? 'red' : 'cyan'}>{lane.pax}/{lane.seats} khách</Tag>
                  : <Tag>{lane.pax} khách</Tag>}
              </div>
              {proposal && (proposal.changed ? (
                <Alert type="success" style={{ marginBottom: 12 }} message={`Có thể rút từ ${km(proposal.before)} xuống ${km(proposal.after)}`}
                  description={<>
                    <div>{proposal.stops.map((s) => s.name).join(' → ')}</div>
                    {manage && <Button size="small" type="primary" icon={<NodeIndexOutlined />} style={{ marginTop: 8 }} loading={apply.isPending}
                      onClick={() => apply.mutate({ ...lane, next: proposal.stops })}>Áp dụng thứ tự này</Button>}
                  </>} />
              ) : <div className="muted" style={{ marginBottom: 12, fontSize: 12 }}>Thứ tự hiện tại đã ngắn nhất: {km(proposal.before)} đường chim bay</div>)}
              {lane.stops.length === 0 ? <div className="muted">Chưa có điểm đón nào trên xe này</div> : (
                <ol className="pickup-list">
                  {lane.stops.map((s, i) => (
                    <Stop key={s.key} stop={s} index={i} color={color} picking={pickingKey === s.key}
                      onPick={manage ? () => setPickingKey(pickingKey === s.key ? null : s.key) : undefined} />
                  ))}
                  <li className="pickup-stop pickup-end">
                    <span className="pickup-node"><FlagOutlined /></span>
                    <div className="pickup-body"><b>{departureTime ? String(departureTime).slice(0, 5) : ''} Khởi hành</b></div>
                  </li>
                </ol>
              )}
            </section>
          )
        })}
      </div>
      {route.missing.length > 0 && (
        <Alert type="warning" showIcon style={{ marginTop: 12 }} message={`${route.missing.length} booking chưa có điểm đón nên chưa nằm trên sơ đồ`}
          description={route.missing.map((m) => `${m.code} (${m.pax} khách${m.note ? `, ${m.note.toLowerCase()}` : ''})`).join(' · ')} />
      )}
    </>
  )
}
