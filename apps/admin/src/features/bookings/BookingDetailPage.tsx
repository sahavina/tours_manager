import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Descriptions, Form, Input, InputNumber, List, Modal, Select, Space, Table, Tabs, Tag, Timeline, Typography } from 'antd'
import { ATTENDANCE, BOOKING_STATUS, formatPax, CHANNEL_REQUEST, OPS_STATUS, PAYMENT_STATUS, RECONCILIATION_STATUS, SYNC_STATUS } from '@tours/core'
import dayjs from 'dayjs'
import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import {
  BookingStatusTag, Can, ChannelLabel, ErrorState, fmtDateTime, Loading, LocalTime, MoneyText, NoData, OpsStatusTag, PageHead, ReconTag, SyncStatusTag,
} from '../../components/common'
import { rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

function useInvalidate(id: string) {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ['booking', id] })
    qc.invalidateQueries({ queryKey: ['bookings'] })
    qc.invalidateQueries({ queryKey: ['departures'] })
  }
}

export function BookingDetailPage() {
  const { id = '' } = useParams()
  const { can, orgId } = useAuth()
  const { message } = App.useApp()
  const [params, setParams] = useSearchParams()
  const invalidate = useInvalidate(id)

  const q = useQuery({
    queryKey: ['booking', id, 'main'],
    queryFn: async () => {
      const b = unwrap(await supabase.from('v_booking_list').select('*').eq('id', id).eq('organization_id', orgId).maybeSingle()) as Row | null
      if (!b) return null
      const [full, items, notes] = await Promise.all([
        supabase.from('bookings').select('special_requests, policy_snapshot, last_source_at, last_source_version, updated_at').eq('id', id).single(),
        supabase.from('booking_items').select('*, tours(name), tour_options(name, has_transfer)').eq('booking_id', id).order('item_ref'),
        supabase.from('booking_notes').select('id, body, created_at, profiles(full_name, email)').eq('booking_id', id).order('created_at', { ascending: false }),
      ])
      return { ...b, ...(unwrap(full) as Row), items: unwrap(items) as Row[], notes: unwrap(notes) as unknown as Row[] } as Row
    },
  })

  const update = useMutation({
    mutationFn: (patch: Row) => rpcOk('update_booking_internal', { p_booking: id, p_patch: patch }),
    onSuccess: () => { message.success('Đã cập nhật'); invalidate() },
    onError: (e: Error) => message.error(e.message),
  })
  const cancel = useMutation({
    mutationFn: (reason: string) => rpcOk('cancel_booking_internal', { p_booking: id, p_reason: reason }),
    onSuccess: (r) => {
      if (r.channel_action_required) message.warning('Đã hủy trong hệ thống. Vẫn cần hủy tay trên kênh.')
      else message.success('Đã hủy booking')
      invalidate()
    },
    onError: (e: Error) => message.error(e.message),
  })

  if (q.isLoading) return <Loading />
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const b = q.data
  if (!b) return <NoData text="Không tìm thấy booking" />

  const confirmCancel = () => {
    let reason = ''
    Modal.confirm({
      title: `Hủy booking ${b.code}?`,
      content: (
        <>
          {b.connection_id && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message="Thao tác này chỉ hủy trong hệ thống nội bộ. Kênh bán KHÔNG được cập nhật: phải hủy tay trên kênh." />}
          <Input.TextArea placeholder="Lý do" onChange={(e) => (reason = e.target.value)} />
        </>
      ),
      okText: 'Hủy booking', okButtonProps: { danger: true }, cancelText: 'Đóng',
      onOk: () => cancel.mutateAsync(reason),
    })
  }

  const tab = params.get('tab') ?? 'overview'
  return (
    <>
      <PageHead title={<Space wrap>{b.code}<BookingStatusTag value={b.status} /><OpsStatusTag value={b.ops_status} /></Space>} extra={
        <Can perm="booking.manage">
          {b.needs_action || b.changed_after_assignment
            ? <Button onClick={() => update.mutate({ needs_action: false, action_reason: null, changed_after_assignment: false })}>Đã xử lý xong</Button>
            : <Button onClick={() => update.mutate({ needs_action: true, action_reason: 'Đánh dấu thủ công' })}>Đánh dấu cần xử lý</Button>}
          {b.status !== 'cancelled' && <Button danger onClick={confirmCancel}>Hủy booking</Button>}
        </Can>
      } />

      {b.connection_mode === 'mock' && <div className="mock-banner">Booking này đến từ kết nối <b>mô phỏng</b>, không phải đơn thật từ kênh.</div>}
      {b.needs_action && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Cần xử lý" description={b.action_reason} />}
      {b.changed_after_assignment && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Booking có thay đổi sau khi chuyến đã phân công. Hãy báo lại hướng dẫn viên và nhà xe." />}

      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'overview' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'overview', label: 'Tổng quan', children: <Overview b={b} onUpdate={(p) => update.mutate(p)} /> },
          { key: 'people', label: 'Khách và người tham gia', children: <People b={b} /> },
          { key: 'trip', label: 'Chuyến và điểm đón', children: <Trip b={b} /> },
          { key: 'ops', label: 'Điều hành', children: <Ops b={b} /> },
          ...(can('finance.read') ? [{ key: 'finance', label: 'Tài chính', children: <Finance b={b} /> }] : []),
          { key: 'history', label: 'Lịch sử', children: <History id={id} /> },
          ...(can('booking.source_read') ? [{ key: 'source', label: 'Dữ liệu nguồn', children: <Source id={id} /> }] : []),
        ]} />
      </Card>
    </>
  )
}

function Overview({ b, onUpdate }: { b: Row; onUpdate: (p: Row) => void }) {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const invalidate = useInvalidate(b.id)
  const [note, setNote] = useState('')
  const addNote = useMutation({
    mutationFn: () => rpcOk('add_booking_note', { p_booking: b.id, p_body: note }),
    onSuccess: () => { setNote(''); invalidate() },
    onError: (e: Error) => message.error(e.message),
  })
  const members = useQuery({
    queryKey: ['members-lite', orgId],
    enabled: can('booking.manage'),
    queryFn: () => rpc<Row[]>('member_assignable', { p_org: orgId }),
  })
  return (
    <>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Mã nội bộ">{b.code}</Descriptions.Item>
        <Descriptions.Item label="Mã bên ngoài">{b.external_ref ?? 'Không có'}</Descriptions.Item>
        <Descriptions.Item label="Nguồn bán"><ChannelLabel channel={b.channel} account={b.account_name} mode={b.connection_mode} /></Descriptions.Item>
        <Descriptions.Item label="Ngày đặt">{fmtDateTime(b.booked_at)}</Descriptions.Item>
        <Descriptions.Item label="Tour / gói">{b.tour_name ?? <Tag color="red">Chưa ghép mã {b.external_product_code}</Tag>}{b.option_name && ` · ${b.option_name}`}</Descriptions.Item>
        <Descriptions.Item label="Ngày giờ đi"><LocalTime date={b.local_date} time={b.local_time} tz={b.timezone} /></Descriptions.Item>
        <Descriptions.Item label="Giá trị bán"><MoneyText amount={b.gross_amount} currency={b.currency} /></Descriptions.Item>
        <Descriptions.Item label="Cập nhật gần nhất">{fmtDateTime(b.updated_at)}</Descriptions.Item>
        <Descriptions.Item label="Người phụ trách">
          {can('booking.manage') ? (
            <Select size="small" style={{ minWidth: 200 }} value={b.owner_id} allowClear placeholder="Chưa gán"
              options={(members.data ?? []).map((m) => ({ value: m.user_id, label: m.name }))}
              onChange={(v) => onUpdate({ owner_id: v ?? null })} />
          ) : (b.owner_name ?? 'Chưa gán')}
        </Descriptions.Item>
        <Descriptions.Item label="Yêu cầu đặc biệt">{b.special_requests ?? 'Không có'}</Descriptions.Item>
        {b.policy_snapshot && <Descriptions.Item label="Chính sách lúc đặt" span={2}><span className="mono">{JSON.stringify(b.policy_snapshot)}</span></Descriptions.Item>}
      </Descriptions>

      <Typography.Title level={5}>Các trạng thái</Typography.Title>
      <Descriptions bordered size="small" column={{ xs: 1, md: 3 }} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Do kênh cung cấp">{b.channel_status ?? <span className="muted">Không có</span>}</Descriptions.Item>
        <Descriptions.Item label="Chuẩn hóa nội bộ">{BOOKING_STATUS[b.status]}</Descriptions.Item>
        <Descriptions.Item label="Điều hành">{OPS_STATUS[b.ops_status]}</Descriptions.Item>
        <Descriptions.Item label="Thanh toán">
          <Can perm="booking.manage">
            <Select size="small" style={{ minWidth: 160 }} value={b.payment_status} onChange={(v) => onUpdate({ payment_status: v })}
              options={Object.entries(PAYMENT_STATUS).map(([value, label]) => ({ value, label }))} />
          </Can>
          {!can('booking.manage') && PAYMENT_STATUS[b.payment_status]}
        </Descriptions.Item>
        <Descriptions.Item label="Đối soát">{RECONCILIATION_STATUS[b.reconciliation_status]}</Descriptions.Item>
        <Descriptions.Item label="Đồng bộ"><SyncStatusTag value={b.sync_status} />{b.sync_status !== SYNC_STATUS.manual && b.last_source_at && <div className="muted" style={{ fontSize: 12 }}>Nguồn: {fmtDateTime(b.last_source_at)}</div>}</Descriptions.Item>
      </Descriptions>

      <Typography.Title level={5}>Ghi chú nội bộ</Typography.Title>
      <Can perm="booking.manage">
        <Space.Compact block style={{ marginBottom: 12 }}>
          <Input value={note} placeholder="Đồng bộ từ kênh không bao giờ ghi đè ghi chú này" onChange={(e) => setNote(e.target.value)} onPressEnter={() => note.trim() && addNote.mutate()} />
          <Button type="primary" disabled={!note.trim()} loading={addNote.isPending} onClick={() => addNote.mutate()}>Thêm</Button>
        </Space.Compact>
      </Can>
      <List size="small" dataSource={b.notes as Row[]} locale={{ emptyText: 'Chưa có ghi chú' }}
        renderItem={(n) => (
          <List.Item><div><div>{n.body}</div><div className="muted" style={{ fontSize: 12 }}>{n.profiles?.full_name ?? n.profiles?.email} · {fmtDateTime(n.created_at)}</div></div></List.Item>
        )} />
    </>
  )
}

function People({ b }: { b: Row }) {
  const q = useQuery({
    queryKey: ['booking', b.id, 'participants'],
    queryFn: async () => unwrap(await supabase.from('booking_participants').select('id, full_name, category_code, is_lead, note, source').eq('booking_id', b.id)) as Row[],
  })
  return (
    <>
      <Descriptions bordered size="small" column={{ xs: 1, md: 3 }} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Người liên hệ">{b.lead_name ?? 'Thiếu'}</Descriptions.Item>
        <Descriptions.Item label="Email">{b.lead_email ?? 'Nguồn không cung cấp'}</Descriptions.Item>
        <Descriptions.Item label="Điện thoại">{b.lead_phone ?? 'Nguồn không cung cấp'}</Descriptions.Item>
      </Descriptions>
      <Table rowKey="id" size="small" pagination={false} loading={q.isLoading} dataSource={q.data} scroll={{ x: 'max-content' }}
        locale={{ emptyText: <NoData text="Nguồn chưa cung cấp danh sách người tham gia" /> }}
        columns={[
          { title: 'Họ tên', dataIndex: 'full_name' },
          { title: 'Nhóm khách', dataIndex: 'category_code' },
          { title: 'Đại diện', dataIndex: 'is_lead', render: (v) => (v ? 'Có' : '') },
          { title: 'Nguồn', dataIndex: 'source' },
        ]} />
    </>
  )
}

function Trip({ b }: { b: Row }) {
  const { can, orgId } = useAuth()
  const { message } = App.useApp()
  const invalidate = useInvalidate(b.id)
  const qc = useQueryClient()
  const [moving, setMoving] = useState<Row | null>(null)
  const [pickupFor, setPickupFor] = useState<Row | null>(null)
  const [paxFor, setPaxFor] = useState<Row | null>(null)
  const [form] = Form.useForm()
  const [paxForm] = Form.useForm()

  const pickups = useQuery({
    queryKey: ['booking', b.id, 'pickups'],
    queryFn: async () => unwrap(await supabase.from('booking_pickups').select('*').in('booking_item_id', (b.items as Row[]).map((i) => i.id))) as Row[],
  })
  const targets = useQuery({
    queryKey: ['move-targets', moving?.tour_id],
    enabled: Boolean(moving?.tour_id),
    queryFn: async () => unwrap(await supabase.from('v_departure_availability').select('id, local_date, local_time, available_seats, slot_no')
      .eq('organization_id', orgId).eq('tour_id', moving!.tour_id).eq('status', 'scheduled')
      .gte('local_date', dayjs().format('YYYY-MM-DD')).order('starts_at').limit(100)) as Row[],
  })
  const move = useMutation({
    mutationFn: (dep: string) => rpcOk('move_booking_item', { p_item: moving!.id, p_departure: dep }),
    onSuccess: (r) => {
      setMoving(null)
      if (r.channel_request_status === 'manual_required') message.warning('Đã đổi chuyến nội bộ. Kênh chưa được cập nhật: cần xử lý tay trên kênh.')
      else message.success('Đã đổi chuyến')
      invalidate()
    },
    onError: (e: Error) => message.error(e.message),
  })
  const savePickup = useMutation({
    mutationFn: (v: Row) => rpcOk('set_pickup', { p_item: pickupFor!.id, p_patch: {
      hotel_name: v.hotel_name, address: v.address, pickup_local_time: v.pickup_local_time || null, ops_note: v.ops_note,
    } }),
    onSuccess: () => { setPickupFor(null); message.success('Đã lưu điểm đón'); qc.invalidateQueries({ queryKey: ['booking', b.id] }); invalidate() },
    onError: (e: Error) => message.error(e.message),
  })
  const savePax = useMutation({
    mutationFn: (v: Row) => rpcOk('update_item_pax', { p_item: paxFor!.id, p_pax: Object.fromEntries(Object.entries(v).filter(([, n]) => Number(n) > 0)) }),
    onSuccess: () => { setPaxFor(null); message.success('Đã đổi số khách'); invalidate() },
    onError: (e: Error) => message.error(e.message),
  })

  return (
    <>
      <Table rowKey="id" size="small" pagination={false} dataSource={b.items as Row[]} scroll={{ x: 'max-content' }} columns={[
        { title: 'Tour / gói', render: (_, i) => i.tours?.name ? `${i.tours.name} · ${i.tour_options?.name ?? ''}` : <Tag color="red">Chưa ghép {i.external_product_code}</Tag> },
        { title: 'Ngày giờ đi', render: (_, i) => <LocalTime date={i.local_date} time={i.local_time} tz={i.timezone} /> },
        { title: 'Nhóm khách', render: (_, i) => formatPax(i.pax) },
        { title: 'Chiếm chỗ', dataIndex: 'committed_seats', align: 'right' },
        { title: 'Điểm đón', render: (_, i) => { const p = pickups.data?.find((x) => x.booking_item_id === i.id); return p ? `${p.hotel_name ?? ''} ${p.address ?? ''}`.trim() || 'Trống' : <span className="muted">Không có</span> } },
        { title: 'Giờ đón', render: (_, i) => String(pickups.data?.find((x) => x.booking_item_id === i.id)?.pickup_local_time ?? '').slice(0, 5) },
        { title: 'Chuyến', render: (_, i) => i.departure_id ? <Link to={`/operations/${i.departure_id}`}>Mở chuyến</Link> : <Tag color="orange">Chưa xếp chuyến</Tag> },
        { title: '', render: (_, i) => b.status !== 'cancelled' && (
          <Space size={0}>
            {can('ops.manage') && <Button type="link" size="small" disabled={!i.tour_id} onClick={() => setMoving(i)}>Đổi chuyến</Button>}
            {can('ops.manage') && <Button type="link" size="small" onClick={() => { const p = pickups.data?.find((x) => x.booking_item_id === i.id); form.setFieldsValue({ ...p, pickup_local_time: p?.pickup_local_time ? String(p.pickup_local_time).slice(0, 5) : '' }); setPickupFor(i) }}>Điểm đón</Button>}
            {can('booking.manage') && <Button type="link" size="small" onClick={() => { paxForm.setFieldsValue(i.pax); setPaxFor(i) }}>Số khách</Button>}
          </Space>
        ) },
      ]} />
      {b.connection_id && <Alert type="info" showIcon style={{ marginTop: 12 }} message="Đổi chuyến, đổi số khách ở đây là sửa nội bộ. Kênh chưa hỗ trợ cập nhật từ hệ thống, nên phải làm tay trên kênh và theo dõi ở tab Lịch sử." />}

      <Modal title="Đổi chuyến" open={Boolean(moving)} onCancel={() => setMoving(null)} footer={null} destroyOnClose>
        <p className="muted">Hệ thống kiểm tra chỗ chuyến đích và trả chỗ chuyến cũ trong cùng một giao dịch.</p>
        <Select style={{ width: '100%' }} placeholder="Chọn chuyến đích" loading={targets.isLoading}
          options={(targets.data ?? []).filter((d) => d.id !== moving?.departure_id).map((d) => ({
            value: d.id, disabled: d.available_seats < (moving?.seats ?? 0),
            label: `${dayjs(d.local_date).format('DD/MM/YYYY')} ${String(d.local_time).slice(0, 5)}${d.slot_no > 1 ? ` (chuyến ${d.slot_no})` : ''} · còn ${d.available_seats} chỗ`,
          }))} onChange={(v: string) => move.mutate(v)} />
      </Modal>
      <Modal title="Điểm đón" open={Boolean(pickupFor)} onCancel={() => setPickupFor(null)} onOk={() => form.submit()} okText="Lưu" cancelText="Hủy" confirmLoading={savePickup.isPending}>
        <Form form={form} layout="vertical" onFinish={(v) => savePickup.mutate(v)}>
          <Form.Item name="hotel_name" label="Khách sạn"><Input /></Form.Item>
          <Form.Item name="address" label="Địa chỉ"><Input /></Form.Item>
          <Form.Item name="pickup_local_time" label="Giờ đón (HH:mm, giờ địa phương)" rules={[{ pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: 'Dạng 07:30' }]}><Input placeholder="07:30" /></Form.Item>
          <Form.Item name="ops_note" label="Ghi chú điều hành"><Input.TextArea rows={2} /></Form.Item>
        </Form>
      </Modal>
      <Modal title="Số khách" open={Boolean(paxFor)} onCancel={() => setPaxFor(null)} onOk={() => paxForm.submit()} okText="Lưu" cancelText="Hủy" confirmLoading={savePax.isPending}>
        <Form form={paxForm} layout="inline" onFinish={(v) => savePax.mutate(v)}>
          {['adult', 'child', 'infant'].map((k) => <Form.Item key={k} name={k} label={k === 'adult' ? 'Người lớn' : k === 'child' ? 'Trẻ em' : 'Em bé'}><InputNumber min={0} style={{ width: 70 }} /></Form.Item>)}
        </Form>
      </Modal>
    </>
  )
}

function Ops({ b }: { b: Row }) {
  const { can } = useAuth()
  const depId = (b.items as Row[])[0]?.departure_id as string | undefined
  const q = useQuery({
    queryKey: ['booking', b.id, 'ops', depId],
    enabled: Boolean(depId) && can('ops.read'),
    queryFn: async () => {
      const [g, v, a] = await Promise.all([
        supabase.from('guide_assignments').select('id, role, guides(full_name, phone), notified_at, confirmed_at').eq('departure_id', depId!),
        supabase.from('vehicle_assignments').select('id, driver_name, vehicles(name, plate)').eq('departure_id', depId!),
        supabase.from('attendance_records').select('departure_id, status, note, recorded_at').eq('booking_item_id', (b.items as Row[])[0]!.id),
      ])
      return { guides: unwrap(g) as unknown as Row[], vehicles: unwrap(v) as unknown as Row[], attendance: unwrap(a) as Row[] }
    },
  })
  if (!depId) return <NoData text="Booking chưa được xếp vào chuyến nào" />
  if (!can('ops.read')) return <Link to={`/operations/${depId}`}>Mở chuyến</Link>
  return (
    <Descriptions bordered size="small" column={1}>
      <Descriptions.Item label="Hướng dẫn viên">{q.data?.guides.map((g) => g.guides?.full_name).join(', ') || <Tag color="orange">Chưa phân công</Tag>}</Descriptions.Item>
      <Descriptions.Item label="Xe">{q.data?.vehicles.map((v) => `${v.vehicles?.name} ${v.vehicles?.plate ?? ''}`).join(', ') || <Tag color="orange">Chưa phân công</Tag>}</Descriptions.Item>
      <Descriptions.Item label="Điểm danh">{q.data?.attendance.map((a) => `${ATTENDANCE[a.status]} (${fmtDateTime(a.recorded_at)})`).join('; ') || 'Chưa có'}</Descriptions.Item>
      <Descriptions.Item label="Chuyến"><Link to={`/operations/${depId}`}>Mở bảng điều hành của chuyến</Link></Descriptions.Item>
    </Descriptions>
  )
}

function Finance({ b }: { b: Row }) {
  const { can } = useAuth()
  const { message } = App.useApp()
  const invalidate = useInvalidate(b.id)
  const [form] = Form.useForm()
  const q = useQuery({
    queryKey: ['booking', b.id, 'finance'],
    queryFn: async () => {
      const [f, m] = await Promise.all([
        supabase.from('booking_financials').select('*').eq('booking_id', b.id).maybeSingle(),
        supabase.from('reconciliation_matches').select('id, amount, currency, action, note, created_at').eq('booking_id', b.id).order('created_at'),
      ])
      return { f: unwrap(f) as Row | null, matches: unwrap(m) as Row[] }
    },
  })
  const save = useMutation({
    mutationFn: (v: Row) => rpcOk('update_booking_financials', { p_booking: b.id, p_patch: v }),
    onSuccess: () => { message.success('Đã lưu'); invalidate() },
    onError: (e: Error) => message.error(e.message),
  })
  if (q.isLoading) return <Loading />
  const f = q.data?.f ?? {}
  const cur = f.currency ?? b.currency
  return (
    <>
      <Descriptions bordered size="small" column={{ xs: 1, md: 2 }} style={{ marginBottom: 16 }}>
        <Descriptions.Item label="Giá trị bán"><MoneyText amount={b.gross_amount} currency={cur} /></Descriptions.Item>
        <Descriptions.Item label="Giảm giá"><MoneyText amount={f.discount_amount} currency={cur} /></Descriptions.Item>
        <Descriptions.Item label="Phí kênh"><MoneyText amount={f.channel_fee} currency={cur} /></Descriptions.Item>
        <Descriptions.Item label="Hoàn tiền"><MoneyText amount={f.refund_amount} currency={cur} /></Descriptions.Item>
        <Descriptions.Item label="Dự kiến nhận"><MoneyText amount={f.expected_payout} currency={cur} /></Descriptions.Item>
        <Descriptions.Item label="Thực nhận (từ đối soát)"><MoneyText amount={f.actual_payout} currency={cur} /></Descriptions.Item>
        <Descriptions.Item label="Đối soát"><ReconTag value={b.reconciliation_status} /></Descriptions.Item>
      </Descriptions>
      {can('finance.manage') && (
        <Form form={form} layout="inline" onFinish={(v) => save.mutate(v)} style={{ marginBottom: 16, rowGap: 8 }}
          initialValues={{ discount_amount: f.discount_amount ?? '', channel_fee: f.channel_fee ?? '', refund_amount: f.refund_amount ?? '', expected_payout: f.expected_payout ?? '' }}>
          {[['discount_amount', 'Giảm giá'], ['channel_fee', 'Phí kênh'], ['refund_amount', 'Hoàn tiền'], ['expected_payout', 'Dự kiến nhận']].map(([k, l]) => (
            <Form.Item key={k} name={k} label={l} rules={[{ pattern: /^\d*(\.\d+)?$/, message: 'Nhập số' }]}><Input style={{ width: 110 }} placeholder="Chưa có" /></Form.Item>
          ))}
          <Button type="primary" htmlType="submit" loading={save.isPending}>Lưu</Button>
        </Form>
      )}
      <Typography.Title level={5}>Lịch sử đối soát</Typography.Title>
      <Table rowKey="id" size="small" pagination={false} dataSource={q.data?.matches} locale={{ emptyText: 'Chưa có' }} columns={[
        { title: 'Thời điểm', dataIndex: 'created_at', render: fmtDateTime },
        { title: 'Số tiền', render: (_, m) => <MoneyText amount={m.amount} currency={m.currency} /> },
        { title: 'Cách ghép', dataIndex: 'action' },
        { title: 'Ghi chú', dataIndex: 'note' },
      ]} />
    </>
  )
}

function History({ id }: { id: string }) {
  const { message } = App.useApp()
  const { can } = useAuth()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['booking', id, 'history'],
    queryFn: async () => {
      const [c, s] = await Promise.all([
        supabase.from('booking_changes').select('id, change_type, summary, source, created_at, channel_request_status').eq('booking_id', id).order('created_at', { ascending: false }),
        supabase.from('booking_status_history').select('id, field, from_value, to_value, source, created_at').eq('booking_id', id).order('created_at', { ascending: false }),
      ])
      return { changes: unwrap(c) as Row[], statuses: unwrap(s) as Row[] }
    },
  })
  const setReq = useMutation({
    mutationFn: ({ change, status }: { change: string; status: string }) => rpcOk('set_channel_request_status', { p_change: change, p_status: status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['booking', id, 'history'] }),
    onError: (e: Error) => message.error(e.message),
  })
  if (q.isLoading) return <Loading />
  return (
    <>
      <Timeline items={(q.data?.changes ?? []).map((c) => ({
        color: c.channel_request_status === 'manual_required' ? 'orange' : 'blue',
        children: (
          <div>
            <div>{c.summary}</div>
            <div className="muted" style={{ fontSize: 12 }}>{fmtDateTime(c.created_at)} · nguồn: {c.source}</div>
            {c.channel_request_status !== 'not_applicable' && (
              <Space style={{ marginTop: 4 }} wrap>
                <Tag color={c.channel_request_status === 'manual_required' ? 'orange' : 'default'}>{CHANNEL_REQUEST[c.channel_request_status]}</Tag>
                {can('booking.manage') && c.channel_request_status === 'manual_required' && (
                  <Button size="small" onClick={() => setReq.mutate({ change: c.id, status: 'requested' })}>Đã gửi yêu cầu trên kênh</Button>
                )}
              </Space>
            )}
          </div>
        ),
      }))} />
      <Typography.Title level={5}>Đổi trạng thái</Typography.Title>
      <Table rowKey="id" size="small" pagination={false} dataSource={q.data?.statuses} locale={{ emptyText: 'Chưa có' }} scroll={{ x: 'max-content' }} columns={[
        { title: 'Thời điểm', dataIndex: 'created_at', render: fmtDateTime },
        { title: 'Trường', dataIndex: 'field' },
        { title: 'Từ', dataIndex: 'from_value' },
        { title: 'Thành', dataIndex: 'to_value' },
        { title: 'Nguồn', dataIndex: 'source' },
      ]} />
    </>
  )
}

function Source({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['booking', id, 'source'],
    queryFn: async () => unwrap(await supabase.from('booking_source_snapshots').select('payload, captured_at').eq('booking_id', id).maybeSingle()) as Row | null,
  })
  if (q.isLoading) return <Loading />
  if (!q.data) return <NoData text="Booking tạo nội bộ, không có dữ liệu nguồn" />
  return (
    <>
      <p className="muted">Ghi nhận lúc {fmtDateTime(q.data.captured_at)}. Thông tin nhạy cảm đã được che trước khi lưu.</p>
      <pre className="payload">{JSON.stringify(q.data.payload, null, 2)}</pre>
    </>
  )
}
