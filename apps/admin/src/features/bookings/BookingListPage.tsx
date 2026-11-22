import {
  AlertOutlined, CalendarOutlined, ClockCircleOutlined, DownloadOutlined, FilterOutlined, PlusOutlined, SaveOutlined, SettingOutlined, TeamOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Avatar, Button, Card, Checkbox, DatePicker, Dropdown, Input, Modal, Popover, Select, Space, Table, Tabs, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { BOOKING_STATUS, CHANNEL, OPS_STATUS, toCsv } from '@tours/core'
import dayjs from 'dayjs'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import {
  BookingStatusTag, Can, ChannelLabel, ErrorState, fmtDateTime, MoneyText, NoData, OpsStatusTag, PageHead, SyncStatusTag,
} from '../../components/common'
import { CONNECTION_COLUMNS, friendlyError, rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'
import { downloadText, readLocal, useUrlTable, writeLocal } from '../../lib/use-url-state'
import { CreateBookingDrawer } from './CreateBookingDrawer'
import { PlaceWaitingModal } from './PlaceWaitingModal'

const WEEKDAY = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']
const today = () => dayjs().format('YYYY-MM-DD')

// Ngày đi theo giờ địa phương của tour, kèm nhãn Hôm nay / Ngày mai / Đã qua.
function TravelDate({ r }: { r: Row }) {
  if (!r.local_date) return <Tag color="orange">Chưa xếp chuyến</Tag>
  const d = dayjs(r.local_date)
  const diff = d.diff(dayjs(today()), 'day')
  const badge = r.status === 'cancelled' ? null
    : diff === 0 ? <Tag color="red">Hôm nay</Tag>
    : diff === 1 ? <Tag color="orange">Ngày mai</Tag>
      : diff < 0 ? <span className="muted" style={{ fontSize: 12 }}>Đã qua</span> : null
  return (
    <div className="nowrap">
      <div><b>{r.local_time ? String(r.local_time).slice(0, 5) : '--:--'}</b> · {WEEKDAY[d.day()]} {d.format('DD/MM/YYYY')}</div>
      {(badge || (r.timezone && r.timezone !== 'Asia/Ho_Chi_Minh')) && (
        <div style={{ marginTop: 2 }}>{badge}{r.timezone && r.timezone !== 'Asia/Ho_Chi_Minh' && <span className="muted" style={{ fontSize: 12 }}> {r.timezone}</span>}</div>
      )}
    </div>
  )
}

const ALL_COLUMNS: Array<{ key: string; title: string; sort?: string; align?: 'right'; render: (r: Row) => ReactNode }> = [
  {
    key: 'code', title: 'Booking', sort: 'code', render: (r) => (
      <div className="nowrap">
        <Link className="bk-code" to={`/bookings/${r.id}`}>{r.code}</Link>
        <div className="muted" style={{ fontSize: 12 }}>{r.external_ref ?? 'Không có mã ngoài'}</div>
      </div>
    ),
  },
  {
    key: 'lead_name', title: 'Khách', sort: 'lead_name', render: (r) => (
      <div className="nowrap">
        {r.lead_name ?? <Tag color="red">Thiếu tên khách</Tag>}
        <div className="muted" style={{ fontSize: 12 }}><TeamOutlined /> {r.pax_total ?? 0} khách</div>
      </div>
    ),
  },
  {
    key: 'tour', title: 'Tour / gói', render: (r) => r.tour_name
      ? <div className="bk-tour"><div className="bk-ellipsis" title={r.tour_name}>{r.tour_name}</div><div className="muted bk-ellipsis" style={{ fontSize: 12 }} title={r.option_name}>{r.option_name}</div></div>
      : <Tooltip title={`Mã sản phẩm trên kênh: ${r.external_product_code ?? '(trống)'}`}><Tag color="red">Chưa ghép mã</Tag></Tooltip>,
  },
  { key: 'local_date', title: 'Ngày giờ đi', sort: 'local_date', render: (r) => <TravelDate r={r} /> },
  { key: 'channel', title: 'Nguồn bán', render: (r) => <ChannelLabel channel={r.channel} account={r.account_name} mode={r.connection_mode} /> },
  {
    key: 'status', title: 'Trạng thái', sort: 'status', render: (r) => (
      <Space direction="vertical" size={2}>
        <BookingStatusTag value={r.status} />
        {!(r.status === 'cancelled' && r.ops_status === 'cancelled') && <OpsStatusTag value={r.ops_status} />}
        {r.needs_action && <Tooltip title={r.action_reason}><Tag color="red" icon={<AlertOutlined />}>Cần xử lý</Tag></Tooltip>}
      </Space>
    ),
  },
  { key: 'gross_amount', title: 'Giá trị', sort: 'gross_amount', align: 'right', render: (r) => <span className="nowrap"><MoneyText amount={r.gross_amount} currency={r.currency} /></span> },
  {
    key: 'owner_name', title: 'Phụ trách', render: (r) => r.owner_name
      ? <Tooltip title={r.owner_name}><Avatar size="small" style={{ background: '#0f766e' }}>{String(r.owner_name).trim().charAt(0).toUpperCase()}</Avatar></Tooltip>
      : <span className="muted nowrap" style={{ fontSize: 12 }}>Chưa gán</span>,
  },
  { key: 'pickup', title: 'Điểm đón', render: (r) => r.pickup_hotel ?? r.pickup_address ?? <span className="muted">Không có</span> },
  { key: 'sync_status', title: 'Đồng bộ', render: (r) => <SyncStatusTag value={r.sync_status} /> },
  { key: 'booked_at', title: 'Ngày đặt', sort: 'booked_at', render: (r) => <span className="nowrap">{fmtDateTime(r.booked_at)}</span> },
]

const DEFAULT_COLUMNS = ALL_COLUMNS.filter((c) => !['pickup', 'sync_status'].includes(c.key)).map((c) => c.key)
const SORTABLE = new Set(ALL_COLUMNS.filter((c) => c.sort).map((c) => c.sort))
const STATUS_TABS = ['', 'pending', 'confirmed', 'completed', 'cancelled', 'no_show']

// Áp bộ lọc lên truy vấn v_booking_list. skipStatus: khi đếm số cho từng tab trạng thái.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyFilters(q: any, f: Record<string, string>, skipStatus = false) {
  if (f.q) q = q.ilike('search_text', `%${f.q.toLowerCase().replace(/[%_]/g, '\\$&')}%`)
  if (f.status && !skipStatus) q = q.in('status', f.status.split(','))
  if (f.ops) q = q.in('ops_status', f.ops.split(','))
  if (f.connection) q = q.eq('connection_id', f.connection)
  if (f.tour) q = q.eq('tour_id', f.tour)
  if (f.departure) q = q.eq('departure_id', f.departure)
  if (f.travel_from) q = q.gte('local_date', f.travel_from)
  if (f.travel_to) q = q.lte('local_date', f.travel_to)
  if (f.booked_from) q = q.gte('booked_at', dayjs(f.booked_from).startOf('day').toISOString())
  if (f.booked_to) q = q.lte('booked_at', dayjs(f.booked_to).endOf('day').toISOString())
  if (f.action === '1') q = q.eq('needs_action', true)
  return q
}

function Kpi({ icon, label, value, tone, active, onClick }: { icon: ReactNode; label: string; value?: number; tone: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`bk-kpi bk-kpi-${tone}${active ? ' active' : ''}`} onClick={onClick}>
      <span className="bk-kpi-icon">{icon}</span>
      <span><span className="bk-kpi-value">{value ?? '–'}</span><span className="bk-kpi-label">{label}</span></span>
    </button>
  )
}

export function BookingListPage() {
  const { orgId, session, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const table = useUrlTable(25)
  const f = table.filters
  const [cols, setCols] = useState<string[]>(() => readLocal('tourhub.bookingCols.v2', DEFAULT_COLUMNS))
  const [search, setSearch] = useState(f.q ?? '')
  const [selected, setSelected] = useState<string[]>([])
  const [creating, setCreating] = useState(f.new === '1')
  const [placing, setPlacing] = useState(false)
  const [moreFilters, setMoreFilters] = useState(() => Boolean(f.ops || f.booked_from || f.tour))

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
      const q = applyFilters(supabase.from('v_booking_list').select('*', { count: 'exact' }).eq('organization_id', orgId), f)
      const fromIdx = (table.page - 1) * table.pageSize
      const res = await q.order(sort, { ascending: !desc, nullsFirst: false }).order('id').range(fromIdx, fromIdx + table.pageSize - 1)
      if (res.error) throw new Error(friendlyError(res.error))
      return { rows: res.data as Row[], total: res.count ?? 0 }
    },
  })

  // Số booking từng trạng thái theo các bộ lọc còn lại, hiện trên tab trạng thái.
  const countKey = JSON.stringify({ ...f, status: undefined })
  const counts = useQuery({
    queryKey: ['bookings', 'status-counts', orgId, countKey],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      const out: Record<string, number> = {}
      await Promise.all(STATUS_TABS.map(async (st) => {
        let q = applyFilters(supabase.from('v_booking_list').select('id', { count: 'exact', head: true }).eq('organization_id', orgId), f, true)
        if (st) q = q.eq('status', st)
        const res = await q
        if (res.error) throw new Error(friendlyError(res.error))
        out[st] = res.count ?? 0
      }))
      return out
    },
  })

  // Số liệu nhanh của cả doanh nghiệp, không theo bộ lọc. Bấm vào để lọc.
  const in7 = dayjs().add(6, 'day').format('YYYY-MM-DD')
  const kpis = useQuery({
    queryKey: ['bookings', 'kpis', orgId, today()],
    queryFn: async () => {
      const base = () => supabase.from('v_booking_list').select('id', { count: 'exact', head: true }).eq('organization_id', orgId)
      const live = ['pending', 'confirmed']
      const [action, pending, todayRes, week] = await Promise.all([
        base().eq('needs_action', true),
        base().eq('status', 'pending'),
        base().eq('local_date', today()).in('status', live),
        base().gte('local_date', today()).lte('local_date', in7).in('status', live),
      ])
      return { action: action.count ?? 0, pending: pending.count ?? 0, today: todayRes.count ?? 0, week: week.count ?? 0 }
    },
  })

  const setFilter = (key: string, value: string | undefined) => table.patch({ filters: { [key]: value } })
  const onlyFilters = (next: Record<string, string>) => table.replaceFilters(next)
  const isOnly = (next: Record<string, string>) => JSON.stringify(f) === JSON.stringify(next)

  const columns: ColumnsType<Row> = ALL_COLUMNS.filter((c) => cols.includes(c.key)).map((c) => ({
    title: c.title,
    key: c.key,
    align: c.align,
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
    enabled: can('booking.manage'),
    queryFn: () => rpc<Row[]>('member_assignable', { p_org: orgId }),
  })

  const opsOptions = useMemo(() => Object.entries(OPS_STATUS).map(([value, label]) => ({ value, label })), [])
  const connLabel = (id: string) => {
    const c = connections.data?.find((x) => x.id === id)
    return c ? `${CHANNEL[c.channel] ?? c.channel} · ${c.account_name}` : 'Kênh'
  }

  // Nhãn của các bộ lọc đang bật, để xem nhanh và bỏ từng cái.
  const fmt = (v?: string) => (v ? dayjs(v).format('DD/MM') : '…')
  const activeChips: { key: string; label: string; clear: Record<string, undefined> }[] = []
  if (f.q) activeChips.push({ key: 'q', label: `Tìm: ${f.q}`, clear: { q: undefined } })
  if (f.status) activeChips.push({ key: 'status', label: `Trạng thái: ${f.status.split(',').map((s) => BOOKING_STATUS[s] ?? s).join(', ')}`, clear: { status: undefined } })
  if (f.ops) activeChips.push({ key: 'ops', label: `Điều hành: ${f.ops.split(',').map((s) => OPS_STATUS[s] ?? s).join(', ')}`, clear: { ops: undefined } })
  if (f.connection) activeChips.push({ key: 'connection', label: connLabel(f.connection), clear: { connection: undefined } })
  if (f.tour) activeChips.push({ key: 'tour', label: `Tour: ${tours.data?.find((t) => t.id === f.tour)?.name ?? '…'}`, clear: { tour: undefined } })
  if (f.departure) activeChips.push({ key: 'departure', label: 'Một chuyến cụ thể', clear: { departure: undefined } })
  if (f.travel_from || f.travel_to) activeChips.push({ key: 'travel', label: f.travel_from === f.travel_to ? `Đi ngày ${fmt(f.travel_from)}` : `Đi ${fmt(f.travel_from)} – ${fmt(f.travel_to)}`, clear: { travel_from: undefined, travel_to: undefined } })
  if (f.booked_from || f.booked_to) activeChips.push({ key: 'booked', label: `Đặt ${fmt(f.booked_from)} – ${fmt(f.booked_to)}`, clear: { booked_from: undefined, booked_to: undefined } })
  if (f.action === '1') activeChips.push({ key: 'action', label: 'Cần xử lý', clear: { action: undefined } })

  const statusTab = f.status && !f.status.includes(',') ? f.status : f.status ? '_multi' : ''
  const extraCount = [f.ops, f.tour, f.booked_from].filter(Boolean).length

  return (
    <>
      <PageHead title="Booking" extra={
        <>
          <Can perm="booking.export"><Button icon={<DownloadOutlined />} loading={exportCsv.isPending} onClick={() => exportCsv.mutate()}>Xuất CSV</Button></Can>
          <Can perm="ops.manage"><Button onClick={() => setPlacing(true)}>Xếp booking đang chờ</Button></Can>
          <Can perm="booking.manage"><Button type="primary" icon={<PlusOutlined />} onClick={() => setCreating(true)}>Tạo booking</Button></Can>
        </>
      } />

      <div className="bk-kpis">
        <Kpi tone="red" icon={<AlertOutlined />} label="Cần xử lý" value={kpis.data?.action}
          active={isOnly({ action: '1' })} onClick={() => onlyFilters({ action: '1' })} />
        <Kpi tone="amber" icon={<ClockCircleOutlined />} label="Chờ xác nhận" value={kpis.data?.pending}
          active={isOnly({ status: 'pending' })} onClick={() => onlyFilters({ status: 'pending' })} />
        <Kpi tone="teal" icon={<CalendarOutlined />} label="Khởi hành hôm nay" value={kpis.data?.today}
          active={isOnly({ status: 'pending,confirmed', travel_from: today(), travel_to: today() })}
          onClick={() => onlyFilters({ status: 'pending,confirmed', travel_from: today(), travel_to: today() })} />
        <Kpi tone="blue" icon={<CalendarOutlined />} label="Khởi hành 7 ngày tới" value={kpis.data?.week}
          active={isOnly({ status: 'pending,confirmed', travel_from: today(), travel_to: in7 })}
          onClick={() => onlyFilters({ status: 'pending,confirmed', travel_from: today(), travel_to: in7 })} />
      </div>

      <Card styles={{ body: { paddingTop: 4 } }}>
        <Tabs className="bk-status-tabs" activeKey={statusTab} onChange={(k) => setFilter('status', k || undefined)} items={[
          ...STATUS_TABS.map((st) => ({
            key: st,
            label: <span>{st ? BOOKING_STATUS[st] : 'Tất cả'}<span className="bk-count">{counts.data?.[st] ?? ''}</span></span>,
          })),
          ...(statusTab === '_multi' ? [{ key: '_multi', label: 'Nhiều trạng thái' }] : []),
        ]} />

        <div className="filters">
          <Input.Search allowClear placeholder="Mã booking, tên khách, email, tour" style={{ width: 280 }} value={search}
            onChange={(e) => setSearch(e.target.value)} onSearch={(v) => setFilter('q', v.trim() || undefined)} />
          <Select allowClear placeholder="Kênh / tài khoản" style={{ minWidth: 190 }} value={f.connection}
            options={(connections.data ?? []).map((c) => ({ value: c.id, label: `${CHANNEL[c.channel] ?? c.channel} · ${c.account_name}` }))}
            onChange={(v) => setFilter('connection', v)} />
          <DatePicker.RangePicker format="DD/MM/YYYY" placeholder={['Ngày đi từ', 'đến']} style={{ width: 250 }}
            value={f.travel_from && f.travel_to ? [dayjs(f.travel_from), dayjs(f.travel_to)] : null}
            onChange={(v) => table.patch({ filters: { travel_from: v?.[0]?.format('YYYY-MM-DD'), travel_to: v?.[1]?.format('YYYY-MM-DD') } })} />
          <Button icon={<FilterOutlined />} type={moreFilters ? 'primary' : 'default'} ghost={moreFilters} onClick={() => setMoreFilters(!moreFilters)}>
            Lọc thêm{extraCount ? ` (${extraCount})` : ''}
          </Button>
          <Dropdown menu={{ items: [
            ...((savedFilters.data ?? []).map((s) => ({ key: s.id as string, label: s.name as string, onClick: () => table.replaceFilters(s.filters) }))),
            ...(savedFilters.data?.length ? [{ type: 'divider' as const }] : []),
            { key: '_save', icon: <SaveOutlined />, label: 'Lưu bộ lọc hiện tại', onClick: saveFilter },
          ] }}><Button icon={<SaveOutlined />}>Bộ lọc đã lưu</Button></Dropdown>
          <div style={{ flex: 1 }} />
          <Popover trigger="click" placement="bottomRight" title="Cột hiển thị" content={
            <Checkbox.Group style={{ display: 'grid', gap: 4 }} value={cols}
              options={ALL_COLUMNS.map((c) => ({ value: c.key, label: c.title }))}
              onChange={(v) => { const next = v as string[]; setCols(next); writeLocal('tourhub.bookingCols.v2', next) }} />
          }><Button icon={<SettingOutlined />}>Cột</Button></Popover>
        </div>

        {moreFilters && (
          <div className="filters bk-more">
            <Select allowClear mode="multiple" maxTagCount={1} placeholder="Tình trạng điều hành" style={{ minWidth: 200 }} options={opsOptions}
              value={f.ops?.split(',') ?? []} onChange={(v: string[]) => setFilter('ops', v.join(',') || undefined)} />
            <Select allowClear showSearch optionFilterProp="label" placeholder="Tour" style={{ minWidth: 220 }} value={f.tour}
              options={(tours.data ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => setFilter('tour', v)} />
            <DatePicker.RangePicker format="DD/MM/YYYY" placeholder={['Ngày đặt từ', 'đến']} style={{ width: 250 }}
              value={f.booked_from && f.booked_to ? [dayjs(f.booked_from), dayjs(f.booked_to)] : null}
              onChange={(v) => table.patch({ filters: { booked_from: v?.[0]?.format('YYYY-MM-DD'), booked_to: v?.[1]?.format('YYYY-MM-DD') } })} />
            <Checkbox checked={f.action === '1'} onChange={(e) => setFilter('action', e.target.checked ? '1' : undefined)}>Chỉ booking cần xử lý</Checkbox>
          </div>
        )}

        {activeChips.length > 0 && (
          <div className="bk-chips">
            <span className="muted">Đang lọc:</span>
            {activeChips.map((c) => <Tag key={c.key} closable onClose={(e) => { e.preventDefault(); table.patch({ filters: c.clear }) }}>{c.label}</Tag>)}
            <Button type="link" size="small" onClick={() => table.replaceFilters({})}>Xóa tất cả</Button>
          </div>
        )}

        {selected.length > 0 && (
          <div className="bk-bulk">
            <b>Đã chọn {selected.length} booking</b>
            <Button size="small" onClick={() => bulk.mutate({ needs_action: true, action_reason: 'Đánh dấu thủ công' })}>Đánh dấu cần xử lý</Button>
            <Button size="small" onClick={() => bulk.mutate({ needs_action: false, action_reason: null })}>Bỏ đánh dấu</Button>
            {can('booking.manage') && (
              <Select size="small" placeholder="Gán người phụ trách" style={{ width: 200 }}
                options={(members.data ?? []).map((m) => ({ value: m.user_id, label: m.name }))}
                onChange={(v: string) => bulk.mutate({ owner_id: v })} />
            )}
            <Button size="small" type="link" onClick={() => setSelected([])}>Bỏ chọn</Button>
            <span className="muted" style={{ marginLeft: 'auto' }}>Chỉ đổi dữ liệu nội bộ, không gửi sang kênh.</span>
          </div>
        )}

        {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : (
          <Table rowKey="id" size="middle" loading={list.isFetching && !list.data} dataSource={list.data?.rows} columns={columns} scroll={{ x: 'max-content' }}
            rowClassName={(r) => `bk-row${r.needs_action ? ' bk-row-action' : ''}${r.status === 'cancelled' ? ' bk-row-cancelled' : ''}`}
            onRow={(r) => ({
              onClick: (e) => {
                // Bấm vào dòng mở chi tiết, trừ khi bấm vào liên kết, nút hay ô chọn.
                if ((e.target as HTMLElement).closest('a,button,input,.ant-checkbox-wrapper,.ant-table-selection-column')) return
                navigate(`/bookings/${r.id}`)
              },
            })}
            rowSelection={can('booking.manage') ? { selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]) } : undefined}
            locale={{ emptyText: <NoData text="Không có booking phù hợp" action={activeChips.length ? <Button onClick={() => table.replaceFilters({})}>Xóa bộ lọc</Button> : undefined} /> }}
            pagination={{ current: table.page, pageSize: table.pageSize, total: list.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 25, 50, 100], showTotal: (t, [a, b]) => `${a}–${b} / ${t} booking` }}
            onChange={(p, _f, s) => {
              const sorter = Array.isArray(s) ? s[0] : s
              const nextSort = sorter?.order ? (sorter.columnKey as string) : undefined
              const key = ALL_COLUMNS.find((c) => c.key === sorter?.columnKey)?.sort
              table.patch({ page: p.current, pageSize: p.pageSize, sort: nextSort ? key : undefined, desc: sorter?.order === 'descend' })
            }} />
        )}
      </Card>
      {creating && <CreateBookingDrawer onClose={() => setCreating(false)} />}
      {placing && <PlaceWaitingModal onClose={() => setPlacing(false)} />}
    </>
  )
}
