import { useQuery } from '@tanstack/react-query'
import { Card, Col, DatePicker, Row as GridRow, Table } from 'antd'
import { CHANNEL } from '@tours/core'
import dayjs from 'dayjs'
import { useMemo, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, Loading, MoneyText, NoData, PageHead } from '../../components/common'
import { rpc, supabase, unwrap, type Row } from '../../lib/supabase'

const COLORS: Record<string, string> = { viator: '#0f766e', getyourguide: '#d97706', manual: '#64748b', other: '#7c3aed' }

export function ReportsPage() {
  const { orgId } = useAuth()
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(29, 'day'), dayjs().add(30, 'day')])
  const from = range[0].format('YYYY-MM-DD')
  const to = range[1].format('YYYY-MM-DD')

  const summary = useQuery({
    queryKey: ['report-summary', orgId, from, to],
    queryFn: () => rpc<Row>('dashboard_summary', { p_org: orgId, p_from: from, p_to: to, p_connection: null }),
  })
  const byTour = useQuery({
    queryKey: ['report-by-tour', orgId, from, to],
    queryFn: async () => {
      const rows = unwrap(await supabase.from('v_booking_list').select('tour_name, status, pax_total, channel, local_date')
        .eq('organization_id', orgId).gte('local_date', from).lte('local_date', to).limit(5000)) as Row[]
      const map = new Map<string, Row>()
      for (const r of rows) {
        const key = r.tour_name ?? 'Chưa ghép mã'
        const m = map.get(key) ?? { tour: key, bookings: 0, cancelled: 0, pax: 0 }
        m.bookings += 1
        if (r.status === 'cancelled') m.cancelled += 1
        else m.pax += r.pax_total ?? 0
        map.set(key, m)
      }
      return [...map.values()].sort((a, b) => b.pax - a.pax)
    },
  })
  const occupancy = useQuery({
    queryKey: ['report-occupancy', orgId, from, to],
    queryFn: async () => {
      const rows = unwrap(await supabase.from('v_departure_availability').select('local_date, capacity, committed_seats')
        .eq('organization_id', orgId).gte('local_date', from).lte('local_date', to).order('local_date').limit(2000)) as Row[]
      const map = new Map<string, Row>()
      for (const r of rows) {
        const m = map.get(r.local_date) ?? { day: dayjs(r.local_date).format('DD/MM'), capacity: 0, seats: 0 }
        m.capacity += r.capacity
        m.seats += r.committed_seats
        map.set(r.local_date, m)
      }
      return [...map.values()]
    },
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
  const channels = [...new Set(((summary.data?.bookings_by_day ?? []) as Row[]).map((r) => r.channel as string))]

  return (
    <>
      <PageHead title="Báo cáo" extra={
        <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={range} onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} />
      } />
      {summary.isError ? <ErrorState error={summary.error} onRetry={() => summary.refetch()} /> : summary.isLoading ? <Loading /> : (
        <GridRow gutter={[16, 16]}>
          <Col xs={24} xl={12}>
            <Card size="small" title="Booking theo ngày đặt và kênh">
              {chart.length === 0 ? <NoData /> : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chart}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="day" fontSize={12} /><YAxis allowDecimals={false} width={32} fontSize={12} />
                    <Tooltip /><Legend formatter={(v: string) => CHANNEL[v] ?? v} />
                    {channels.map((c) => <Bar key={c} dataKey={c} stackId="a" fill={COLORS[c] ?? '#94a3b8'} />)}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </Card>
          </Col>
          <Col xs={24} xl={12}>
            <Card size="small" title="Công suất theo ngày đi (chỗ đã xác nhận / sức chứa)">
              {(occupancy.data ?? []).length === 0 ? <NoData /> : (
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={occupancy.data}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="day" fontSize={12} /><YAxis width={36} fontSize={12} />
                    <Tooltip /><Legend />
                    <Line type="monotone" dataKey="capacity" name="Sức chứa" stroke="#94a3b8" dot={false} />
                    <Line type="monotone" dataKey="seats" name="Đã xác nhận" stroke="#0f766e" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Card>
          </Col>
          <Col xs={24} xl={12}>
            <Card size="small" title="Theo tour (ngày đi trong khoảng)">
              <Table rowKey="tour" size="small" loading={byTour.isLoading} dataSource={byTour.data} pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: <NoData /> }} columns={[
                { title: 'Tour', dataIndex: 'tour' },
                { title: 'Booking', dataIndex: 'bookings', align: 'right' },
                { title: 'Đã hủy', dataIndex: 'cancelled', align: 'right' },
                { title: 'Khách', dataIndex: 'pax', align: 'right' },
              ]} />
            </Card>
          </Col>
          <Col xs={24} xl={12}>
            <Card size="small" title="Giá trị booking theo tiền tệ">
              <Table rowKey="currency" size="small" dataSource={summary.data?.values_by_currency as Row[]} pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: <NoData /> }} columns={[
                { title: 'Tiền tệ', dataIndex: 'currency' },
                { title: 'Booking', dataIndex: 'bookings', align: 'right' },
                { title: 'Giá trị bán', align: 'right', render: (_, r) => <MoneyText amount={r.gross} currency={r.currency} /> },
              ]} />
              <p className="muted" style={{ marginTop: 8 }}>Mỗi tiền tệ tính riêng. Báo cáo lợi nhuận nằm ở mục Tài chính và đối soát.</p>
            </Card>
          </Col>
        </GridRow>
      )}
    </>
  )
}
