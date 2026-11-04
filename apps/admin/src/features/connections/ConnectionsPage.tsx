import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal, Select, Space, Switch, Table, Tabs, Tag, Tooltip } from 'antd'
import { DESCRIPTORS } from '@tours/channels'
import { APPROVAL_STATUS, CAPABILITIES, CHANNEL, EVENT_STATUS } from '@tours/core'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { Can, ConnectionBadge, ErrorState, EventStatusTag, fmtDateTime, NoData, PageHead } from '../../components/common'
import { CONNECTION_COLUMNS, friendlyError, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'
import { Simulator } from './Simulator'

function useConnections() {
  const { orgId } = useAuth()
  return useQuery({
    queryKey: ['connections', orgId],
    queryFn: async () => unwrap(await supabase.from('channel_connections').select(CONNECTION_COLUMNS).eq('organization_id', orgId).order('created_at')) as unknown as Row[],
  })
}

const CAP_COLOR: Record<string, string> = { supported: 'green', unsupported: 'default', unverified: 'gold' }
const CAP_TEXT: Record<string, string> = { supported: 'Có', unsupported: 'Không', unverified: 'Chưa xác minh' }

function ConnectionDrawer({ row, onClose }: { row: Row; onClose: () => void }) {
  const { can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const save = useMutation({
    mutationFn: (v: Row) => rpcOk('connection_update', { p_connection: row.id, p_patch: v }),
    onSuccess: () => { message.success('Đã lưu'); qc.invalidateQueries({ queryKey: ['connections'] }); onClose() },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <Drawer title={`${CHANNEL[row.channel]} · ${row.account_name}`} open onClose={onClose} width={520}
      extra={can('connection.manage') && <Button type="primary" loading={save.isPending} onClick={() => form.submit()}>Lưu</Button>}>
      <ConnectionBadge mode={row.mode} status={row.status} />
      <Descriptions size="small" column={1} style={{ margin: '12px 0' }}>
        <Descriptions.Item label="Phê duyệt của kênh">{APPROVAL_STATUS[row.approval_status]}</Descriptions.Item>
        <Descriptions.Item label="Liên lạc thành công gần nhất">{row.last_success_at ? fmtDateTime(row.last_success_at) : 'Chưa có'}</Descriptions.Item>
        {row.mode === 'mock' && <Descriptions.Item label="Lần mô phỏng gần nhất">{fmtDateTime(row.last_simulated_at) || 'Chưa có'}</Descriptions.Item>}
        <Descriptions.Item label="Lỗi hiện tại">{row.last_error ?? 'Không có'}</Descriptions.Item>
        <Descriptions.Item label="Khóa API">{row.has_credentials ? 'Đã khai tên bí mật' : 'Chưa cấu hình'}</Descriptions.Item>
      </Descriptions>
      <Form form={form} layout="vertical" disabled={!can('connection.manage')} onFinish={(v) => save.mutate(v)}
        initialValues={{ account_name: row.account_name, supplier_account_ref: row.supplier_account_ref, mode: row.mode, approval_status: row.approval_status, hold_ttl_seconds: row.hold_ttl_seconds, stale_after_minutes: row.stale_after_minutes }}>
        <Form.Item name="account_name" label="Tên tài khoản" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="supplier_account_ref" label="Mã tài khoản nhà cung cấp"><Input /></Form.Item>
        <Form.Item name="mode" label="Chế độ" extra="Chuyển sang Sandbox hay Production không tự làm kết nối hoạt động: chưa có connector thật. Xem docs/CHANNEL_INTEGRATION.md.">
          <Select options={[{ value: 'mock', label: 'Mô phỏng' }, { value: 'sandbox', label: 'Sandbox' }, { value: 'production', label: 'Production' }]} />
        </Form.Item>
        <Form.Item name="approval_status" label="Trạng thái phê duyệt"><Select options={Object.entries(APPROVAL_STATUS).map(([value, label]) => ({ value, label }))} /></Form.Item>
        <Form.Item name="credential_ref" label="Tên bí mật trong secret manager" extra="Chỉ nhập TÊN của bí mật, không dán khóa API vào đây. Khóa không được lưu trong database."><Input placeholder="VIATOR_API_KEY_ACCOUNT_1" autoComplete="off" /></Form.Item>
        <Form.Item name="hold_ttl_seconds" label="Thời hạn giữ chỗ (giây)"><InputNumber min={60} style={{ width: '100%' }} /></Form.Item>
        <Form.Item name="stale_after_minutes" label="Cảnh báo dữ liệu cũ sau (phút)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
      </Form>
      <h4>Khả năng</h4>
      {row.mode === 'mock' && <p className="muted">Đây là khả năng của connector mô phỏng, không phải xác nhận từ kênh.</p>}
      <Table rowKey="key" size="small" pagination={false} dataSource={Object.entries(CAPABILITIES).map(([key, label]) => ({ key, label, state: row.capabilities?.[key] ?? 'unverified' }))} columns={[
        { title: 'Khả năng', dataIndex: 'label' },
        { title: '', render: (_, c) => <Tag color={CAP_COLOR[c.state]}>{CAP_TEXT[c.state]}</Tag> },
      ]} />
    </Drawer>
  )
}

function ConnectionsTab() {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const list = useConnections()
  const [open, setOpen] = useState<Row | null>(null)
  const [creating, setCreating] = useState(false)
  const [form] = Form.useForm()
  const create = useMutation({
    mutationFn: (v: Row) => {
      const d = DESCRIPTORS[v.channel as 'viator' | 'getyourguide']
      return rpcOk('connection_create', { p_org: orgId, p_channel: v.channel, p_account: v.account_name, p_capabilities: d?.capabilities ?? {}, p_ttl: d?.defaultHoldTtlSeconds ?? 900 })
    },
    onSuccess: () => { message.success('Đã tạo kết nối mô phỏng'); setCreating(false); qc.invalidateQueries({ queryKey: ['connections'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <>
      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Chưa có kết nối thật với Viator hay GetYourGuide. Kết nối thật cần hợp đồng và phê duyệt của từng nền tảng; hiện chỉ có connector mô phỏng." />
      <div className="filters"><div style={{ flex: 1 }} /><Can perm="connection.manage"><Button type="primary" onClick={() => setCreating(true)}>Thêm tài khoản</Button></Can></div>
      {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : (
        <Table rowKey="id" size="middle" loading={list.isLoading} dataSource={list.data} pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: <NoData text="Chưa có kết nối" /> }} columns={[
          { title: 'Kênh', render: (_, c) => <a onClick={() => setOpen(c)}>{CHANNEL[c.channel]}</a> },
          { title: 'Tài khoản', dataIndex: 'account_name' },
          { title: 'Trạng thái', render: (_, c) => <ConnectionBadge mode={c.mode} status={c.status} /> },
          { title: 'Phê duyệt', render: (_, c) => APPROVAL_STATUS[c.approval_status] },
          { title: 'Liên lạc gần nhất', render: (_, c) => c.last_success_at ? fmtDateTime(c.last_success_at) : c.last_simulated_at ? <span className="muted">Mô phỏng {fmtDateTime(c.last_simulated_at)}</span> : 'Chưa có' },
          { title: 'Giữ chỗ', render: (_, c) => `${Math.round(c.hold_ttl_seconds / 60)} phút` },
          { title: 'Lỗi', render: (_, c) => c.last_error ? <Tooltip title={c.last_error}><Tag color="red">{fmtDateTime(c.last_error_at)}</Tag></Tooltip> : '' },
        ]} />
      )}
      {open && <ConnectionDrawer row={open} onClose={() => setOpen(null)} />}
      <Modal title="Thêm tài khoản kênh" open={creating} onCancel={() => setCreating(false)} onOk={() => form.submit()} okText="Tạo" cancelText="Hủy" confirmLoading={create.isPending}>
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)} initialValues={{ channel: 'viator' }}>
          <Form.Item name="channel" label="Kênh"><Select options={[{ value: 'viator', label: 'Viator' }, { value: 'getyourguide', label: 'GetYourGuide' }, { value: 'manual', label: 'Nguồn nội bộ / file' }, { value: 'other', label: 'Khác' }]} /></Form.Item>
          <Form.Item name="account_name" label="Tên tài khoản" rules={[{ required: true, message: 'Nhập tên' }]}><Input /></Form.Item>
          <p className="muted">Tài khoản mới luôn bắt đầu ở chế độ mô phỏng.</p>
        </Form>
      </Modal>
    </>
  )
}

function MappingsTab() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [edit, setEdit] = useState<Row | null>(null)
  const [form] = Form.useForm()
  const connections = useConnections()
  const onlyPending = params.get('pending') === '1'
  const list = useQuery({
    queryKey: ['mappings', orgId, onlyPending],
    queryFn: async () => {
      let q = supabase.from('channel_product_mappings').select('*, tour_options(name, code, tours(name)), channel_connections(account_name, channel)').eq('organization_id', orgId)
      if (onlyPending) q = q.eq('is_verified', false)
      return unwrap(await q.order('is_verified').order('external_product_code').limit(500)) as unknown as Row[]
    },
  })
  const options = useQuery({
    queryKey: ['options-with-tour', orgId],
    queryFn: async () => unwrap(await supabase.from('tour_options').select('id, name, code, tours(name)').eq('organization_id', orgId).is('deleted_at', null).order('code')) as unknown as Row[],
  })
  const save = useMutation({
    mutationFn: (v: Row) => rpcOk('mapping_save', {
      p_mapping: edit?.id ?? null, p_org: orgId, p_connection: v.connection_id, p_product: v.external_product_code,
      p_option: v.external_option_code ?? '', p_tour_option: v.tour_option_id ?? null, p_language: v.language ?? null,
      p_default_time: v.default_local_time || null, p_traveler_map: v.traveler_map ? JSON.parse(v.traveler_map) : {}, p_verified: Boolean(v.is_verified),
    }),
    onSuccess: (r) => {
      message.success(r.placed ? `Đã lưu, xếp được ${r.placed} booking đang chờ` : 'Đã lưu')
      setEdit(null)
      qc.invalidateQueries({ queryKey: ['mappings'] })
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (e: Error) => message.error(e.message.includes('JSON') ? 'Nhóm khách phải là JSON hợp lệ.' : e.message),
  })
  const open = (row: Row | null) => {
    form.resetFields()
    form.setFieldsValue(row ? { ...row, default_local_time: row.default_local_time ? String(row.default_local_time).slice(0, 5) : '', traveler_map: JSON.stringify(row.traveler_map ?? {}) } : { is_verified: false, traveler_map: '{"ADULT":"adult","CHILD":"child","INFANT":"infant"}' })
    setEdit(row ?? {})
  }
  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Booking chỉ được xếp theo ánh xạ đã kiểm tra, không bao giờ ghép theo tên. Mã lạ được giữ ở đây chờ xử lý, booking của nó vẫn được lưu." />
      <div className="filters">
        <Switch checked={onlyPending} onChange={(v) => setParams(v ? { tab: 'mappings', pending: '1' } : { tab: 'mappings' }, { replace: true })} /><span>Chỉ mã chưa kiểm tra</span>
        <div style={{ flex: 1 }} />
        <Can perm="connection.manage"><Button type="primary" onClick={() => open(null)}>Thêm ánh xạ</Button></Can>
      </div>
      <Table rowKey="id" size="small" loading={list.isLoading} dataSource={list.data} scroll={{ x: 'max-content' }} pagination={{ pageSize: 50, hideOnSinglePage: true }} locale={{ emptyText: <NoData text="Chưa có ánh xạ" /> }} columns={[
        { title: 'Tài khoản', render: (_, m) => `${CHANNEL[m.channel_connections?.channel] ?? ''} · ${m.channel_connections?.account_name}` },
        { title: 'Mã sản phẩm ngoài', dataIndex: 'external_product_code' },
        { title: 'Mã lựa chọn', dataIndex: 'external_option_code' },
        { title: 'Tour / gói nội bộ', render: (_, m) => m.tour_options ? `${m.tour_options.tours?.name} · ${m.tour_options.name}` : <Tag color="red">Chưa chọn</Tag> },
        { title: 'Ngôn ngữ', dataIndex: 'language' },
        { title: 'Giờ mặc định', render: (_, m) => String(m.default_local_time ?? '').slice(0, 5) },
        { title: 'Đã kiểm tra', render: (_, m) => (m.is_verified ? <Tag color="green">Đã kiểm tra</Tag> : <Tag color="gold">Chờ kiểm tra</Tag>) },
        { title: '', render: (_, m) => can('connection.manage') && <Button size="small" type="link" onClick={() => open(m)}>Sửa</Button> },
      ]} />
      <Drawer title="Ánh xạ sản phẩm" open={Boolean(edit)} onClose={() => setEdit(null)} width={480} extra={<Button type="primary" loading={save.isPending} onClick={() => form.submit()}>Lưu</Button>}>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item name="connection_id" label="Tài khoản kênh" rules={[{ required: true, message: 'Chọn tài khoản' }]}>
            <Select disabled={Boolean(edit?.id)} options={(connections.data ?? []).map((c) => ({ value: c.id, label: `${CHANNEL[c.channel]} · ${c.account_name}` }))} />
          </Form.Item>
          <Form.Item name="external_product_code" label="Mã sản phẩm bên ngoài" rules={[{ required: true, message: 'Nhập mã' }]}><Input disabled={Boolean(edit?.id)} /></Form.Item>
          <Form.Item name="external_option_code" label="Mã lựa chọn bên ngoài"><Input disabled={Boolean(edit?.id)} /></Form.Item>
          <Form.Item name="tour_option_id" label="Gói nội bộ"><Select allowClear showSearch optionFilterProp="label" options={(options.data ?? []).map((o) => ({ value: o.id, label: `${o.tours?.name} · ${o.name} (${o.code})` }))} /></Form.Item>
          <Form.Item name="language" label="Ngôn ngữ"><Input /></Form.Item>
          <Form.Item name="default_local_time" label="Giờ chạy khi nguồn không gửi giờ (HH:mm)" rules={[{ pattern: /^([01]\d|2[0-3]):[0-5]\d$/, message: 'Dạng 08:00' }]}><Input /></Form.Item>
          <Form.Item name="traveler_map" label="Nhóm khách tương ứng (JSON)"><Input.TextArea rows={2} className="mono" /></Form.Item>
          <Form.Item name="is_verified" label="Đã kiểm tra" valuePropName="checked" extra="Chỉ bật khi đã đối chiếu đúng sản phẩm. Bật xong, booking đang chờ của mã này sẽ được xếp chuyến."><Switch /></Form.Item>
        </Form>
      </Drawer>
    </>
  )
}

function EventsTab() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const [detail, setDetail] = useState<Row | null>(null)
  const status = params.get('status') ?? undefined
  const list = useQuery({
    queryKey: ['events', orgId, status],
    queryFn: async () => {
      let q = supabase.from('integration_events').select('*, channel_connections(account_name, channel)').eq('organization_id', orgId)
      if (status === 'failed') q = q.in('status', ['failed', 'dead'])
      else if (status) q = q.eq('status', status)
      const res = await q.order('received_at', { ascending: false }).limit(200)
      if (res.error) throw new Error(friendlyError(res.error))
      return res.data as unknown as Row[]
    },
  })
  const jobs = useQuery({
    queryKey: ['sync-jobs', orgId],
    queryFn: async () => unwrap(await supabase.from('sync_jobs').select('id, kind, status, attempts, last_error, detail, created_at, finished_at').eq('organization_id', orgId).order('created_at', { ascending: false }).limit(50)) as Row[],
  })
  const retry = useMutation({
    mutationFn: (id: string) => rpcOk('retry_event', { p_event: id }).catch((e: Error) => { throw e }),
    onSuccess: () => { message.success('Đã xử lý lại'); qc.invalidateQueries({ queryKey: ['events'] }) },
    onError: (e: Error) => { message.error(e.message); qc.invalidateQueries({ queryKey: ['events'] }) },
  })
  return (
    <>
      <div className="filters">
        <Select allowClear placeholder="Mọi trạng thái" style={{ minWidth: 200 }} value={status}
          options={[{ value: 'failed', label: 'Lỗi (chờ thử lại và cần xử lý tay)' }, ...Object.entries(EVENT_STATUS).map(([value, label]) => ({ value, label }))]}
          onChange={(v) => setParams(v ? { tab: 'events', status: v } : { tab: 'events' }, { replace: true })} />
      </div>
      {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : (
        <Table rowKey="id" size="small" loading={list.isLoading} dataSource={list.data} scroll={{ x: 'max-content' }} pagination={{ pageSize: 50, hideOnSinglePage: true }} locale={{ emptyText: <NoData text="Chưa có sự kiện" /> }} columns={[
          { title: 'Nhận lúc', render: (_, e) => <span className="nowrap">{fmtDateTime(e.received_at)}</span> },
          { title: 'Tài khoản', render: (_, e) => <>{e.channel_connections?.account_name}{e.is_simulated && <Tag color="purple" style={{ marginLeft: 4 }}>Mô phỏng</Tag>}</> },
          { title: 'Loại', dataIndex: 'event_type' },
          { title: 'Mã booking', dataIndex: 'external_ref' },
          { title: 'Phiên bản', dataIndex: 'source_version', align: 'right' },
          { title: 'Trạng thái', render: (_, e) => <EventStatusTag value={e.status} /> },
          { title: 'Lần thử', dataIndex: 'attempts', align: 'right' },
          { title: 'Nhận trùng', dataIndex: 'duplicate_count', align: 'right' },
          { title: 'Thứ tự', render: (_, e) => (e.ordering_verified ? '' : <Tooltip title="Nguồn không gửi phiên bản hay thời điểm: cần đối chiếu"><Tag color="gold">Chưa kiểm chứng</Tag></Tooltip>) },
          { title: 'Lỗi', render: (_, e) => e.last_error ? <span className="muted" style={{ fontSize: 12 }}>{String(e.last_error).slice(0, 60)}</span> : '' },
          { title: '', render: (_, e) => <Space size={0}>
            <Button size="small" type="link" onClick={() => setDetail(e)}>Chi tiết</Button>
            {can('connection.manage') && ['failed', 'dead'].includes(e.status) && <Button size="small" type="link" loading={retry.isPending} onClick={() => retry.mutate(e.id)}>Thử lại</Button>}
          </Space> },
        ]} />
      )}
      <h4 style={{ marginTop: 24 }}>Tác vụ nền</h4>
      <Table rowKey="id" size="small" loading={jobs.isLoading} dataSource={jobs.data} pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: <NoData text="Worker chưa ghi tác vụ nào" /> }} columns={[
        { title: 'Thời điểm', render: (_, j) => <span className="nowrap">{fmtDateTime(j.created_at)}</span> },
        { title: 'Loại', dataIndex: 'kind' },
        { title: 'Trạng thái', dataIndex: 'status' },
        { title: 'Chi tiết', render: (_, j) => <span className="mono">{JSON.stringify(j.detail)}</span> },
        { title: 'Lỗi', dataIndex: 'last_error' },
      ]} />
      <Modal title="Sự kiện" open={Boolean(detail)} onCancel={() => setDetail(null)} footer={null} width={720}>
        {detail && <>
          <p className="muted">Correlation ID: <span className="mono">{detail.correlation_id}</span></p>
          {detail.last_error && <Alert type="error" message={detail.last_error} style={{ marginBottom: 8 }} />}
          <pre className="payload">{JSON.stringify({ result: detail.result, payload: detail.payload }, null, 2)}</pre>
        </>}
      </Modal>
    </>
  )
}

export function ConnectionsPage() {
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'connections'
  return (
    <>
      <PageHead title="Kết nối kênh" />
      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'connections' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'connections', label: 'Tài khoản kênh', children: <ConnectionsTab /> },
          { key: 'mappings', label: 'Ghép mã sản phẩm', children: <MappingsTab /> },
          { key: 'events', label: 'Nhật ký đồng bộ', children: <EventsTab /> },
          ...(can('connection.simulate') ? [{ key: 'simulator', label: 'Bộ mô phỏng', children: <Simulator /> }] : []),
        ]} />
      </Card>
    </>
  )
}
