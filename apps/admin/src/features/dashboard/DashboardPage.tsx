import { useQuery } from '@tanstack/react-query'
import { Alert, Card, Col, DatePicker, List, Row as GridRow, Select, Space, Table, Tag } from 'antd'
import { CHANNEL } from '@tours/core'
import dayjs from 'dayjs'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, fmtDateTime, Loading, LocalTime, MoneyText, NoData, PageHead } from '../../components/common'
import { CONNECTION_COLUMNS, rpc, supabase, unwrap, type Row } from '../../lib/supabase'

const CHANNEL_COLORS: Record<string, string> = { viator: '#0f766e', getyourguide: '#d97706', manual: '#64748b', other: '#7c3aed' }

export function DashboardPage() {
  const { orgId, can } = useAuth()
  const nav = useNavigate()
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(29, 'day'), dayjs()])
  const [connection, setConnection] = useState<string | undefined>()
  const from = range[0].format('YYYY-MM-DD')
  const to = range[1].format('YYYY-MM-DD')

  const summary = useQuery({
    queryKey: ['dashboard', orgId, from, to, connection],
    queryFn: () => rpc<Row>('dashboard_summary', { p_org: orgId, p_from: from, p_to: to, p_connection: connection ?? null }),
  })
  const connections = useQuery({
    queryKey: ['connections-lite', orgId],
    queryFn: async () => unwrap(await supabase.from('channel_connections').select(CONNECTION_COLUMNS).eq('organization_id', orgId)) as unknown as Row[],
  })
  const upcoming = useQuery({
    queryKey: ['dashboard-upcoming', orgId],
    enabled: can('departure.read'),
    queryFn: async () =>
      unwrap(await supabase.from('v_departure_availability').select('id, tour_name, option_name, local_date, local_time, timezone, committed_seats, capacity, guide_count, vehicle_count')
        .eq('organization_id', orgId).eq('status', 'scheduled').gte('local_date', dayjs().format('YYYY-MM-DD'))
        .gt('departure_seats', 0).order('starts_at').limit(8)) as Row[],
  })
  const recent = useQuery({
    queryKey: ['dashboard-recent', orgId],
    queryFn: async () =>
      unwrap(await supabase.from('booking_changes').select('id, summary, created_at, booking_id, bookings(code, lead_name)')
        .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(8)) as unknown as Row[],
  })

  const chart = useMemo(() => {
    const byDay = new Map<string, Row>()
    for (const r of (summary.data?.bookings_by_day ?? []) as Row[]) {
      const row = byDay.get(r.day) ?? { day: dayjs(r.day).format('DD/MM') }
      row[r.channel] = r.bookings
      byDay.set(r.day, row)
    }
    return [...byDay.values()]
  }, [summary.data])
  const chartChannels = useMemo(() => [...new Set(((summary.data?.bookings_by_day ?? []) as Row[]).map((r) => r.channel as string))], [summary.data])

  if (summary.isLoading) return <Loading />
  if (summary.isError) return <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
  const s = summary.data as Row

  const q = `booked_from=${from}&booked_to=${to}${connection ? `&connection=${connection}` : ''}`
  const kpis = [
    { label: 'Booking mới', value: s.new_bookings, to: `/bookings?${q}` },
    { label: 'Booking bị hủy', value: s.cancelled_bookings, to: `/bookings?status=cancelled` },
    { label: 'Khách khởi hành hôm nay', value: s.pax_today, to: `/operations?from=${s.today}&to=${s.today}` },
    { label: 'Chuyến hôm nay / ngày mai', value: `${s.departures_today} / ${s.departures_tomorrow}`, to: `/departures?from=${s.today}&to=${dayjs(s.today).add(1, 'day').format('YYYY-MM-DD')}&view=list` },
    { label: 'Chuyến thiếu HDV hoặc xe (7 ngày)', value: s.departures_missing_resources, to: `/operations?flag=missing`, warn: s.departures_missing_resources > 0 },
    { label: 'Booking thiếu thông tin', value: s.bookings_missing_info, to: `/bookings?ops=needs_mapping,needs_departure,needs_info`, warn: s.bookings_missing_info > 0 },
  ]

  const tasks = [
    { label: 'Chưa ghép mã', value: s.tasks?.needs_mapping ?? 0, to: '/bookings?ops=needs_mapping', color: 'red' },
    { label: 'Chưa xếp chuyến', value: s.tasks?.needs_departure ?? 0, to: '/bookings?ops=needs_departure', color: 'orange' },
    { label: 'Thiếu điểm đón', value: s.tasks?.needs_info ?? 0, to: '/bookings?ops=needs_info', color: 'gold' },
    { label: 'Đổi sau phân công', value: s.tasks?.changed_after_assignment ?? 0, to: '/operations?flag=changed', color: 'red' },
    { label: 'Đánh dấu cần xử lý', value: s.tasks?.needs_action ?? 0, to: '/bookings?action=1', color: 'orange' },
    { label: 'Chuyến thiếu HDV hoặc xe', value: s.departures_missing_resources ?? 0, to: '/operations?flag=missing', color: 'orange' },
  ].filter((t) => t.value > 0)

  return (
    <>
      <PageHead title="Tổng quan" extra={
        <Space wrap>
          <DatePicker.RangePicker value={range} allowClear={false} format="DD/MM/YYYY"
            onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} />
          <Select allowClear placeholder="Mọi nguồn bán" style={{ minWidth: 180 }} value={connection} onChange={setConnection}
            options={(connections.data ?? []).map((c) => ({ value: c.id, label: `${CHANNEL[c.channel] ?? c.channel} · ${c.account_name}` }))} />
        </Space>
      } />

      {(connections.data ?? []).some((c) => c.mode === 'mock') && (
        <div className="mock-banner">Có kết nối đang ở chế độ <b>mô phỏng</b>: booking từ các kết nối đó là dữ liệu thử nghiệm, không phải đơn thật từ kênh.</div>
      )}
      {s.failed_events > 0 && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={<>Có {s.failed_events} sự kiện đồng bộ lỗi. <Link to="/connections?tab=events&status=failed">Xem nhật ký</Link></>} />
      )}

      <div className="kpi-grid">
        {kpis.map((k) => (
          <Card key={k.label} size="small" className="kpi-card" onClick={() => nav(k.to)}>
            <div className="kpi-value" style={k.warn ? { color: '#b45309' } : undefined}>{k.value}</div>
            <div className="kpi-label">{k.label}</div>
          </Card>
        ))}
      </div>

      <Card size="small" title="Giá trị booking theo tiền tệ" style={{ marginBottom: 16 }}>
        <Table rowKey="currency" size="small" pagination={false} dataSource={s.values_by_currency as Row[]} scroll={{ x: 'max-content' }}
          locale={{ emptyText: <NoData text="Chưa có booking trong khoảng này" /> }}
          columns={[
            { title: 'Tiền tệ', dataIndex: 'currency' },
            { title: 'Số booking', dataIndex: 'bookings', align: 'right' },
            { title: 'Giá trị bán', render: (_, r) => <MoneyText amount={r.gross} currency={r.currency} />, align: 'right' },
            ...(can('finance.read') ? [
              { title: 'Dự kiến nhận', align: 'right' as const, render: (_: unknown, r: Row) => <><MoneyText amount={r.expected} currency={r.currency} />{r.expected_missing > 0 && <div className="muted" style={{ fontSize: 12 }}>{r.expected_missing} booking chưa có số</div>}</> },
              { title: 'Thực nhận', align: 'right' as const, render: (_: unknown, r: Row) => <><MoneyText amount={r.actual} currency={r.currency} />{r.actual_missing > 0 && <div className="muted" style={{ fontSize: 12 }}>{r.actual_missing} booking chưa đối soát</div>}</> },
            ] : []),
          ]} />
      </Card>

      <Card size="small" title="Công việc cần xử lý" style={{ marginBottom: 16 }}>
        {tasks.length === 0 ? <span className="muted">Không có việc tồn đọng.</span> : (
          <Space wrap>
            {tasks.map((t) => <Link key={t.label} to={t.to}><Tag color={t.color} style={{ cursor: 'pointer', padding: '2px 8px' }}>{t.label}: {t.value}</Tag></Link>)}
          </Space>
        )}
      </Card>

      <GridRow gutter={[16, 16]}>
        <Col xs={24} xl={14}>
          <Card size="small" title="Booking theo ngày và theo kênh">
            {chart.length === 0 ? <NoData /> : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={chart}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" fontSize={12} />
                  <YAxis allowDecimals={false} fontSize={12} width={32} />
                  <Tooltip />
                  <Legend formatter={(v: string) => CHANNEL[v] ?? v} />
                  {chartChannels.map((c) => <Bar key={c} dataKey={c} stackId="a" fill={CHANNEL_COLORS[c] ?? '#94a3b8'} name={c} />)}
                </BarChart>
              </ResponsiveContainer>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={10}>
          <Card size="small" title="Lịch chạy sắp tới" extra={<Link to="/departures?view=list">Xem tất cả</Link>}>
            <List size="small" dataSource={upcoming.data ?? []} loading={upcoming.isLoading} locale={{ emptyText: 'Chưa có chuyến có khách' }}
              renderItem={(d) => (
                <List.Item actions={[<Link key="o" to={`/operations/${d.id}`}>Mở</Link>]}>
                  <List.Item.Meta title={d.tour_name} description={
                    <Space wrap size={4}>
                      <LocalTime date={d.local_date} time={d.local_time} tz={d.timezone} />
                      <span>· {d.committed_seats}/{d.capacity} chỗ</span>
                      {d.guide_count === 0 && <Tag color="orange">Thiếu HDV</Tag>}
                      {d.vehicle_count === 0 && <Tag color="orange">Thiếu xe</Tag>}
                    </Space>
                  } />
                </List.Item>
              )} />
          </Card>
        </Col>
        <Col xs={24}>
          <Card size="small" title="Booking vừa thay đổi">
            <List size="small" dataSource={recent.data ?? []} loading={recent.isLoading} locale={{ emptyText: 'Chưa có thay đổi' }}
              renderItem={(c) => (
                <List.Item>
                  <Link to={`/bookings/${c.booking_id}`}>{c.bookings?.code}</Link>
                  <span style={{ flex: 1, marginLeft: 12 }}>{c.bookings?.lead_name} · {c.summary}</span>
                  <span className="muted nowrap">{fmtDateTime(c.created_at)}</span>
                </List.Item>
              )} />
          </Card>
        </Col>
      </GridRow>
    </>
  )
}
