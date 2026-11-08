import { EnvironmentOutlined, FlagOutlined } from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { Alert, Empty, Tag, Tooltip } from 'antd'
import { buildPickupRoute, type PickupStop } from '@tours/core'
import { useMemo } from 'react'
import { ErrorState, Loading } from '../../components/common'
import { supabase, unwrap, type Row } from '../../lib/supabase'

function Stop({ stop, index }: { stop: PickupStop; index: number }) {
  const warnings = [
    stop.outOfOrder && 'Giờ đón sớm hơn điểm trước',
    stop.afterDeparture && 'Giờ đón không sớm hơn giờ khởi hành',
    stop.mixedTimes && 'Các booking ghi giờ đón khác nhau',
  ].filter(Boolean) as string[]
  return (
    <li className="pickup-stop">
      <span className="pickup-node">{index + 1}</span>
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
        {warnings.map((w) => <Tag key={w} color="red" style={{ marginTop: 4 }}>{w}</Tag>)}
      </div>
    </li>
  )
}

/** Sơ đồ thứ tự đón của từng xe. Thứ tự lấy từ danh sách khách, nơi điều hành sắp bằng nút lên xuống. */
export function PickupDiagram({ departure, rows, departureTime, loading, error }: {
  departure: string
  rows?: Row[]
  departureTime?: string
  loading: boolean
  error: unknown
}) {
  const vehicles = useQuery({
    queryKey: ['departure', departure, 'assignments-lite'],
    queryFn: async () => unwrap(await supabase.from('vehicle_assignments').select('id, vehicles(name, seats)').eq('departure_id', departure)) as unknown as Row[],
  })
  const route = useMemo(() => buildPickupRoute(
    (rows ?? []).filter((r) => r.presence === 'active') as never,
    (vehicles.data ?? []).map((v) => ({ id: v.id, name: v.vehicles?.name ?? 'Xe', seats: v.vehicles?.seats })),
    departureTime,
  ), [rows, vehicles.data, departureTime])

  if (error) return <ErrorState error={error} />
  if (loading) return <Loading />
  if (route.lanes.length === 0 && route.missing.length === 0) return <Empty description="Chuyến chưa có khách" />

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="Đây là sơ đồ thứ tự đón, không phải bản đồ: khoảng cách trên sơ đồ không phản ánh đường đi thật. Đổi thứ tự bằng nút lên xuống ở tab Khách, đặt giờ đón bằng nút Sửa." />
      <div className="pickup-lanes">
        {route.lanes.map((lane) => (
          <section key={lane.key} className="pickup-lane">
            <div className="pickup-lane-head">
              <b>{lane.name}</b>
              {lane.seats != null
                ? <Tag color={lane.pax > lane.seats ? 'red' : 'cyan'}>{lane.pax}/{lane.seats} khách</Tag>
                : <Tag>{lane.pax} khách</Tag>}
            </div>
            {lane.stops.length === 0 ? <div className="muted">Chưa có điểm đón nào trên xe này</div> : (
              <ol className="pickup-list">
                {lane.stops.map((s, i) => <Stop key={s.key} stop={s} index={i} />)}
                <li className="pickup-stop pickup-end">
                  <span className="pickup-node"><FlagOutlined /></span>
                  <div className="pickup-body"><b>{departureTime ? String(departureTime).slice(0, 5) : ''} Khởi hành</b></div>
                </li>
              </ol>
            )}
          </section>
        ))}
      </div>
      {route.missing.length > 0 && (
        <Alert type="warning" showIcon style={{ marginTop: 12 }} message={`${route.missing.length} booking chưa có điểm đón nên chưa nằm trên sơ đồ`}
          description={route.missing.map((m) => `${m.code} (${m.pax} khách${m.note ? `, ${m.note.toLowerCase()}` : ''})`).join(' · ')} />
      )}
    </>
  )
}
