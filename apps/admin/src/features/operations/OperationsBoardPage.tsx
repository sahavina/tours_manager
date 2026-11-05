import { useQuery } from '@tanstack/react-query'
import { Card, DatePicker, Select, Table, Tag } from 'antd'
import dayjs from 'dayjs'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, LocalTime, NoData, PageHead } from '../../components/common'
import { rpc, type Row } from '../../lib/supabase'
import { useUrlTable } from '../../lib/use-url-state'
import { BookingMix, MIX_FILTERS, MIX_OPTIONS } from '../departures/BookingMix'

const FLAGS: Record<string, { label: string; test: (d: Row) => boolean }> = {
  missing: { label: 'Thiếu HDV hoặc xe', test: (d) => d.missing_guide || d.missing_vehicle },
  missing_guide: { label: 'Thiếu hướng dẫn viên', test: (d) => d.missing_guide },
  missing_vehicle: { label: 'Thiếu xe', test: (d) => d.missing_vehicle },
  missing_pickup: { label: 'Thiếu điểm đón', test: (d) => d.missing_pickup > 0 },
  supplier: { label: 'Chưa xác nhận nhà cung cấp', test: (d) => d.supplier_unconfirmed },
  changed: { label: 'Có thay đổi sau phân công', test: (d) => d.changed_after_assignment > 0 },
  contact: { label: 'Cần liên hệ khách', test: (d) => d.needs_contact > 0 },
  clash: { label: 'Trùng lịch HDV hoặc xe', test: (d) => d.guide_clash > 0 || d.vehicle_clash > 0 || d.possible_clash > 0 },
}

export function OperationsBoardPage() {
  const { orgId } = useAuth()
  const table = useUrlTable()
  const f = table.filters
  const from = f.from ?? dayjs().format('YYYY-MM-DD')
  const to = f.to ?? dayjs().add(7, 'day').format('YYYY-MM-DD')

  const board = useQuery({
    queryKey: ['ops-board', orgId, from, to],
    queryFn: () => rpc<Row[]>('ops_board', { p_org: orgId, p_from: from, p_to: to }),
  })
  const flag = f.flag ? FLAGS[f.flag] : undefined
  const mixFilter = f.mix ? MIX_FILTERS[f.mix] : undefined
  const rows = (board.data ?? []).filter((d) => (f.all === '1' || d.seats > 0) && (!flag || flag.test(d)) && (!mixFilter || mixFilter.test(d.bookings, d.channel_mix, d.is_private)))

  return (
    <>
      <PageHead title="Điều hành" />
      <Card>
        <div className="filters">
          <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(from), dayjs(to)]}
            onChange={(v) => table.patch({ filters: { from: v?.[0]?.format('YYYY-MM-DD'), to: v?.[1]?.format('YYYY-MM-DD') } })} />
          <Select allowClear placeholder="Mọi việc cần làm" style={{ minWidth: 230 }} value={f.flag}
            options={Object.entries(FLAGS).map(([value, v]) => ({ value, label: v.label }))} onChange={(v) => table.patch({ filters: { flag: v } })} />
          <Select style={{ minWidth: 170 }} value={f.all === '1' ? '1' : ''} options={[{ value: '', label: 'Chuyến có khách' }, { value: '1', label: 'Mọi chuyến' }]}
            onChange={(v) => table.patch({ filters: { all: v || undefined } })} />
          <Select allowClear placeholder="Mọi kiểu ghép" style={{ minWidth: 190 }} value={f.mix} options={MIX_OPTIONS}
            onChange={(v) => table.patch({ filters: { mix: v } })} />
        </div>
        {board.isError ? <ErrorState error={board.error} onRetry={() => board.refetch()} /> : (
          <Table rowKey="id" size="middle" loading={board.isLoading} dataSource={rows} scroll={{ x: 'max-content' }} pagination={{ pageSize: 50, hideOnSinglePage: true }}
            locale={{ emptyText: <NoData text="Không có việc nào trong khoảng này" /> }}
            columns={[
              { title: 'Ngày giờ', render: (_, d) => <Link to={`/operations/${d.id}`}><LocalTime date={d.local_date} time={d.local_time} tz={d.timezone} /></Link> },
              { title: 'Tour', render: (_, d) => <>{d.tour_name}<div className="muted" style={{ fontSize: 12 }}>{d.option_name ?? 'Mọi gói'}</div></> },
              { title: 'Khách', dataIndex: 'seats', align: 'right' },
              { title: 'Booking / kênh', render: (_, d) => <BookingMix bookings={d.bookings} mix={d.channel_mix} isPrivate={d.is_private} /> },
              { title: 'Chỗ xe', align: 'right', render: (_, d) => d.vehicles > 0 ? <span style={{ color: d.vehicle_over ? '#b91c1c' : undefined }}>{d.vehicle_seats}</span> : '' },
              { title: 'Việc cần làm', render: (_, d) => {
                const tags = [
                  d.guide_clash > 0 && <Tag key="gc" color="red">Trùng lịch HDV</Tag>,
                  d.vehicle_clash > 0 && <Tag key="vc" color="red">Trùng lịch xe</Tag>,
                  d.possible_clash > 0 && <Tag key="pc" color="gold">Có thể trùng lịch</Tag>,
                  d.missing_guide && <Tag key="g" color="orange">Thiếu HDV</Tag>,
                  d.missing_vehicle && <Tag key="v" color="orange">Thiếu xe</Tag>,
                  d.vehicle_over && <Tag key="o" color="red">Khách vượt chỗ xe</Tag>,
                  d.missing_pickup > 0 && <Tag key="p" color="gold">Thiếu điểm đón: {d.missing_pickup}</Tag>,
                  d.supplier_unconfirmed && <Tag key="s">Chưa xác nhận NCC</Tag>,
                  d.changed_after_assignment > 0 && <Tag key="c" color="red">Có thay đổi: {d.changed_after_assignment}</Tag>,
                  d.needs_contact > 0 && <Tag key="n" color="red">Cần liên hệ: {d.needs_contact}</Tag>,
                  d.vehicles > 0 && d.unallocated > 0 && <Tag key="u">Chưa chia xe: {d.unallocated}</Tag>,
                ].filter(Boolean)
                return tags.length ? tags : d.seats > 0 ? <Tag color="green">Đủ</Tag> : <span className="muted">Chưa có khách</span>
              } },
            ]} />
        )}
      </Card>
    </>
  )
}
