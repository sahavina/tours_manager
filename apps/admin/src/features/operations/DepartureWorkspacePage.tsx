import { ArrowDownOutlined, ArrowUpOutlined, DownloadOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Col, Descriptions, Form, Input, InputNumber, List, Modal, Row as GridRow, Select, Space, Switch, Table, Tabs, Tag, Typography } from 'antd'
import { ATTENDANCE, CHANNEL, formatPax, toCsv } from '@tours/core'
import dayjs from 'dayjs'
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { Can, ChannelLabel, ErrorState, fmtDateTime, Loading, LocalTime, MoneyText, NoData, PageHead } from '../../components/common'
import { friendlyError, rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'
import { downloadText } from '../../lib/use-url-state'
import { BookingMix, isPrivateConflict } from '../departures/BookingMix'
import { PickupDiagram } from './PickupDiagram'

export function DepartureWorkspacePage() {
  const { id = '' } = useParams()
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [capOpen, setCapOpen] = useState(false)
  const [capForm] = Form.useForm()

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['departure', id] })
    qc.invalidateQueries({ queryKey: ['departures'] })
    qc.invalidateQueries({ queryKey: ['ops-board'] })
  }

  const dep = useQuery({
    queryKey: ['departure', id, 'main'],
    queryFn: async () => unwrap(await supabase.from('v_departure_availability').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle()) as Row | null,
  })
  const manifest = useQuery({
    queryKey: ['departure', id, 'manifest'],
    queryFn: () => rpc<Row[]>('departure_manifest', { p_departure: id }),
  })

  const sale = useMutation({
    mutationFn: (open: boolean) => rpcOk('set_departure_sale', { p_departure: id, p_open: open }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  })
  const capacity = useMutation({
    mutationFn: (v: Row) => rpcOk('update_pool_capacity', { p_pool: dep.data!.inventory_pool_id, p_capacity: v.capacity, p_blocked: v.blocked_seats ?? 0 }),
    onSuccess: () => { message.success('Đã đổi sức chứa'); setCapOpen(false); invalidate() },
    onError: (e: Error) => message.error(e.message),
  })
  const complete = useMutation({
    mutationFn: (outcome: string) => rpcOk('complete_departure', { p_departure: id, p_outcome: outcome }),
    onSuccess: () => { message.success('Đã đóng chuyến'); invalidate() },
    onError: (e: Error) => message.error(e.message),
  })
  const supplier = useMutation({
    mutationFn: (v: boolean) => rpcOk('set_supplier_confirmed', { p_departure: id, p_value: v }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  })

  if (dep.isLoading) return <Loading />
  if (dep.isError) return <ErrorState error={dep.error} onRetry={() => dep.refetch()} />
  const d = dep.data
  if (!d) return <NoData text="Không tìm thấy chuyến" />

  const active = (manifest.data ?? []).filter((m) => m.presence === 'active')
  const exportList = () => {
    downloadText(`danh-sach-${d.local_date}-${d.tour_code}.csv`, toCsv(active.map((m) => ({
      'Mã booking': m.code, 'Nguồn bán': m.channel ? (CHANNEL[m.channel] ?? m.channel) : 'Nội bộ', 'Mã kênh': m.external_ref, 'Khách đại diện': m.lead_name, 'Điện thoại': m.lead_phone, 'Số khách': m.pax_total,
      'Khách sạn': m.hotel_name, 'Địa chỉ': m.address, 'Giờ đón': m.pickup_local_time ? String(m.pickup_local_time).slice(0, 5) : '',
      'Xe': m.vehicle_name, 'Yêu cầu đặc biệt': m.special_requests, 'Ghi chú điều hành': m.ops_note,
    }))))
  }
  const finish = () => {
    let outcome = ''
    Modal.confirm({
      title: 'Đóng chuyến đã chạy xong?',
      content: <Input.TextArea placeholder="Kết quả chuyến" onChange={(e) => (outcome = e.target.value)} />,
      okText: 'Đóng chuyến', cancelText: 'Hủy',
      onOk: () => complete.mutateAsync(outcome),
    })
  }

  const tab = params.get('tab') ?? 'pax'
  const paxTotal = active.reduce((s, m) => s + (m.pax_total as number), 0)
  return (
    <>
      <PageHead title={<Space wrap>{d.tour_name}<LocalTime date={d.local_date} time={d.local_time} tz={d.timezone} /></Space>} extra={
        <>
          <Button icon={<DownloadOutlined />} onClick={exportList} disabled={active.length === 0}>Xuất danh sách</Button>
          {d.status === 'scheduled' && can('ops.manage') && <Button onClick={finish}>Đóng chuyến</Button>}
        </>
      } />
      {isPrivateConflict(d.is_private, d.booking_count) && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message={`Tour riêng đang có ${d.booking_count} booking trên cùng một chuyến`}
          description="Hệ thống chỉ cảnh báo, không tự tách. Nếu đây là các nhóm riêng, hãy chuyển bớt booking sang chuyến khác." />
      )}
      <Card style={{ marginBottom: 16 }}>
        <Descriptions size="small" column={{ xs: 2, md: 4 }}>
          <Descriptions.Item label="Gói">{d.option_name ?? 'Mọi gói'}</Descriptions.Item>
          <Descriptions.Item label="Booking / kênh"><div><BookingMix bookings={d.booking_count} mix={d.channel_mix} isPrivate={d.is_private} /></div></Descriptions.Item>
          <Descriptions.Item label="Sức chứa">
            <Space size={4}>{d.capacity}{d.blocked_seats > 0 && <span className="muted">(chặn {d.blocked_seats})</span>}
              <Can perm="departure.manage"><Button type="link" size="small" onClick={() => { capForm.setFieldsValue({ capacity: d.capacity, blocked_seats: d.blocked_seats }); setCapOpen(true) }}>Đổi</Button></Can>
            </Space>
          </Descriptions.Item>
          <Descriptions.Item label="Đã xác nhận">{d.committed_seats}</Descriptions.Item>
          <Descriptions.Item label="Đang giữ">{d.held_seats}</Descriptions.Item>
          <Descriptions.Item label="Còn bán">{d.is_private && d.booking_count > 0 ? <Tag>Riêng</Tag> : <b style={{ color: d.available_seats <= 0 ? '#b91c1c' : undefined }}>{d.available_seats}</b>}</Descriptions.Item>
          <Descriptions.Item label="Mở bán"><Switch size="small" checked={d.sale_open} disabled={!can('departure.manage')} onChange={(v) => sale.mutate(v)} /></Descriptions.Item>
          <Descriptions.Item label="Hạn nhận khách">{fmtDateTime(d.cutoff_at)}</Descriptions.Item>
          <Descriptions.Item label="Nhà cung cấp"><Switch size="small" checked={Boolean(d.supplier_confirmed_at)} disabled={!can('ops.manage')} checkedChildren="Đã xác nhận" unCheckedChildren="Chưa" onChange={(v) => supplier.mutate(v)} /></Descriptions.Item>
          {d.outcome && <Descriptions.Item label="Kết quả">{d.outcome}</Descriptions.Item>}
        </Descriptions>
      </Card>

      <GridRow gutter={[16, 16]}>
        {/* Không có ops.read thì RLS trả rỗng: hiện "Chưa phân công" sẽ là thông tin sai, nên ẩn hẳn khối này. */}
        {can('ops.read') && <Col xs={24} xl={8}><Assignments departure={id} onChange={invalidate} /></Col>}
        <Col xs={24} xl={can('ops.read') ? 16 : 24}>
          <Card>
            <Tabs activeKey={tab} onChange={(k) => setParams(k === 'pax' ? {} : { tab: k }, { replace: true })} items={[
              { key: 'pax', label: `Khách (${paxTotal}) · ${active.length} booking`, children: <Manifest departure={id} rows={manifest.data} loading={manifest.isLoading} error={manifest.error} /> },
              { key: 'pickup', label: 'Sơ đồ đón', children: <PickupDiagram departure={id} rows={manifest.data} departureTime={d.local_time} loading={manifest.isLoading} error={manifest.error} /> },
              // RLS trả rỗng khi thiếu ops.read: "Chưa có sự cố" sẽ là thông tin sai, nên ẩn hẳn tab.
              ...(can('ops.read') ? [{ key: 'incidents', label: 'Sự cố', children: <Incidents departure={id} /> }] : []),
              ...(can('finance.read') ? [{ key: 'costs', label: 'Chi phí', children: <Costs departure={id} /> }] : []),
            ]} />
          </Card>
        </Col>
      </GridRow>

      <Modal title="Đổi sức chứa" open={capOpen} onCancel={() => setCapOpen(false)} onOk={() => capForm.submit()} okText="Lưu" cancelText="Hủy" confirmLoading={capacity.isPending}>
        <p className="muted">Không giảm được dưới lượng đã cam kết ({d.committed_seats} đã xác nhận + {d.held_seats} đang giữ). Sức chứa áp dụng cho nguồn chỗ, kể cả chuyến dùng chung.</p>
        <Form form={capForm} layout="inline" onFinish={(v) => capacity.mutate(v)}>
          <Form.Item name="capacity" label="Sức chứa" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item>
          <Form.Item name="blocked_seats" label="Chỗ chặn vận hành"><InputNumber min={0} /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}

function Assignments({ departure, onChange }: { departure: string; onChange: () => void }) {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const q = useQuery({
    queryKey: ['departure', departure, 'assignments'],
    queryFn: async () => {
      const [g, v] = await Promise.all([
        supabase.from('guide_assignments').select('id, guide_id, role, notified_at, confirmed_at, guides(full_name, phone)').eq('departure_id', departure),
        supabase.from('vehicle_assignments').select('id, vehicle_id, driver_name, driver_phone, notified_at, confirmed_at, vehicles(name, plate, seats)').eq('departure_id', departure),
      ])
      return { guides: unwrap(g) as unknown as Row[], vehicles: unwrap(v) as unknown as Row[] }
    },
  })
  const resources = useQuery({
    queryKey: ['resources-lite', orgId],
    enabled: can('resource.read'),
    queryFn: async () => {
      const [g, v] = await Promise.all([
        supabase.from('guides').select('id, full_name, languages').eq('organization_id', orgId).is('deleted_at', null).eq('is_active', true).order('full_name'),
        supabase.from('vehicles').select('id, name, plate, seats').eq('organization_id', orgId).is('deleted_at', null).eq('is_active', true).order('name'),
      ])
      return { guides: unwrap(g) as Row[], vehicles: unwrap(v) as Row[] }
    },
  })
  const clashes = useQuery({
    queryKey: ['departure', departure, 'conflicts'],
    queryFn: () => rpc<Row[]>('assignment_conflicts', { p_departure: departure }),
  })
  const clashesOf = (kind: string, resource?: string) => (clashes.data ?? []).filter((c) => c.kind === kind && c.resource_id === resource)
  const clashText = (c: Row) => `${dayjs(c.local_date).format('DD/MM')} ${String(c.local_time).slice(0, 5)} ${c.option_name ?? c.tour_name}`
  // Cảnh báo ngay trên từng người và xe trong danh sách chọn, để biết trước khi gán.
  const optionSuffix = (kind: string, resource: string) => {
    const list = clashesOf(kind, resource)
    if (!list.length) return ''
    return list.some((c) => c.level === 'overlap') ? ' · trùng lịch' : ' · có thể trùng lịch'
  }
  const clashTags = (kind: string, resource?: string) => clashesOf(kind, resource).map((c) => (
    <div key={c.departure_id} style={{ marginTop: 4 }}>
      <Link to={`/operations/${c.departure_id}`}>
        <Tag color={c.level === 'overlap' ? 'red' : 'gold'} style={{ whiteSpace: 'normal' }}>
          {c.level === 'overlap' ? 'Trùng lịch' : 'Có thể trùng lịch'}: {clashText(c)}
        </Tag>
      </Link>
    </div>
  ))
  const act = useMutation({
    mutationFn: ({ fn, args }: { fn: string; args: Row }) => rpcOk(fn, args),
    onSuccess: onChange,
    onError: (e: Error) => message.error(e.message),
  })
  const manage = can('ops.manage')
  const ack = (kind: string, a: Row, field: 'notified' | 'confirmed') => (
    <Button size="small" type={a[`${field}_at`] ? 'primary' : 'default'} ghost={Boolean(a[`${field}_at`])} disabled={!manage}
      onClick={() => act.mutate({ fn: 'set_assignment_ack', args: { p_kind: kind, p_id: a.id, p_field: field, p_value: !a[`${field}_at`] } })}>
      {field === 'notified' ? 'Đã báo' : 'Đã xác nhận'}
    </Button>
  )
  return (
    <>
      <Card size="small" title="Hướng dẫn viên" style={{ marginBottom: 16 }}>
        <List size="small" loading={q.isLoading} dataSource={q.data?.guides ?? []} locale={{ emptyText: <Tag color="orange">Chưa phân công</Tag> }} renderItem={(a) => (
          <List.Item>
            <div style={{ width: '100%' }}>
              <div><b>{a.guides?.full_name}</b> <span className="muted">{a.guides?.phone}</span></div>
              {clashTags('guide', a.guide_id)}
              <Space size={4} style={{ marginTop: 4 }} wrap>
                {ack('guide', a, 'notified')}{ack('guide', a, 'confirmed')}
                {manage && <Button size="small" danger type="text" onClick={() => act.mutate({ fn: 'unassign_guide', args: { p_assignment: a.id } })}>Gỡ</Button>}
              </Space>
            </div>
          </List.Item>
        )} />
        {manage && <Select style={{ width: '100%', marginTop: 8 }} placeholder="Thêm hướng dẫn viên" value={null as unknown as string} showSearch optionFilterProp="label"
          options={(resources.data?.guides ?? []).map((g) => ({ value: g.id, label: `${g.full_name}${g.languages?.length ? ` (${g.languages.join(', ')})` : ''}${optionSuffix('guide', g.id)}` }))}
          onChange={(v: string) => act.mutate({ fn: 'assign_guide', args: { p_departure: departure, p_guide: v, p_role: 'lead' } })} />}
      </Card>
      <Card size="small" title="Xe và tài xế">
        <List size="small" loading={q.isLoading} dataSource={q.data?.vehicles ?? []} locale={{ emptyText: <Tag color="orange">Chưa phân công</Tag> }} renderItem={(a) => (
          <List.Item>
            <div style={{ width: '100%' }}>
              <div><b>{a.vehicles?.name}</b> {a.vehicles?.plate} · {a.vehicles?.seats} chỗ</div>
              <div className="muted">{a.driver_name} {a.driver_phone}</div>
              {clashTags('vehicle', a.vehicle_id)}
              <Space size={4} style={{ marginTop: 4 }} wrap>
                {ack('vehicle', a, 'notified')}{ack('vehicle', a, 'confirmed')}
                {manage && <Button size="small" danger type="text" onClick={() => act.mutate({ fn: 'unassign_vehicle', args: { p_assignment: a.id } })}>Gỡ</Button>}
              </Space>
            </div>
          </List.Item>
        )} />
        {manage && <Select style={{ width: '100%', marginTop: 8 }} placeholder="Thêm xe" value={null as unknown as string} showSearch optionFilterProp="label"
          options={(resources.data?.vehicles ?? []).map((v) => ({ value: v.id, label: `${v.name} ${v.plate ?? ''} · ${v.seats} chỗ${optionSuffix('vehicle', v.id)}` }))}
          onChange={(v: string) => act.mutate({ fn: 'assign_vehicle', args: { p_departure: departure, p_vehicle: v } })} />}
      </Card>
    </>
  )
}

function Manifest({ departure, rows, loading, error }: { departure: string; rows?: Row[]; loading: boolean; error: unknown }) {
  const { can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [pickupFor, setPickupFor] = useState<Row | null>(null)
  const [form] = Form.useForm()
  const manage = can('ops.manage')

  const vehicles = useQuery({
    queryKey: ['departure', departure, 'assignments-lite'],
    queryFn: async () => unwrap(await supabase.from('vehicle_assignments').select('id, vehicles(name, seats)').eq('departure_id', departure)) as unknown as Row[],
  })
  const act = useMutation({
    mutationFn: ({ fn, args }: { fn: string; args: Row }) => rpcOk(fn, args),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['departure', departure] })
      qc.invalidateQueries({ queryKey: ['ops-board'] })
    },
    onError: (e: Error) => message.error(e.message),
  })
  const savePickup = useMutation({
    mutationFn: (v: Row) => rpcOk('set_pickup', { p_item: pickupFor!.item_id, p_patch: {
      hotel_name: v.hotel_name, address: v.address, pickup_local_time: v.pickup_local_time || null, ops_note: v.ops_note,
    } }),
    onSuccess: () => { setPickupFor(null); message.success('Đã lưu'); qc.invalidateQueries({ queryKey: ['departure', departure] }) },
    onError: (e: Error) => message.error(e.message),
  })

  if (error) return <ErrorState error={error} />
  if (loading) return <Loading />
  const list = rows ?? []
  if (list.length === 0) return <NoData text="Chuyến chưa có khách" />

  const active = list.filter((r) => r.presence === 'active')
  const move = (index: number, delta: number) => {
    const ids = active.map((r) => r.item_id as string)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target]!, ids[index]!]
    act.mutate({ fn: 'reorder_pickups', args: { p_departure: departure, p_items: ids } })
  }
  const usedByVehicle = (assignment: string) => active.filter((r) => r.vehicle_assignment_id === assignment).reduce((s, r) => s + (r.committed_seats as number), 0)

  return (
    <>
      <Space wrap style={{ marginBottom: 8 }}>
        {(vehicles.data ?? []).map((v) => <Tag key={v.id} color={usedByVehicle(v.id) > v.vehicles?.seats ? 'red' : 'cyan'}>{v.vehicles?.name}: {usedByVehicle(v.id)}/{v.vehicles?.seats}</Tag>)}
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Thứ tự điểm đón do điều hành sắp xếp thủ công. Hệ thống chưa tích hợp dịch vụ bản đồ nên không tự tối ưu tuyến." />
      <Table rowKey="item_id" size="small" dataSource={list} pagination={false} scroll={{ x: 'max-content' }}
        rowClassName={(r) => (r.presence === 'active' ? '' : 'pax-row inactive')}
        columns={[
          ...(manage ? [{ title: '', width: 70, render: (_: unknown, r: Row) => {
            const i = active.indexOf(r)
            return i < 0 ? null : <Space size={0}>
              <Button size="small" type="text" icon={<ArrowUpOutlined />} disabled={i === 0} aria-label="Lên" onClick={() => move(i, -1)} />
              <Button size="small" type="text" icon={<ArrowDownOutlined />} disabled={i === active.length - 1} aria-label="Xuống" onClick={() => move(i, 1)} />
            </Space>
          } }] : []),
          { title: 'Booking', render: (_, r) => <><Link to={`/bookings/${r.booking_id}`}>{r.code}</Link>
            {r.presence === 'moved' && <Tag color="orange" style={{ marginLeft: 4 }}>Đã chuyển chuyến</Tag>}
            {r.presence === 'cancelled' && <Tag color="red" style={{ marginLeft: 4 }}>Đã hủy</Tag>}
            <div className="muted" style={{ fontSize: 12 }}>{r.lead_name} {r.lead_phone}</div></> },
          { title: 'Nguồn bán', render: (_, r) => <><ChannelLabel channel={r.channel} account={r.account_name} />{r.external_ref && <div className="mono" style={{ fontSize: 12 }}>{r.external_ref}</div>}</> },
          { title: 'Khách', render: (_, r) => <>{r.pax_total}<div className="muted" style={{ fontSize: 12 }}>{formatPax(r.pax)}</div></> },
          { title: 'Điểm đón', render: (_, r) => <>
            {r.hotel_name ?? r.address ?? <span className="muted">Thiếu</span>}
            {r.pickup_local_time && <div><b>{String(r.pickup_local_time).slice(0, 5)}</b></div>}
            {r.ops_note && <div className="muted" style={{ fontSize: 12 }}>{r.ops_note}</div>}
            {manage && r.presence === 'active' && <div><Button type="link" size="small" style={{ padding: 0 }} onClick={() => { form.setFieldsValue({ hotel_name: r.hotel_name, address: r.address, ops_note: r.ops_note, pickup_local_time: r.pickup_local_time ? String(r.pickup_local_time).slice(0, 5) : '' }); setPickupFor(r) }}>Sửa</Button></div>}
          </> },
          { title: 'Xe', render: (_, r) => r.presence !== 'active' ? (r.vehicle_name ?? '') : manage ? (
            <Select size="small" style={{ width: 130 }} placeholder="Chưa chia" allowClear value={r.vehicle_assignment_id ?? undefined}
              options={(vehicles.data ?? []).map((v) => ({ value: v.id, label: v.vehicles?.name }))}
              onChange={(v: string | undefined) => v
                ? act.mutate({ fn: 'allocate_passengers', args: { p_assignment: v, p_item: r.item_id } })
                : act.mutate({ fn: 'deallocate_passengers', args: { p_item: r.item_id } })} />
          ) : (r.vehicle_name ?? 'Chưa chia') },
          { title: 'Điểm danh', render: (_, r) => manage ? (
            <Select size="small" style={{ width: 110 }} value={r.attendance ?? 'pending'} options={Object.entries(ATTENDANCE).map(([value, label]) => ({ value, label }))}
              onChange={(v) => act.mutate({ fn: 'set_attendance', args: { p_departure: departure, p_item: r.item_id, p_status: v } })} />
          ) : ATTENDANCE[r.attendance ?? 'pending'] },
          { title: 'Yêu cầu', dataIndex: 'special_requests', width: 200 },
        ]} />
      <Modal title="Điểm đón" open={Boolean(pickupFor)} onCancel={() => setPickupFor(null)} onOk={() => form.submit()} okText="Lưu" cancelText="Hủy" confirmLoading={savePickup.isPending}>
        <Form form={form} layout="vertical" onFinish={(v) => savePickup.mutate(v)}>
          <Form.Item name="hotel_name" label="Khách sạn"><Input /></Form.Item>
          <Form.Item name="address" label="Địa chỉ"><Input /></Form.Item>
          <Form.Item name="pickup_local_time" label="Giờ đón riêng (HH:mm)" rules={[{ pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: 'Dạng 07:30' }]}><Input placeholder="07:30" /></Form.Item>
          <Form.Item name="ops_note" label="Ghi chú điều hành"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}

function Incidents({ departure }: { departure: string }) {
  const { can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const q = useQuery({
    queryKey: ['departure', departure, 'incidents'],
    queryFn: async () => unwrap(await supabase.from('departure_incidents').select('id, severity, body, created_at, profiles(full_name)').eq('departure_id', departure).order('created_at', { ascending: false })) as unknown as Row[],
  })
  const add = useMutation({
    mutationFn: () => rpcOk('report_incident', { p_departure: departure, p_severity: 'normal', p_body: body }),
    onSuccess: () => { setBody(''); qc.invalidateQueries({ queryKey: ['departure', departure, 'incidents'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <>
      {can('ops.manage') && (
        <Space.Compact block style={{ marginBottom: 12 }}>
          <Input value={body} placeholder="Ghi nhận sự cố" onChange={(e) => setBody(e.target.value)} />
          <Button type="primary" disabled={!body.trim()} loading={add.isPending} onClick={() => add.mutate()}>Ghi nhận</Button>
        </Space.Compact>
      )}
      <List size="small" loading={q.isLoading} dataSource={q.data ?? []} locale={{ emptyText: 'Chưa có sự cố' }} renderItem={(i) => (
        <List.Item><div><div>{i.body}</div><div className="muted" style={{ fontSize: 12 }}>{i.profiles?.full_name} · {fmtDateTime(i.created_at)}</div></div></List.Item>
      )} />
    </>
  )
}

function Costs({ departure }: { departure: string }) {
  const { orgId, org, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const q = useQuery({
    queryKey: ['departure', departure, 'costs'],
    queryFn: async () => unwrap(await supabase.from('expenses').select('id, category, description, amount, currency, is_final').eq('departure_id', departure).is('deleted_at', null).order('created_at')) as Row[],
  })
  const add = useMutation({
    mutationFn: async (v: Row) => {
      const res = await supabase.from('expenses').insert({ organization_id: orgId, departure_id: departure, category: v.category, description: v.description, amount: v.amount, currency: v.currency, is_final: v.is_final ?? false, incurred_on: dayjs().format('YYYY-MM-DD') })
      if (res.error) throw new Error(friendlyError(res.error))
    },
    onSuccess: () => { form.resetFields(); qc.invalidateQueries({ queryKey: ['departure', departure, 'costs'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <>
      {can('finance.manage') && (
        <Form form={form} layout="inline" style={{ marginBottom: 12, rowGap: 8 }} onFinish={(v) => add.mutate(v)} initialValues={{ currency: org?.default_currency, category: 'transport' }}>
          <Form.Item name="category"><Select style={{ width: 130 }} options={[{ value: 'transport', label: 'Xe' }, { value: 'guide', label: 'Hướng dẫn viên' }, { value: 'ticket', label: 'Vé' }, { value: 'meal', label: 'Ăn uống' }, { value: 'other', label: 'Khác' }]} /></Form.Item>
          <Form.Item name="description"><Input placeholder="Mô tả" /></Form.Item>
          <Form.Item name="amount" rules={[{ required: true, message: 'Nhập số tiền' }, { pattern: /^\d+(\.\d+)?$/, message: 'Nhập số' }]}><Input placeholder="Số tiền" style={{ width: 120 }} /></Form.Item>
          <Form.Item name="currency" rules={[{ required: true }, { pattern: /^[A-Z]{3}$/, message: '3 chữ in hoa' }]}><Input style={{ width: 70 }} /></Form.Item>
          <Form.Item name="is_final" valuePropName="checked"><Switch checkedChildren="Chốt" unCheckedChildren="Tạm" /></Form.Item>
          <Button type="primary" htmlType="submit" loading={add.isPending}>Thêm</Button>
        </Form>
      )}
      <Table rowKey="id" size="small" pagination={false} loading={q.isLoading} dataSource={q.data} locale={{ emptyText: <Typography.Text type="warning">Chưa nhập chi phí: báo cáo lợi nhuận sẽ ghi là thiếu dữ liệu.</Typography.Text> }} columns={[
        { title: 'Loại', dataIndex: 'category' },
        { title: 'Mô tả', dataIndex: 'description' },
        { title: 'Số tiền', align: 'right', render: (_, e) => <MoneyText amount={e.amount} currency={e.currency} /> },
        { title: 'Tình trạng', render: (_, e) => (e.is_final ? <Tag color="green">Đã chốt</Tag> : <Tag>Tạm tính</Tag>) },
      ]} />
    </>
  )
}
