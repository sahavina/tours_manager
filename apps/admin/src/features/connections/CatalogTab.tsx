import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Radio, Select, Space, Switch, Table, Tag, Tooltip } from 'antd'
import { mockAvailability, mockCatalog } from '@tours/channels'
import { CHANNEL } from '@tours/core'
import dayjs from 'dayjs'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { Can, ConnectionBadge, ErrorState, fmtDate, fmtDateTime, NoData } from '../../components/common'
import { CONNECTION_COLUMNS, rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

const REVIEW_FIELDS: Array<{ key: string; label: string }> = [
  { key: 'title', label: 'Tên' },
  { key: 'description', label: 'Mô tả' },
  { key: 'destination', label: 'Điểm đến' },
  { key: 'duration_minutes', label: 'Thời lượng (phút)' },
  { key: 'language', label: 'Ngôn ngữ' },
]

const STATUS_FILTERS = [
  { value: 'all', label: 'Tất cả' },
  { value: 'unlinked', label: 'Chưa ghép' },
  { value: 'changed', label: 'Có thay đổi' },
  { value: 'linked', label: 'Đã ghép' },
  { value: 'ignored', label: 'Bỏ qua' },
  { value: 'removed', label: 'Đã gỡ' },
]

function statusOf(p: Row): string[] {
  const s: string[] = []
  if (p.removed_at) s.push('removed')
  if (p.is_ignored) s.push('ignored')
  else if (!p.tour_option_id) s.push('unlinked')
  else s.push('linked')
  if (p.has_changes) s.push('changed')
  return s
}

function useInvalidate() {
  const qc = useQueryClient()
  return () => {
    for (const k of ['channel-products', 'catalog-connections', 'mappings', 'tours', 'tour_options', 'tours-lite', 'options-with-tour', 'catalog-tree', 'departures', 'bookings', 'availability-compare']) {
      qc.invalidateQueries({ queryKey: [k] })
    }
  }
}

function CreateModal({ product, onClose }: { product: Row; onClose: () => void }) {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const invalidate = useInvalidate()
  const [form] = Form.useForm()
  const mode = Form.useWatch('mode', form)
  const tours = useQuery({
    queryKey: ['tours-lite', orgId],
    queryFn: async () => unwrap(await supabase.from('tours').select('id, name').eq('organization_id', orgId).is('deleted_at', null).order('name')) as Row[],
  })
  const suggested = product.external_product_code.replace(/[^A-Za-z0-9]+/g, '-')
  const create = useMutation({
    mutationFn: (v: Row) => rpcOk('channel_catalog_create_internal', {
      p_product: product.id, p_tour: v.mode === 'existing' ? v.tour_id : null,
      p_tour_code: v.tour_code ?? '', p_option_code: v.option_code,
    }),
    onSuccess: (r) => {
      message.success(r.placed ? `Đã tạo, xếp được ${r.placed} booking đang chờ` : 'Đã tạo tour và gói')
      invalidate()
      onClose()
    },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <Modal title={`Tạo từ: ${product.title ?? product.external_product_code}`} open onCancel={onClose} onOk={() => form.submit()} okText="Tạo" cancelText="Đóng" confirmLoading={create.isPending}>
      <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)} initialValues={{ mode: 'new', tour_code: suggested, option_code: `${suggested}-OPT` }}>
        <Form.Item name="mode"><Radio.Group options={[{ value: 'new', label: 'Tạo tour mới' }, { value: 'existing', label: 'Thêm gói vào tour có sẵn' }]} /></Form.Item>
        {mode === 'existing'
          ? <Form.Item name="tour_id" label="Tour" rules={[{ required: true, message: 'Chọn tour' }]}><Select showSearch optionFilterProp="label" options={(tours.data ?? []).map((t) => ({ value: t.id, label: t.name }))} /></Form.Item>
          : <Form.Item name="tour_code" label="Mã tour" rules={[{ required: true, message: 'Nhập mã' }]}><Input /></Form.Item>}
        <Form.Item name="option_code" label="Mã gói" rules={[{ required: true, message: 'Nhập mã' }]}><Input /></Form.Item>
        {!product.latest?.timezone && <Alert type="info" showIcon message="Kênh không gửi múi giờ, tour dùng múi giờ của doanh nghiệp. Hãy kiểm tra lại sau khi tạo." />}
      </Form>
    </Modal>
  )
}

function LinkModal({ product, onClose }: { product: Row; onClose: () => void }) {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const invalidate = useInvalidate()
  const [option, setOption] = useState<string>()
  const options = useQuery({
    queryKey: ['options-with-tour', orgId],
    queryFn: async () => unwrap(await supabase.from('tour_options').select('id, name, code, tours(name)').eq('organization_id', orgId).is('deleted_at', null).order('code')) as unknown as Row[],
  })
  const link = useMutation({
    mutationFn: () => rpcOk('channel_catalog_link', { p_product: product.id, p_option: option }),
    onSuccess: (r) => {
      message.success(r.placed ? `Đã ghép, xếp được ${r.placed} booking đang chờ` : 'Đã ghép')
      invalidate()
      onClose()
    },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <Modal title={`Ghép: ${product.title ?? product.external_product_code}`} open onCancel={onClose} onOk={() => link.mutate()} okText="Ghép" cancelText="Đóng" okButtonProps={{ disabled: !option }} confirmLoading={link.isPending}>
      <p className="muted">Hãy đối chiếu đúng sản phẩm. Ghép xong, các booking đang chờ của mã này sẽ được xếp chuyến.</p>
      <Select style={{ width: '100%' }} showSearch optionFilterProp="label" placeholder="Chọn gói nội bộ" value={option} onChange={setOption}
        options={(options.data ?? []).map((o) => ({ value: o.id, label: `${o.tours?.name} · ${o.name} (${o.code})` }))} />
    </Modal>
  )
}

function ReviewModal({ product, onClose }: { product: Row; onClose: () => void }) {
  const { message } = App.useApp()
  const { can } = useAuth()
  const invalidate = useInvalidate()
  const diffs = REVIEW_FIELDS.filter((f) => (product.baseline?.[f.key] ?? null) !== (product.latest?.[f.key] ?? null))
  const [fields, setFields] = useState<string[]>([])
  const review = useMutation({
    mutationFn: () => rpcOk('channel_catalog_review', { p_product: product.id, p_fields: fields }),
    onSuccess: () => {
      message.success(fields.length ? `Đã áp dụng ${fields.length} trường vào tour nội bộ` : 'Đã giữ nguyên bản nội bộ')
      invalidate()
      onClose()
    },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <Modal title={`Thay đổi từ kênh: ${product.external_product_code}`} open onCancel={onClose} width={720} footer={[
      <Button key="c" onClick={onClose}>Đóng</Button>,
      can('catalog.manage') && <Button key="o" type="primary" loading={review.isPending} onClick={() => review.mutate()}>{fields.length ? `Áp dụng ${fields.length} trường` : 'Giữ nguyên bản nội bộ'}</Button>,
    ]}>
      <p className="muted">Tour nội bộ chưa bị đổi. Chọn trường muốn lấy theo kênh, trường không chọn giữ nguyên.</p>
      {diffs.length === 0 && <Alert type="info" message="Khác biệt nằm ở trường không hiển thị (giờ chạy, nhóm khách, trạng thái). Xác nhận để đánh dấu đã xem." />}
      <Table rowKey="key" size="small" pagination={false} dataSource={diffs} scroll={{ x: 'max-content' }}
        rowSelection={can('catalog.manage') ? { selectedRowKeys: fields, onChange: (k) => setFields(k as string[]) } : undefined}
        columns={[
          { title: 'Trường', dataIndex: 'label' },
          { title: 'Bản đã chấp nhận', render: (_, f) => String(product.baseline?.[f.key] ?? '(trống)') },
          { title: 'Bản mới trên kênh', render: (_, f) => product.latest?.[f.key] == null ? <span className="muted">Kênh không gửi: sẽ không xóa dữ liệu nội bộ</span> : String(product.latest[f.key]) },
        ]} />
    </Modal>
  )
}

function AvailabilityModal({ product, onClose }: { product: Row; onClose: () => void }) {
  const { can } = useAuth()
  const { message } = App.useApp()
  const invalidate = useInvalidate()
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs(), dayjs().add(14, 'day')])
  const [capacity, setCapacity] = useState<number | null>(null)
  const from = range[0].format('YYYY-MM-DD')
  const to = range[1].format('YYYY-MM-DD')
  const q = useQuery({
    queryKey: ['availability-compare', product.id, from, to],
    queryFn: () => rpc<Row[]>('channel_availability_compare', { p_product: product.id, p_from: from, p_to: to }),
  })
  const missing = (q.data ?? []).filter((r) => !r.departure_id && r.status !== 'closed').length
  const create = useMutation({
    mutationFn: () => rpcOk('channel_availability_create_departures', { p_product: product.id, p_from: from, p_to: to, p_capacity: capacity }),
    onSuccess: (r) => {
      message.success(`Đã tạo ${r.created} chuyến, bỏ qua ${r.skipped} chuyến đã có`)
      invalidate()
    },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <Modal title={`Lịch trên kênh: ${product.title ?? product.external_product_code}`} open onCancel={onClose} footer={null} width={760}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Số chỗ của kênh chỉ để đối chiếu, không làm thay đổi sức chứa nội bộ." />
      <div className="filters">
        <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={range} onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} />
      </div>
      {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <Table rowKey={(r) => `${r.local_date}-${r.local_time}`} size="small" loading={q.isLoading} dataSource={q.data} pagination={{ pageSize: 10, hideOnSinglePage: true }} scroll={{ x: 'max-content' }}
          locale={{ emptyText: <NoData text="Kênh chưa gửi lịch cho sản phẩm này" /> }} columns={[
            { title: 'Ngày', render: (_, r) => fmtDate(r.local_date) },
            { title: 'Giờ', render: (_, r) => String(r.local_time).slice(0, 5) },
            { title: 'Chỗ trên kênh', align: 'right', render: (_, r) => r.vacancies ?? <span className="muted">Không rõ</span> },
            { title: 'Chỗ nội bộ', align: 'right', render: (_, r) => r.departure_id ? <Link to={`/operations/${r.departure_id}`}>{r.internal_available}</Link> : <Tag color="orange">Chưa có chuyến</Tag> },
            { title: 'Chênh lệch', align: 'right', render: (_, r) => {
              if (r.internal_available == null || r.vacancies == null) return ''
              const d = r.vacancies - r.internal_available
              return d === 0 ? <Tag color="green">Khớp</Tag> : <span style={{ color: d > 0 ? '#dc2626' : undefined }}>{d > 0 ? `+${d}` : d}</span>
            } },
          ]} />
      )}
      {can('departure.manage') && product.tour_option_id && missing > 0 && (
        <Space wrap style={{ marginTop: 12 }}>
          <span>Tạo {missing} chuyến còn thiếu, sức chứa mỗi chuyến:</span>
          <InputNumber min={0} value={capacity} onChange={setCapacity} placeholder="Bắt buộc" />
          <Button type="primary" disabled={capacity == null} loading={create.isPending} onClick={() => create.mutate()}>Tạo chuyến</Button>
          <span className="muted">Số chỗ trống của kênh không phải sức chứa, nên cần bạn nhập.</span>
        </Space>
      )}
      {!product.tour_option_id && <Alert type="warning" showIcon style={{ marginTop: 12 }} message="Hãy ghép sản phẩm với gói nội bộ trước khi tạo chuyến." />}
    </Modal>
  )
}

export function CatalogTab() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const invalidate = useInvalidate()
  const [connectionId, setConnectionId] = useState<string>()
  const [status, setStatus] = useState('all')
  const [modal, setModal] = useState<{ kind: 'create' | 'link' | 'review' | 'availability'; product: Row } | null>(null)

  const connections = useQuery({
    queryKey: ['catalog-connections', orgId],
    queryFn: async () => unwrap(await supabase.from('channel_connections').select(CONNECTION_COLUMNS).eq('organization_id', orgId).neq('channel', 'manual').order('created_at')) as unknown as Row[],
  })
  const connection = connections.data?.find((c) => c.id === connectionId) ?? connections.data?.[0]
  const isMock = connection?.mode === 'mock'
  const syncable = isMock && (connection?.channel === 'viator' || connection?.channel === 'getyourguide')

  const products = useQuery({
    queryKey: ['channel-products', connection?.id],
    enabled: Boolean(connection),
    queryFn: async () => unwrap(await supabase.from('channel_products')
      .select('id, connection_id, external_product_code, external_option_code, title, product_status, latest, baseline, tour_option_id, is_ignored, has_changes, last_seen_at, last_changed_at, removed_at, tour_options(name, code, tours(name))')
      .eq('connection_id', connection!.id).order('external_product_code').limit(500)) as unknown as Row[],
  })
  const rows = (products.data ?? []).filter((p) => status === 'all' || statusOf(p).includes(status))
  const count = (s: string) => (products.data ?? []).filter((p) => statusOf(p).includes(s)).length

  const syncNow = useMutation({
    mutationFn: async () => {
      const list = mockCatalog(connection!.channel, connection!.mock_catalog_version)
      const r = await rpcOk('channel_catalog_ingest', { p_connection: connection!.id, p_products: list, p_complete: true })
      await rpcOk('channel_availability_ingest', { p_connection: connection!.id, p_items: mockAvailability(list, new Date()) })
      return r
    },
    onSuccess: (r) => {
      message.success(`Mô phỏng xong: ${r.created} mới, ${r.changed} đổi, ${r.removed} đã gỡ, ${r.unchanged} không đổi`)
      invalidate()
    },
    onError: (e: Error) => message.error(e.message),
  })
  const bump = useMutation({
    mutationFn: async () => {
      await rpcOk('channel_mock_bump_catalog', { p_connection: connection!.id })
      const list = mockCatalog(connection!.channel, connection!.mock_catalog_version + 1)
      const r = await rpcOk('channel_catalog_ingest', { p_connection: connection!.id, p_products: list, p_complete: true })
      await rpcOk('channel_availability_ingest', { p_connection: connection!.id, p_items: mockAvailability(list, new Date()) })
      return r
    },
    onSuccess: (r) => {
      message.success(`Kênh mô phỏng đã đổi: ${r.created} mới, ${r.changed} đổi, ${r.removed} đã gỡ`)
      invalidate()
    },
    onError: (e: Error) => message.error(e.message),
  })
  const settings = useMutation({
    mutationFn: (patch: Row) => rpcOk('connection_update', { p_connection: connection!.id, p_patch: patch }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  })
  const ignore = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) => rpcOk('channel_catalog_ignore', { p_product: id, p_ignored: value }),
    onSuccess: invalidate,
    onError: (e: Error) => message.error(e.message),
  })

  const manage = can('connection.manage')
  const canCreate = manage && can('catalog.manage')

  return (
    <>
      {isMock && <div className="mock-banner">Đang <b>mô phỏng</b>: danh sách dưới đây là sản phẩm giả có mã <b>SIM</b>, không lấy từ tài khoản Viator của bạn.</div>}
      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Kết nối thật với Viator chưa hoạt động" description={
        <>Cần được Viator cấp quyền. Theo tài liệu Supplier API: danh mục chỉ có endpoint Beta với mã, tên, trạng thái; lịch và số chỗ không kéo về được vì hệ thống của bạn mới là nguồn số chỗ. Xem <span className="mono">docs/CHANNEL_INTEGRATION.md</span>.</>
      } />

      <div className="filters">
        <Select style={{ minWidth: 260 }} placeholder="Tài khoản kênh" value={connection?.id} onChange={setConnectionId} loading={connections.isLoading}
          options={(connections.data ?? []).map((c) => ({ value: c.id, label: `${CHANNEL[c.channel] ?? c.channel} · ${c.account_name}` }))} />
        {connection && <ConnectionBadge mode={connection.mode} status={connection.status} />}
        <div style={{ flex: 1 }} />
        <Can perm="connection.simulate">
          <Tooltip title={syncable ? undefined : 'Chưa có connector thật cho kết nối này'}>
            <Button type="primary" disabled={!syncable} loading={syncNow.isPending} onClick={() => syncNow.mutate()}>Đồng bộ ngay</Button>
          </Tooltip>
          {syncable && <Button loading={bump.isPending} onClick={() => bump.mutate()}>Mô phỏng kênh đổi danh mục</Button>}
        </Can>
      </div>

      {connection && (
        <div className="filters">
          <Space wrap>
            <span>Tự động đồng bộ</span>
            <Switch checked={connection.catalog_sync_enabled} disabled={!manage} loading={settings.isPending} onChange={(v) => settings.mutate({ catalog_sync_enabled: v })} />
            <span>mỗi</span>
            <InputNumber min={5} step={30} style={{ width: 90 }} key={connection.catalog_sync_interval_minutes} disabled={!manage} defaultValue={connection.catalog_sync_interval_minutes}
              onBlur={(e) => { const n = Number(e.target.value); if (n >= 5 && n !== connection.catalog_sync_interval_minutes) settings.mutate({ catalog_sync_interval_minutes: n }) }} />
            <span>phút</span>
          </Space>
          <span className="muted">
            {connection.catalog_last_synced_at ? `Đồng bộ gần nhất: ${fmtDateTime(connection.catalog_last_synced_at)}${isMock ? ' (mô phỏng)' : ''}` : 'Chưa đồng bộ lần nào'}
          </span>
          {connection.catalog_last_error && <Tag color="red">{connection.catalog_last_error}</Tag>}
        </div>
      )}

      <div className="filters">
        <Radio.Group optionType="button" size="small" value={status} onChange={(e) => setStatus(e.target.value)}
          options={STATUS_FILTERS.map((s) => ({ value: s.value, label: s.value === 'all' ? s.label : `${s.label} (${count(s.value)})` }))} />
      </div>

      {products.isError ? <ErrorState error={products.error} onRetry={() => products.refetch()} /> : (
        <Table rowKey="id" size="small" loading={products.isLoading} dataSource={rows} scroll={{ x: 'max-content' }} pagination={{ pageSize: 50, hideOnSinglePage: true }}
          locale={{ emptyText: <NoData text={(products.data ?? []).length ? 'Không có sản phẩm ở trạng thái này' : 'Chưa có sản phẩm. Bấm Đồng bộ ngay, hoặc chờ lượt tự động.'} /> }}
          columns={[
            { title: 'Mã kênh', render: (_, p) => <span className="mono">{p.external_product_code}{p.external_option_code ? ` / ${p.external_option_code}` : ''}</span> },
            { title: 'Tên trên kênh', render: (_, p) => p.title ?? <span className="muted">Kênh không gửi</span> },
            { title: 'Gói nội bộ', render: (_, p) => p.tour_options
              ? <div style={{ maxWidth: 240, whiteSpace: 'normal' }}>{p.tour_options.tours?.name}<div className="muted" style={{ fontSize: 12 }}>{p.tour_options.code}</div></div>
              : <span className="muted">Chưa ghép</span> },
            { title: 'Trạng thái', render: (_, p) => <Space size={2} wrap>
              {p.removed_at && <Tag color="red">Đã gỡ khỏi kênh</Tag>}
              {p.is_ignored && <Tag>Bỏ qua</Tag>}
              {!p.is_ignored && !p.tour_option_id && <Tag color="gold">Chưa ghép</Tag>}
              {p.tour_option_id && <Tag color="green">Đã ghép</Tag>}
              {p.has_changes && <Tag color="orange">Có thay đổi</Tag>}
            </Space> },
            { title: 'Thấy gần nhất', render: (_, p) => <span className="nowrap">{fmtDateTime(p.last_seen_at)}</span> },
            { title: '', fixed: 'right' as const, render: (_, p) => <Space size={0}>
              {p.has_changes && <Button size="small" type="link" onClick={() => setModal({ kind: 'review', product: p })}>Xem thay đổi</Button>}
              {!p.tour_option_id && canCreate && <Button size="small" type="link" onClick={() => setModal({ kind: 'create', product: p })}>Tạo tour và gói</Button>}
              {!p.tour_option_id && manage && <Button size="small" type="link" onClick={() => setModal({ kind: 'link', product: p })}>Ghép</Button>}
              {can('departure.read') && <Button size="small" type="link" onClick={() => setModal({ kind: 'availability', product: p })}>Lịch</Button>}
              {!p.tour_option_id && manage && <Checkbox style={{ marginLeft: 8 }} checked={p.is_ignored} onChange={(e) => ignore.mutate({ id: p.id, value: e.target.checked })}>Bỏ qua</Checkbox>}
            </Space> },
          ]} />
      )}

      {modal?.kind === 'create' && <CreateModal product={modal.product} onClose={() => setModal(null)} />}
      {modal?.kind === 'link' && <LinkModal product={modal.product} onClose={() => setModal(null)} />}
      {modal?.kind === 'review' && <ReviewModal product={modal.product} onClose={() => setModal(null)} />}
      {modal?.kind === 'availability' && <AvailabilityModal product={modal.product} onClose={() => setModal(null)} />}
    </>
  )
}
