import { DownloadOutlined, PlusOutlined, SaveOutlined, SettingOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Card, Checkbox, DatePicker, Dropdown, Input, Modal, Popover, Select, Space, Table, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { BOOKING_STATUS, CHANNEL, OPS_STATUS, toCsv } from '@tours/core'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import {
  BookingStatusTag, Can, ChannelLabel, ErrorState, fmtDateTime, LocalTime, MoneyText, NoData, OpsStatusTag, PageHead, SyncStatusTag,
} from '../../components/common'
import { CONNECTION_COLUMNS, friendlyError, rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'
import { downloadText, readLocal, useUrlTable, writeLocal } from '../../lib/use-url-state'
import { CreateBookingDrawer } from './CreateBookingDrawer'

const ALL_COLUMNS: Array<{ key: string; title: string; sort?: string; render: (r: Row) => React.ReactNode }> = [
  { key: 'code', title: 'Mã nội bộ', sort: 'code', render: (r) => <Link to={`/bookings/${r.id}`}>{r.code}</Link> },
  { key: 'channel', title: 'Nguồn bán', render: (r) => <ChannelLabel channel={r.channel} account={r.account_name} mode={r.connection_mode} /> },
  { key: 'external_ref', title: 'Mã bên ngoài', render: (r) => r.external_ref ?? <span className="muted">Không có</span> },
  { key: 'lead_name', title: 'Khách đại diện', sort: 'lead_name', render: (r) => r.lead_name ?? <span className="muted">Thiếu</span> },
  { key: 'tour', title: 'Tour / gói', render: (r) => r.tour_name ? <>{r.tour_name}<div className="muted" style={{ fontSize: 12 }}>{r.option_name}</div></> : <Tooltip title={r.external_product_code}><Tag color="red">Chưa ghép mã</Tag></Tooltip> },
  { key: 'local_date', title: 'Ngày giờ đi', sort: 'local_date', render: (r) => <LocalTime date={r.local_date} time={r.local_time} tz={r.timezone} /> },
  { key: 'pax_total', title: 'Số khách', sort: 'pax_total', render: (r) => r.pax_total ?? 0 },
  { key: 'pickup', title: 'Điểm đón', render: (r) => r.pickup_hotel ?? r.pickup_address ?? <span className="muted">Không có</span> },
  { key: 'status', title: 'Trạng thái', sort: 'status', render: (r) => <BookingStatusTag value={r.status} /> },
  { key: 'ops_status', title: 'Điều hành', sort: 'ops_status', render: (r) => <><OpsStatusTag value={r.ops_status} />{r.needs_action && <Tooltip title={r.action_reason}><Tag color="red">Cần xử lý</Tag></Tooltip>}</> },
  { key: 'gross_amount', title: 'Giá trị', sort: 'gross_amount', render: (r) => <MoneyText amount={r.gross_amount} currency={r.currency} /> },
  { key: 'owner_name', title: 'Phụ trách', render: (r) => r.owner_name ?? <span className="muted">Chưa gán</span> },
  { key: 'sync_status', title: 'Đồng bộ', render: (r) => <SyncStatusTag value={r.sync_status} /> },
  { key: 'booked_at', title: 'Ngày đặt', sort: 'booked_at', render: (r) => <span className="nowrap">{fmtDateTime(r.booked_at)}</span> },
]

const DEFAULT_COLUMNS = ALL_COLUMNS.filter((c) => c.key !== 'booked_at').map((c) => c.key)
const SORTABLE = new Set(ALL_COLUMNS.filter((c) => c.sort).map((c) => c.sort))

export function BookingListPage() {
  const { orgId, session, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const table = useUrlTable(25)
  const f = table.filters
  const [cols, setCols] = useState<string[]>(() => readLocal('tourhub.bookingCols', DEFAULT_COLUMNS))
  const [search, setSearch] = useState(f.q ?? '')
  const [selected, setSelected] = useState<string[]>([])
  const [creating, setCreating] = useState(f.new === '1')

  useEffect(() => { setSearch(f.q ?? '') }, [f.q])
  useEffect(() => {
    if (f.new === '1') {
      setCreating(true)
      table.patch({ filters: { new: undefined } })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.new])
  // Bỏ lựa chọn khi đổi bộ lọc: nếu không, thanh thao tác hàng loạt sẽ tác động lên dòng không còn nhìn thấy.
  const filterKey = JSON.stringify(f)
  useEffect(() => setSelected([]), [filterKey])

  const connections = useQuery({
    queryKey: ['connections-lite', orgId],
    queryFn: async () => unwrap(await supabase.from('channel_connections').select(CONNECTION_COLUMNS).eq('organization_id', orgId)) as unknown as Row[],
  })
  const tours = useQuery({
    queryKey: ['tours-lite', orgId],
    enabled: can('catalog.read'),
    queryFn: async () => unwrap(await supabase.from('tours').select('id, name').eq('organization_id', orgId).is('deleted_at', null).order('name')) as Row[],
  })
  const savedFilters = useQuery({
    queryKey: ['saved-filters', orgId],
    queryFn: async () => unwrap(await supabase.from('saved_filters').select('id, name, filters').eq('organization_id', orgId).eq('scope', 'bookings').order('name')) as Row[],
  })

  const sort = table.sort && SORTABLE.has(table.sort) ? table.sort : 'booked_at'
  const desc = table.sort && SORTABLE.has(table.sort) ? table.desc : true

  const list = useQuery({
    queryKey: ['bookings', orgId, filterKey, table.page, table.pageSize, sort, desc],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      let q = supabase.from('v_booking_list').select('*', { count: 'exact' }).eq('organization_id', orgId)
      if (f.q) q = q.ilike('search_text', `%${f.q.toLowerCase().replace(/[%_]/g, '\\$&')}%`)
      if (f.status) q = q.in('status', f.status.split(','))
      if (f.ops) q = q.in('ops_status', f.ops.split(','))
      if (f.connection) q = q.eq('connection_id', f.connection)
      if (f.tour) q = q.eq('tour_id', f.tour)
      if (f.departure) q = q.eq('departure_id', f.departure)
      if (f.travel_from) q = q.gte('local_date', f.travel_from)
      if (f.travel_to) q = q.lte('local_date', f.travel_to)
      if (f.booked_from) q = q.gte('booked_at', dayjs(f.booked_from).startOf('day').toISOString())
      if (f.booked_to) q = q.lte('booked_at', dayjs(f.booked_to).endOf('day').toISOString())
      if (f.action === '1') q = q.eq('needs_action', true)
      const fromIdx = (table.page - 1) * table.pageSize
      const res = await q.order(sort, { ascending: !desc, nullsFirst: false }).order('id').range(fromIdx, fromIdx + table.pageSize - 1)
      if (res.error) throw new Error(friendlyError(res.error))
      return { rows: res.data as Row[], total: res.count ?? 0 }
    },
  })

  const setFilter = (key: string, value: string | undefined) => table.patch({ filters: { [key]: value } })

  const columns: ColumnsType<Row> = ALL_COLUMNS.filter((c) => cols.includes(c.key)).map((c) => ({
    title: c.title,
    key: c.key,
    render: (_: unknown, r: Row) => c.render(r),
    sorter: Boolean(c.sort),
    sortOrder: c.sort === sort ? (desc ? 'descend' : 'ascend') : null,
    columnKey: c.sort,
  }))

  const bulk = useMutation({
    mutationFn: async (patch: Row) => {
      // Chỉ sửa trường nội bộ, không có gì được gửi sang kênh.
      await Promise.all(selected.map((id) => rpcOk('update_booking_internal', { p_booking: id, p_patch: patch })))
    },
    onSuccess: () => {
      message.success(`Đã cập nhật ${selected.length} booking`)
      setSelected([])
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (e: Error) => message.error(e.message),
  })

  const exportCsv = useMutation({
    mutationFn: async () => {
      const rows = await rpc<Row[]>('export_bookings', {
        p_org: orgId,
        p_filters: {
          status: f.status?.includes(',') ? undefined : f.status,
          ops_status: f.ops?.includes(',') ? undefined : f.ops,
          connection_id: f.connection, travel_from: f.travel_from, travel_to: f.travel_to, q: f.q,
        },
      })
      downloadText(`booking-${dayjs().format('YYYYMMDD-HHmm')}.csv`, toCsv(rows))
      return rows.length
    },
    onSuccess: (n) => message.success(`Đã xuất ${n} booking`),
    onError: (e: Error) => message.error(e.message),
  })

  const saveFilter = () => {
    let name = ''
    Modal.confirm({
      title: 'Lưu bộ lọc hiện tại',
      content: <Input placeholder="Tên bộ lọc" onChange={(e) => (name = e.target.value)} />,
      okText: 'Lưu',
      cancelText: 'Hủy',
      onOk: async () => {
        if (!name.trim()) {
          message.error('Nhập tên bộ lọc')
          throw new Error('name required')
        }
        const res = await supabase.from('saved_filters').upsert(
          { organization_id: orgId, user_id: session!.user.id, scope: 'bookings', name: name.trim(), filters: f },
          { onConflict: 'organization_id,user_id,scope,name' },
        )
        if (res.error) {
          message.error(friendlyError(res.error))
          throw res.error
        }
        message.success('Đã lưu bộ lọc')
        qc.invalidateQueries({ queryKey: ['saved-filters'] })
      },
    })
  }

  const members = useQuery({
    queryKey: ['members-lite', orgId],
    enabled: can('member.manage'),
    queryFn: () => rpc<Row[]>('member_list', { p_org: orgId }),
  })

  const statusOptions = useMemo(() => Object.entries(BOOKING_STATUS).map(([value, label]) => ({ value, label })), [])
  const opsOptions = useMemo(() => Object.entries(OPS_STATUS).map(([value, label]) => ({ value, label })), [])

  return (
    <>
      <PageHead title="Booking" extra={
        <>
          <Popover trigger="click" placement="bottomRight" title="Cột hiển thị" content={
            <Checkbox.Group style={{ display: 'grid', gap: 4 }} value={cols}
              options={ALL_COLUMNS.map((c) => ({ value: c.key, label: c.title }))}
              onChange={(v) => { const next = v as string[]; setCols(next); writeLocal('tourhub.bookingCols', next) }} />
          }><Button icon={<SettingOutlined />}>Cột</Button></Popover>
          <Can perm="booking.export"><Button icon={<DownloadOutlined />} loading={exportCsv.isPending} onClick={() => exportCsv.mutate()}>Xuất CSV</Button></Can>
          <Can perm="booking.manage"><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>Tạo booking</Button></Can>
        </>
      } />
      <Card>
        <div className="filters">
          <Input.Search allowClear placeholder="Mã, khách, email, tour" style={{ width: 240 }} value={search}
            onChange={(e) => setSearch(e.target.value)} onSearch={(v) => setFilter('q', v.trim() || undefined)} />
          <Select allowClear mode="multiple" maxTagCount={1} placeholder="Trạng thái" style={{ minWidth: 150 }} options={statusOptions}
            value={f.status?.split(',') ?? []} onChange={(v: string[]) => setFilter('status', v.join(',') || undefined)} />
          <Select allowClear mode="multiple" maxTagCount={1} placeholder="Điều hành" style={{ minWidth: 150 }} options={opsOptions}
            value={f.ops?.split(',') ?? []} onChange={(v: string[]) => setFilter('ops', v.join(',') || undefined)} />
          <Select allowClear placeholder="Kênh / tài khoản" style={{ minWidth: 170 }} value={f.connection}
            options={(connections.data ?? []).map((c) => ({ value: c.id, label: `${CHANNEL[c.channel] ?? c.channel} · ${c.account_name}` }))}
            onChange={(v) => setFilter('connection', v)} />
          <Select allowClear showSearch optionFilterProp="label" placeholder="Tour" style={{ minWidth: 170 }} value={f.tour}
            options={(tours.data ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => setFilter('tour', v)} />
          <DatePicker.RangePicker format="DD/MM/YYYY" placeholder={['Đi từ', 'đến']} style={{ width: 240 }}
            value={f.travel_from && f.travel_to ? [dayjs(f.travel_from), dayjs(f.travel_to)] : null}
            onChange={(v) => table.patch({ filters: { travel_from: v?.[0]?.format('YYYY-MM-DD'), travel_to: v?.[1]?.format('YYYY-MM-DD') } })} />
          <DatePicker.RangePicker format="DD/MM/YYYY" placeholder={['Đặt từ', 'đến']} style={{ width: 240 }}
            value={f.booked_from && f.booked_to ? [dayjs(f.booked_from), dayjs(f.booked_to)] : null}
            onChange={(v) => table.patch({ filters: { booked_from: v?.[0]?.format('YYYY-MM-DD'), booked_to: v?.[1]?.format('YYYY-MM-DD') } })} />
          <Checkbox checked={f.action === '1'} onChange={(e) => setFilter('action', e.target.checked ? '1' : undefined)}>Cần xử lý</Checkbox>
          <Dropdown menu={{ items: [
            ...((savedFilters.data ?? []).map((s) => ({ key: s.id as string, label: s.name as string, onClick: () => table.replaceFilters(s.filters) }))),
            ...(savedFilters.data?.length ? [{ type: 'divider' as const }] : []),
            { key: '_save', icon: <SaveOutlined />, label: 'Lưu bộ lọc hiện tại', onClick: saveFilter },
          ] }}><Button>Bộ lọc đã lưu</Button></Dropdown>
          {Object.keys(f).length > 0 && <Button type="link" onClick={() => table.replaceFilters({})}>Xóa lọc</Button>}
        </div>

        {selected.length > 0 && (
          <Space wrap style={{ marginBottom: 12, padding: '8px 12px', background: '#f0fdfa', borderRadius: 6, width: '100%' }}>
            <span>Đã chọn {selected.length} booking</span>
            <Button size="small" onClick={() => bulk.mutate({ needs_action: true, action_reason: 'Đánh dấu thủ công' })}>Đánh dấu cần xử lý</Button>
            <Button size="small" onClick={() => bulk.mutate({ needs_action: false, action_reason: null })}>Bỏ đánh dấu</Button>
            {can('member.manage') && (
              <Select size="small" placeholder="Gán người phụ trách" style={{ width: 200 }}
                options={(members.data ?? []).filter((m) => m.is_active && m.role_key !== 'guide').map((m) => ({ value: m.user_id, label: m.full_name ?? m.email }))}
                onChange={(v: string) => bulk.mutate({ owner_id: v })} />
            )}
            <span className="muted">Chỉ đổi dữ liệu nội bộ, không gửi sang kênh.</span>
          </Space>
        )}

        {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : (
          <Table rowKey="id" size="middle" loading={list.isFetching && !list.data} dataSource={list.data?.rows} columns={columns} scroll={{ x: 'max-content' }}
            rowSelection={can('booking.manage') ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) } : undefined}
            locale={{ emptyText: <NoData text="Không có booking phù hợp" /> }}
            pagination={{ current: table.page, pageSize: table.pageSize, total: list.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 25, 50, 100], showTotal: (t) => `${t} booking` }}
            onChange={(p, _f, s) => {
              const sorter = Array.isArray(s) ? s[0] : s
              const nextSort = sorter?.order ? (sorter.columnKey as string) : undefined
              const key = ALL_COLUMNS.find((c) => c.key === sorter?.columnKey)?.sort
              table.patch({ page: p.current, pageSize: p.pageSize, sort: nextSort ? key : undefined, desc: sorter?.order === 'descend' })
            }} />
        )}
      </Card>
      {creating && <CreateBookingDrawer onClose={() => setCreating(false)} />}
    </>
  )
}
