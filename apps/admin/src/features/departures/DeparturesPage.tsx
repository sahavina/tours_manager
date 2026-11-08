import { PlusOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Calendar, Card, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Segmented, Select, Space, Switch, Table, Tag, TimePicker } from 'antd'
import dayjs from 'dayjs'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { Can, ErrorState, LocalTime, NoData, PageHead } from '../../components/common'
import { rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'
import { useUrlTable } from '../../lib/use-url-state'
import { BookingMix, MIX_FILTERS, MIX_OPTIONS, mixText, SlotTag } from './BookingMix'

const WEEKDAYS = [
  { value: 1, label: 'T2' }, { value: 2, label: 'T3' }, { value: 3, label: 'T4' }, { value: 4, label: 'T5' },
  { value: 5, label: 'T6' }, { value: 6, label: 'T7' }, { value: 7, label: 'CN' },
]

function useCatalog() {
  const { orgId } = useAuth()
  return useQuery({
    queryKey: ['catalog-tree', orgId],
    queryFn: async () => unwrap(await supabase.from('tours').select('id, name, code, default_timezone, tour_options(id, name, code, deleted_at, default_capacity)')
      .eq('organization_id', orgId).is('deleted_at', null).order('name')) as unknown as Row[],
  })
}

function GenerateModal({ onClose }: { onClose: () => void }) {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const catalog = useCatalog()
  const [form] = Form.useForm()
  const tourId = Form.useWatch('tour_id', form)
  const tour = catalog.data?.find((t) => t.id === tourId)
  const [preview, setPreview] = useState<Row | null>(null)

  const call = (v: Row, dry: boolean) => rpcOk('generate_departures', {
    p_org: orgId, p_tour: v.tour_id, p_option: v.option_id ?? null,
    p_from: v.range[0].format('YYYY-MM-DD'), p_to: v.range[1].format('YYYY-MM-DD'),
    p_weekdays: v.weekdays, p_times: (v.times as dayjs.Dayjs[]).map((t) => t.format('HH:mm')),
    p_timezone: v.timezone, p_capacity: v.capacity, p_dry_run: dry,
  })
  const previewMut = useMutation({
    mutationFn: async () => call(await form.validateFields(), true),
    onSuccess: setPreview,
    onError: (e: Error) => { if (e.message) message.error(e.message) },
  })
  const createMut = useMutation({
    mutationFn: async () => call(await form.validateFields(), false),
    onSuccess: (r) => {
      message.success(`Đã tạo ${r.created} chuyến, bỏ qua ${r.skipped} chuyến đã có`)
      qc.invalidateQueries({ queryKey: ['departures'] })
      onClose()
    },
    onError: (e: Error) => { if (e.message) message.error(e.message) },
  })

  return (
    <Modal title="Tạo chuyến lặp" open onCancel={onClose} width={640} footer={[
      <Button key="c" onClick={onClose}>Đóng</Button>,
      <Button key="p" loading={previewMut.isPending} onClick={() => previewMut.mutate()}>Xem trước</Button>,
      <Button key="s" type="primary" disabled={!preview || preview.created === 0} loading={createMut.isPending} onClick={() => createMut.mutate()}>Tạo {preview ? `${preview.created} chuyến` : ''}</Button>,
    ]}>
      <Form form={form} layout="vertical" onValuesChange={() => setPreview(null)} initialValues={{ weekdays: [1, 2, 3, 4, 5, 6, 7], capacity: 16, range: [dayjs(), dayjs().add(30, 'day')], times: [dayjs('08:00', 'HH:mm')] }}>
        <Form.Item name="tour_id" label="Tour" rules={[{ required: true, message: 'Chọn tour' }]}>
          <Select showSearch optionFilterProp="label" options={(catalog.data ?? []).map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }))}
            onChange={(id) => { form.setFieldsValue({ timezone: catalog.data?.find((t) => t.id === id)?.default_timezone, option_id: undefined }) }} />
        </Form.Item>
        <Form.Item name="option_id" label="Gói (bỏ trống nếu dùng chung cho mọi gói của tour)">
          <Select allowClear options={(tour?.tour_options ?? []).filter((o: Row) => !o.deleted_at).map((o: Row) => ({ value: o.id, label: o.name }))}
            onChange={(id) => { const cap = tour?.tour_options?.find((o: Row) => o.id === id)?.default_capacity; if (cap) form.setFieldsValue({ capacity: cap }) }} />
        </Form.Item>
        <Form.Item name="range" label="Khoảng ngày" rules={[{ required: true }]}><DatePicker.RangePicker format="DD/MM/YYYY" style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="weekdays" label="Thứ trong tuần" rules={[{ required: true, message: 'Chọn ít nhất một thứ' }]}><Checkbox.Group options={WEEKDAYS} /></Form.Item>
        <Form.Item name="times" label="Giờ chạy (giờ địa phương)" rules={[{ required: true, message: 'Chọn giờ' }]}>
          <TimesInput />
        </Form.Item>
        <Space>
          <Form.Item name="timezone" label="Múi giờ" rules={[{ required: true }]}><Input style={{ width: 200 }} /></Form.Item>
          <Form.Item name="capacity" label="Sức chứa mỗi chuyến" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item>
        </Space>
      </Form>
      {preview && (
        <Alert type={preview.created > 0 ? 'info' : 'warning'} showIcon
          message={`Sẽ tạo ${preview.created} chuyến; ${preview.skipped} chuyến đã có sẽ được bỏ qua.`}
          description={(preview.rows as Row[]).slice(0, 8).map((r) => `${dayjs(r.date).format('DD/MM')} ${String(r.time).slice(0, 5)}${r.exists ? ' (đã có)' : ''}`).join(', ') + ((preview.rows as Row[]).length > 8 ? '...' : '')} />
      )}
    </Modal>
  )
}

function TimesInput({ value = [], onChange }: { value?: dayjs.Dayjs[]; onChange?: (v: dayjs.Dayjs[]) => void }) {
  return (
    <Space wrap>
      {value.map((t, i) => (
        <TimePicker key={i} format="HH:mm" minuteStep={5} value={t} allowClear={value.length > 1}
          onChange={(v) => onChange?.(v ? value.map((x, j) => (j === i ? v : x)) : value.filter((_, j) => j !== i))} />
      ))}
      <Button size="small" onClick={() => onChange?.([...value, dayjs('13:00', 'HH:mm')])}>Thêm giờ</Button>
    </Space>
  )
}

function SingleModal({ onClose }: { onClose: () => void }) {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const catalog = useCatalog()
  const [form] = Form.useForm()
  const tourId = Form.useWatch('tour_id', form)
  const tour = catalog.data?.find((t) => t.id === tourId)
  const create = useMutation({
    mutationFn: (v: Row) => rpcOk('create_departure', {
      p_org: orgId, p_tour: v.tour_id, p_option: v.option_id ?? null, p_date: v.date.format('YYYY-MM-DD'),
      p_time: v.time.format('HH:mm'), p_timezone: v.timezone, p_capacity: v.capacity, p_pool: null,
    }),
    onSuccess: () => { message.success('Đã tạo chuyến'); qc.invalidateQueries({ queryKey: ['departures'] }); onClose() },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <Modal title="Tạo chuyến" open onCancel={onClose} onOk={() => form.submit()} okText="Tạo" cancelText="Đóng" confirmLoading={create.isPending}>
      <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)} initialValues={{ capacity: 16, time: dayjs('08:00', 'HH:mm') }}>
        <Form.Item name="tour_id" label="Tour" rules={[{ required: true, message: 'Chọn tour' }]}>
          <Select showSearch optionFilterProp="label" options={(catalog.data ?? []).map((t) => ({ value: t.id, label: `${t.code} · ${t.name}` }))}
            onChange={(id) => form.setFieldsValue({ timezone: catalog.data?.find((t) => t.id === id)?.default_timezone, option_id: undefined })} />
        </Form.Item>
        <Form.Item name="option_id" label="Gói"><Select allowClear options={(tour?.tour_options ?? []).filter((o: Row) => !o.deleted_at).map((o: Row) => ({ value: o.id, label: o.name }))}
          onChange={(id) => { const cap = tour?.tour_options?.find((o: Row) => o.id === id)?.default_capacity; if (cap) form.setFieldsValue({ capacity: cap }) }} /></Form.Item>
        <Space wrap>
          <Form.Item name="date" label="Ngày" rules={[{ required: true, message: 'Chọn ngày' }]}><DatePicker format="DD/MM/YYYY" /></Form.Item>
          <Form.Item name="time" label="Giờ" rules={[{ required: true }]}><TimePicker format="HH:mm" minuteStep={5} /></Form.Item>
          <Form.Item name="capacity" label="Sức chứa" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item>
        </Space>
        <Form.Item name="timezone" label="Múi giờ" rules={[{ required: true, message: 'Nhập múi giờ' }]}><Input placeholder="Asia/Ho_Chi_Minh" /></Form.Item>
      </Form>
    </Modal>
  )
}

export function DeparturesPage() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const nav = useNavigate()
  const table = useUrlTable(50)
  const f = table.filters
  const view = f.view === 'list' ? 'list' : 'calendar'
  const [month, setMonth] = useState(() => (f.from ? dayjs(f.from) : dayjs()))
  const [modal, setModal] = useState<'single' | 'generate' | null>(null)
  const catalog = useCatalog()

  const from = view === 'calendar' ? month.startOf('month').subtract(7, 'day').format('YYYY-MM-DD') : (f.from ?? dayjs().format('YYYY-MM-DD'))
  const to = view === 'calendar' ? month.endOf('month').add(7, 'day').format('YYYY-MM-DD') : (f.to ?? dayjs().add(30, 'day').format('YYYY-MM-DD'))

  const list = useQuery({
    queryKey: ['departures', orgId, from, to, f.tour],
    queryFn: async () => {
      let q = supabase.from('v_departure_availability').select('*').eq('organization_id', orgId).gte('local_date', from).lte('local_date', to)
      if (f.tour) q = q.eq('tour_id', f.tour)
      return unwrap(await q.order('starts_at').order('slot_no').limit(1000)) as Row[]
    },
  })

  const toggleSale = useMutation({
    mutationFn: ({ id, open }: { id: string; open: boolean }) => rpcOk('set_departure_sale', { p_departure: id, p_open: open }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['departures'] }),
    onError: (e: Error) => message.error(e.message),
  })

  const mixFilter = f.mix ? MIX_FILTERS[f.mix] : undefined
  const rows = (list.data ?? []).filter((d) => !mixFilter || mixFilter.test(d.booking_count, d.channel_mix, d.is_private))
  const byDay = new Map<string, Row[]>()
  for (const d of rows) byDay.set(d.local_date, [...(byDay.get(d.local_date) ?? []), d])

  return (
    <>
      <PageHead title="Lịch khởi hành" extra={
        <>
          <Segmented value={view} options={[{ value: 'calendar', label: 'Lịch' }, { value: 'list', label: 'Danh sách' }]}
            onChange={(v) => table.patch({ filters: { view: v === 'list' ? 'list' : undefined } })} />
          <Can perm="departure.manage">
            <Button icon={<PlusOutlined />} onClick={() => setModal('single')}>Tạo chuyến</Button>
            <Button type="primary" icon={<ThunderboltOutlined />} onClick={() => setModal('generate')}>Tạo chuyến lặp</Button>
          </Can>
        </>
      } />
      <Card>
        <div className="filters">
          <Select allowClear showSearch optionFilterProp="label" placeholder="Tất cả tour" style={{ minWidth: 220 }} value={f.tour}
            options={(catalog.data ?? []).map((t) => ({ value: t.id, label: t.name }))} onChange={(v) => table.patch({ filters: { tour: v } })} />
          <Select allowClear placeholder="Mọi kiểu ghép" style={{ minWidth: 190 }} value={f.mix} options={MIX_OPTIONS}
            onChange={(v) => table.patch({ filters: { mix: v } })} />
          {view === 'list' && (
            <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={[dayjs(from), dayjs(to)]}
              onChange={(v) => table.patch({ filters: { from: v?.[0]?.format('YYYY-MM-DD'), to: v?.[1]?.format('YYYY-MM-DD') } })} />
          )}
        </div>
        {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : view === 'calendar' ? (
          <Calendar className="trip-calendar" value={month} onPanelChange={(d) => setMonth(d)} onSelect={(d, info) => {
            if (info.source === 'date') table.patch({ filters: { view: 'list', from: d.format('YYYY-MM-DD'), to: d.format('YYYY-MM-DD') } })
            else setMonth(d)
          }} cellRender={(date, info) => {
            if (info.type !== 'date') return info.originNode
            // Chuyến có khách lên trước: ô lịch chỉ đủ chỗ cho vài chuyến, đừng để chuyến trống che mất chúng.
            const rows = [...(byDay.get(date.format('YYYY-MM-DD')) ?? [])].sort((a, b) => b.departure_seats - a.departure_seats)
            return (
              <div className="cal-cell">
                {rows.slice(0, 3).map((d) => {
                  const cls = d.available_seats <= 0 ? 'full' : d.departure_seats > 0 && (d.guide_count === 0 || d.vehicle_count === 0) ? 'warn' : 'ok'
                  const title = [d.tour_name, d.option_name ?? 'Mọi gói', d.is_private && d.booking_count > 0 ? 'Tour riêng' : `còn ${d.available_seats}`, mixText(d.channel_mix)].filter(Boolean).join(' · ')
                  return (
                    <span key={d.id} className={`cal-chip ${cls}`} title={title}>
                      {String(d.local_time).slice(0, 5)}{d.slot_no > 1 && ` #${d.slot_no}`} · {d.committed_seats}/{d.capacity}{d.channel_mix.length >= 2 && ` · ${d.channel_mix.length} kênh`}
                      <span className="cal-chip-sub">{d.option_name ?? d.tour_code}</span>
                    </span>
                  )
                })}
                {rows.length > 3 && <span className="muted">+{rows.length - 3} chuyến</span>}
              </div>
            )
          }} />
        ) : (
          <Table rowKey="id" size="middle" loading={list.isLoading} dataSource={rows} scroll={{ x: 'max-content' }}
            pagination={{ pageSize: 50, hideOnSinglePage: true }} locale={{ emptyText: <NoData text="Chưa có chuyến trong khoảng này" /> }}
            onRow={(r) => ({ onDoubleClick: () => nav(`/operations/${r.id}`) })}
            columns={[
              { title: 'Ngày giờ', render: (_, d) => <><Link to={`/operations/${d.id}`}><LocalTime date={d.local_date} time={d.local_time} tz={d.timezone} /></Link><SlotTag slot={d.slot_no} /></> },
              { title: 'Tour', render: (_, d) => <>{d.tour_name}<div className="muted" style={{ fontSize: 12 }}>{d.option_name ?? 'Mọi gói'}</div></> },
              { title: 'Booking / kênh', render: (_, d) => <BookingMix bookings={d.booking_count} mix={d.channel_mix} isPrivate={d.is_private} /> },
              { title: 'Sức chứa', dataIndex: 'capacity', align: 'right' },
              { title: 'Đã xác nhận', dataIndex: 'committed_seats', align: 'right' },
              { title: 'Đang giữ', dataIndex: 'held_seats', align: 'right' },
              { title: 'Chặn', dataIndex: 'blocked_seats', align: 'right' },
              { title: 'Còn bán', dataIndex: 'available_seats', align: 'right', render: (v, d) => d.is_private && d.booking_count > 0 ? <Tag>Riêng</Tag> : <b style={{ color: v <= 0 ? '#b91c1c' : undefined }}>{v}</b> },
              { title: 'Mở bán', render: (_, d) => <Switch size="small" checked={d.sale_open} disabled={!can('departure.manage')} loading={toggleSale.isPending} onChange={(open) => toggleSale.mutate({ id: d.id, open })} /> },
              { title: 'HDV / xe', render: (_, d) => d.departure_seats === 0 ? <span className="muted">Chưa có khách</span> : <Space size={4}>
                {d.guide_count > 0 ? <Tag color="green">HDV {d.guide_count}</Tag> : <Tag color="orange">Thiếu HDV</Tag>}
                {d.vehicle_count > 0 ? <Tag color="green">Xe {d.vehicle_count}</Tag> : <Tag color="orange">Thiếu xe</Tag>}
              </Space> },
              { title: 'Trạng thái', render: (_, d) => d.status === 'completed' ? <Tag color="blue">Đã chạy</Tag> : d.status === 'cancelled' ? <Tag color="red">Đã hủy</Tag> : <Tag>Sắp chạy</Tag> },
            ]} />
        )}
      </Card>
      {modal === 'generate' && <GenerateModal onClose={() => setModal(null)} />}
      {modal === 'single' && <SingleModal onClose={() => setModal(null)} />}
    </>
  )
}
