import { EnvironmentOutlined, PhoneOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Card, Input, Radio, Space, Tag, Typography } from 'antd'
import { ATTENDANCE } from '@tours/core'
import dayjs from 'dayjs'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, Loading, NoData } from '../../components/common'
import { rpc, rpcOk, type Row } from '../../lib/supabase'

function Shell({ title, back, children }: { title: string; back?: boolean; children: React.ReactNode }) {
  const { signOut, session } = useAuth()
  return (
    <div className="guide-shell">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          {back && <Link to="/guide" style={{ marginRight: 8 }}>‹ Chuyến</Link>}
          <Typography.Text strong style={{ fontSize: 16 }}>{title}</Typography.Text>
        </div>
        <Button size="small" type="link" onClick={() => void signOut()} title={session?.user.email}>Đăng xuất</Button>
      </div>
      {children}
    </div>
  )
}

const timeOf = (d: Row) => `${dayjs(d.local_date).format('DD/MM')} ${String(d.local_time).slice(0, 5)}`

export function GuideListPage() {
  const q = useQuery({
    queryKey: ['guide-departures'],
    queryFn: () => rpc<Row[]>('guide_my_departures', {}),
  })
  if (q.isLoading) return <Shell title="Chuyến của tôi"><Loading /></Shell>
  if (q.isError) return <Shell title="Chuyến của tôi"><ErrorState error={q.error} onRetry={() => q.refetch()} /></Shell>
  const today = dayjs().format('YYYY-MM-DD')
  const rows = q.data ?? []
  const group = (title: string, list: Row[]) => list.length > 0 && (
    <div key={title}>
      <Typography.Title level={5}>{title}</Typography.Title>
      {list.map((d) => (
        <Link to={`/guide/${d.id}`} key={d.id}>
          <Card size="small" className="guide-card" hoverable>
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <div><b>{d.tour_name}</b><div className="muted">{d.option_name}</div></div>
              <div style={{ textAlign: 'right' }}><b>{timeOf(d)}</b><div className="muted">{d.pax} khách</div></div>
            </Space>
            {d.status === 'completed' && <Tag color="blue" style={{ marginTop: 6 }}>Đã chạy</Tag>}
          </Card>
        </Link>
      ))}
    </div>
  )
  return (
    <Shell title="Chuyến của tôi">
      {rows.length === 0 && <NoData text="Bạn chưa được giao chuyến nào" />}
      {group('Hôm nay', rows.filter((d) => d.local_date === today))}
      {group('Sắp tới', rows.filter((d) => d.local_date > today))}
      {group('Đã qua', rows.filter((d) => d.local_date < today))}
    </Shell>
  )
}

/** Mở ứng dụng bản đồ theo tọa độ, thiếu thì theo địa chỉ. Không tự tối ưu tuyến. */
function mapUrl(r: Row) {
  if (r.latitude != null && r.longitude != null) return `https://www.google.com/maps/search/?api=1&query=${r.latitude},${r.longitude}`
  const text = [r.hotel_name, r.address].filter(Boolean).join(', ')
  return text ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}` : null
}

export function GuideDeparturePage() {
  const { id = '' } = useParams()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [incident, setIncident] = useState('')

  const deps = useQuery({ queryKey: ['guide-departures'], queryFn: () => rpc<Row[]>('guide_my_departures', {}) })
  const list = useQuery({ queryKey: ['guide-manifest', id], queryFn: () => rpc<Row[]>('guide_manifest', { p_departure: id }) })
  const dep = deps.data?.find((d) => d.id === id)

  const attend = useMutation({
    mutationFn: ({ item, status }: { item: string; status: string }) => rpcOk('set_attendance', { p_departure: id, p_item: item, p_status: status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['guide-manifest', id] }),
    onError: (e: Error) => message.error(e.message),
  })
  const report = useMutation({
    mutationFn: () => rpcOk('report_incident', { p_departure: id, p_severity: 'normal', p_body: incident }),
    onSuccess: () => { setIncident(''); message.success('Đã gửi cho điều hành') },
    onError: (e: Error) => message.error(e.message),
  })

  if (deps.isLoading || list.isLoading) return <Shell title="Chuyến" back><Loading /></Shell>
  if (list.isError) return <Shell title="Chuyến" back><ErrorState error={list.error} onRetry={() => list.refetch()} /></Shell>
  if (!dep) return <Shell title="Chuyến" back><NoData text="Không tìm thấy chuyến này trong danh sách được giao" /></Shell>

  const rows = list.data ?? []
  const active = rows.filter((r) => r.presence === 'active')
  const picked = active.filter((r) => r.attendance === 'picked_up').reduce((s, r) => s + (r.pax_total as number), 0)
  const total = active.reduce((s, r) => s + (r.pax_total as number), 0)

  return (
    <Shell title={dep.tour_name} back>
      <Card size="small" className="guide-card">
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <b>{timeOf(dep)}</b>
          <span>Đã đón <b>{picked}</b>/{total} khách</span>
        </Space>
        {dep.joining_instructions && <p style={{ margin: '8px 0 0' }}>{dep.joining_instructions}</p>}
        {Array.isArray(dep.itinerary) && dep.itinerary.length > 0 && (
          <ol style={{ margin: '8px 0 0', paddingLeft: 20 }}>{dep.itinerary.map((s: Row | string, i: number) => <li key={i}>{typeof s === 'string' ? s : s.title}</li>)}</ol>
        )}
      </Card>

      <Card size="small" className="guide-card" title="Danh sách khách">
        {rows.length === 0 && <NoData text="Chưa có khách" />}
        {rows.map((r) => {
          const url = mapUrl(r)
          const inactive = r.presence !== 'active'
          return (
            <div key={r.item_id} className={`pax-row${inactive ? ' inactive' : ''}`}>
              <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                <div>
                  <b>{r.lead_name ?? 'Thiếu tên'}</b> · {r.pax_total} khách
                  {r.presence === 'moved' && <Tag color="orange" style={{ marginLeft: 4 }}>Đã chuyển chuyến</Tag>}
                  {r.presence === 'cancelled' && <Tag color="red" style={{ marginLeft: 4 }}>Đã hủy</Tag>}
                  <div className="muted" style={{ fontSize: 12 }}>{r.code}</div>
                </div>
                {r.lead_phone && !inactive && <a href={`tel:${r.lead_phone}`} aria-label="Gọi khách"><Button size="small" icon={<PhoneOutlined />} /></a>}
              </Space>
              {(r.hotel_name || r.address || r.pickup_local_time) && (
                <div style={{ marginTop: 4 }}>
                  {r.pickup_local_time && <b>{String(r.pickup_local_time).slice(0, 5)} </b>}
                  {[r.hotel_name, r.address].filter(Boolean).join(', ')}
                  {url && !inactive && <a href={url} target="_blank" rel="noreferrer" style={{ marginLeft: 8 }}><EnvironmentOutlined /> Bản đồ</a>}
                </div>
              )}
              {r.special_requests && <div style={{ marginTop: 4, color: '#b45309' }}>{r.special_requests}</div>}
              {r.ops_note && <div className="muted" style={{ marginTop: 4 }}>{r.ops_note}</div>}
              <div style={{ marginTop: 8 }}>
                {inactive ? (
                  r.attendance && <span className="muted">Đã ghi: {ATTENDANCE[r.attendance]}</span>
                ) : (
                  <Radio.Group buttonStyle="solid" value={r.attendance ?? 'pending'} onChange={(e) => attend.mutate({ item: r.item_id, status: e.target.value })}
                    options={Object.entries(ATTENDANCE).map(([value, label]) => ({ value, label }))} optionType="button" />
                )}
              </div>
            </div>
          )
        })}
      </Card>

      <Card size="small" className="guide-card" title="Báo sự cố">
        <Input.TextArea rows={3} value={incident} placeholder="Mô tả sự cố" onChange={(e) => setIncident(e.target.value)} />
        <Button type="primary" block style={{ marginTop: 8 }} disabled={!incident.trim()} loading={report.isPending} onClick={() => report.mutate()}>Gửi cho điều hành</Button>
      </Card>
    </Shell>
  )
}
