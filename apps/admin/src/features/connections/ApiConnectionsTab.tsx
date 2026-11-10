// Tab "Kết nối API": từng bước để nối GetYourGuide và Viator qua API thật. Mỗi bước được tick theo dữ liệu
// có thật trong hệ thống, không có bước nào tự báo "xong" khi chưa kiểm chứng được.
import { CheckCircleFilled, ClockCircleOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Col, Form, Input, InputNumber, Modal, Row as GridRow, Select, Space, Table, Tag, Typography } from 'antd'
import { APPROVAL_STATUS, CHANNEL } from '@tours/core'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { Can, ConnectionBadge, fmtDateTime } from '../../components/common'
import { CONNECTION_COLUMNS, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

type Channel = 'getyourguide' | 'viator'
type StepState = 'done' | 'todo' | 'blocked'
type Step = { title: string; state: StepState; detail: React.ReactNode }

// Endpoint theo tài liệu từng kênh. "built" là phần đã có code và test trong repo, không phải đã chạy với kênh.
const ENDPOINTS: Record<Channel, { dir: 'in' | 'out'; path: string; what: string; required: boolean; built: boolean }[]> = {
  getyourguide: [
    { dir: 'in', path: 'GET /1/get-availabilities/', what: 'Hỏi số chỗ', required: true, built: true },
    { dir: 'in', path: 'POST /1/reserve/', what: 'Giữ chỗ', required: true, built: true },
    { dir: 'in', path: 'POST /1/cancel-reservation/', what: 'Hủy giữ chỗ', required: true, built: true },
    { dir: 'in', path: 'POST /1/book/', what: 'Đặt chỗ', required: true, built: true },
    { dir: 'in', path: 'POST /1/cancel-booking/', what: 'Hủy booking', required: true, built: true },
    { dir: 'in', path: 'GET /1/suppliers/{id}/products/', what: 'Danh sách sản phẩm', required: false, built: true },
    { dir: 'out', path: 'POST /1/notify-availability-update', what: 'Báo số chỗ thay đổi', required: true, built: true },
    { dir: 'in', path: 'POST /1/notify/', what: 'Nhận báo sản phẩm bị tắt', required: false, built: false },
    { dir: 'out', path: 'POST /1/redeem-booking', what: 'Xác nhận khách đã đi', required: false, built: false },
  ],
  viator: [
    { dir: 'in', path: 'POST /tourlist', what: 'Danh sách sản phẩm và option', required: true, built: false },
    { dir: 'in', path: 'POST /v2/availability/check', what: 'Kiểm tra chỗ khi khách đặt', required: true, built: false },
    { dir: 'in', path: 'POST /v2/availability/calendar', what: 'Lịch chỗ và giá dài hạn', required: true, built: false },
    { dir: 'in', path: 'POST /v2/reserve', what: 'Giữ chỗ', required: true, built: false },
    { dir: 'in', path: 'POST /booking', what: 'Đặt chỗ', required: true, built: false },
    { dir: 'in', path: 'POST /booking-amendment', what: 'Sửa booking', required: false, built: false },
    { dir: 'in', path: 'POST /booking-cancellation', what: 'Hủy booking', required: true, built: false },
    { dir: 'out', path: 'POST /v2/notification/events', what: 'Báo thay đổi chỗ, giá', required: false, built: false },
  ],
}

const ICON: Record<StepState, React.ReactNode> = {
  done: <CheckCircleFilled style={{ color: '#52c41a' }} />,
  todo: <ClockCircleOutlined style={{ color: '#faad14' }} />,
  blocked: <MinusCircleOutlined style={{ color: '#bfbfbf' }} />,
}

function useApiConnections() {
  const { orgId } = useAuth()
  return useQuery({
    queryKey: ['connections', orgId, 'api'],
    queryFn: async () =>
      unwrap(
        await supabase.from('channel_connections').select(`${CONNECTION_COLUMNS}, endpoint_url`).eq('organization_id', orgId)
          .in('channel', ['getyourguide', 'viator']).eq('is_api', true).order('created_at'),
      ) as unknown as Row[],
  })
}

/** Số liệu kiểm chứng cho từng bước: ánh xạ đã kiểm tra, lần báo chỗ gần nhất. */
function useEvidence(conn: Row) {
  return useQuery({
    queryKey: ['api-evidence', conn.id],
    queryFn: async () => {
      const [maps, push] = await Promise.all([
        supabase.from('channel_product_mappings').select('id', { count: 'exact', head: true }).eq('connection_id', conn.id).eq('is_verified', true),
        supabase.from('sync_jobs').select('status, detail, created_at').eq('connection_id', conn.id).eq('kind', 'availability_push').order('created_at', { ascending: false }).limit(1),
      ])
      if (maps.error) throw maps.error
      if (push.error) throw push.error
      return { verifiedMappings: maps.count ?? 0, lastPush: (push.data?.[0] ?? null) as Row | null }
    },
  })
}

/** Gọi /health của cổng. Chỉ chứng minh cổng đang chạy, không chứng minh kênh đã gọi được. */
function useHealth(url: string | null) {
  const [state, setState] = useState<{ ok: boolean; at: Date; note: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const check = async () => {
    if (!url) return
    setLoading(true)
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(8000) })
      setState({ ok: res.ok, at: new Date(), note: res.ok ? 'Cổng trả lời' : `HTTP ${res.status}` })
    } catch {
      setState({ ok: false, at: new Date(), note: 'Không gọi được cổng (chưa deploy, sai địa chỉ hoặc bị chặn)' })
    } finally {
      setLoading(false)
    }
  }
  // Tự kiểm tra khi mở trang hoặc đổi địa chỉ, để bước "Deploy cổng" phản ánh tình trạng hiện tại.
  useEffect(() => {
    setState(null)
    if (url) void check()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
  return { state, loading, check }
}

function gygSteps(c: Row, ev: ReturnType<typeof useEvidence>['data'], healthOk: boolean | undefined): Step[] {
  const pushOk = ev?.lastPush?.detail?.outcome === 'sent'
  return [
    { title: 'Đăng ký tài khoản ở cổng Integrator', state: ['pending', 'approved'].includes(c.approval_status) ? 'done' : 'todo',
      detail: <>Doanh nghiệp tự đăng ký tại <a href="https://integrator.getyourguide.com/signup" target="_blank" rel="noreferrer">integrator.getyourguide.com</a> (cần tên pháp nhân). Xong thì đặt "Phê duyệt" là Đang chờ.</> },
    { title: 'Mã nhà cung cấp GetYourGuide', state: c.supplier_account_ref ? 'done' : 'todo',
      detail: c.supplier_account_ref ? <>Đã khai: <span className="mono">{c.supplier_account_ref}</span></> : 'Lấy từ cổng nhà cung cấp GetYourGuide, điền ở mục Cấu hình.' },
    { title: 'Ghép mã sản phẩm (productId = mã gói)', state: (ev?.verifiedMappings ?? 0) > 0 ? 'done' : 'todo',
      detail: <>{ev?.verifiedMappings ?? 0} mã đã kiểm tra. <Link to="/connections?tab=mappings">Xem ghép mã</Link></> },
    // Chỉ tick khi cổng đã trả lời thật, không tick vì đã điền địa chỉ.
    { title: 'Deploy cổng và khai địa chỉ', state: c.endpoint_url && healthOk === true ? 'done' : 'todo',
      detail: c.endpoint_url
        ? <>Cổng: <span className="mono">{c.endpoint_url}</span>{healthOk === false && <Tag color="red" style={{ marginLeft: 6 }}>Không trả lời</Tag>}{healthOk === undefined && <Tag style={{ marginLeft: 6 }}>Đang kiểm tra</Tag>}</>
        : <>Chạy <span className="mono">node --env-file=.env.cloud scripts/deploy-gyg-gateway.mjs</span>, rồi dán URL Worker vào mục Cấu hình.</> },
    { title: 'Khai địa chỉ và mật khẩu trên cổng Integrator', state: c.last_success_at ? 'done' : c.endpoint_url ? 'todo' : 'blocked',
      detail: c.last_success_at ? `GetYourGuide gọi thành công lần gần nhất ${fmtDateTime(c.last_success_at)}` : 'Bạn tự điền URL cổng và cặp GYG_INBOUND_* (trong .env.cloud). Bước này tự tick khi GetYourGuide giữ hoặc đặt chỗ thành công.' },
    { title: 'Worker báo số chỗ cho GetYourGuide', state: pushOk ? 'done' : ev?.lastPush ? 'todo' : 'blocked',
      detail: ev?.lastPush ? `Lần gần nhất ${fmtDateTime(ev.lastPush.created_at)}: ${ev.lastPush.detail?.outcome ?? ev.lastPush.status}` : 'Chưa gửi lần nào. Cần GYG_API_BASE, GYG_API_USERNAME, GYG_API_PASSWORD cho tour-worker.' },
    { title: 'Chuyển Production', state: c.mode === 'production' ? 'done' : c.approval_status === 'approved' ? 'todo' : 'blocked',
      detail: c.mode === 'production' ? 'Đang chạy Production.' : 'Chỉ chuyển khi GetYourGuide đã duyệt và chạy thử ổn.' },
  ]
}

function viatorSteps(c: Row): Step[] {
  const approved = c.approval_status === 'approved'
  return [
    { title: 'Gửi email supplierAPI@viator.com xin kết nối', state: ['pending', 'approved'].includes(c.approval_status) ? 'done' : 'todo',
      detail: 'Từ tài khoản doanh nghiệp, nêu mã nhà cung cấp và đề nghị họp khởi động. Gửi xong thì đặt "Phê duyệt" là Đang chờ.' },
    { title: 'Mã nhà cung cấp Viator', state: c.supplier_account_ref ? 'done' : 'todo',
      detail: c.supplier_account_ref ? <>Đã khai: <span className="mono">{c.supplier_account_ref}</span></> : 'Ví dụ 5613730 hoặc 5567092, điền ở mục Cấu hình.' },
    { title: 'Viator duyệt và họp khởi động', state: approved ? 'done' : 'blocked',
      detail: 'Theo điều khoản của Viator, chỉ bắt đầu viết cổng sau bước này.' },
    { title: 'Viết cổng Viator', state: 'blocked', detail: 'Chưa làm. Dùng lại lõi giữ chỗ, đặt chỗ của cổng GetYourGuide.' },
    { title: 'Viator dựng môi trường thử, chạy chứng nhận', state: 'blocked', detail: 'Viator cấu hình và chạy thử qua email.' },
    { title: 'Chuyển Production', state: c.mode === 'production' ? 'done' : 'blocked', detail: 'Viator bật cho vài sản phẩm trước rồi mới mở hết.' },
  ]
}

function ConnectionCard({ c }: { c: Row }) {
  const { can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const channel = c.channel as Channel
  const ev = useEvidence(c)
  const health = useHealth(c.endpoint_url ?? null)
  const save = useMutation({
    mutationFn: (v: Row) => rpcOk('connection_update', { p_connection: c.id, p_patch: v }),
    onSuccess: () => { message.success('Đã lưu cấu hình'); qc.invalidateQueries({ queryKey: ['connections'] }); qc.invalidateQueries({ queryKey: ['api-evidence', c.id] }) },
    onError: (e: Error) => message.error(e.message),
  })
  const steps = channel === 'getyourguide' ? gygSteps(c, ev.data, health.state?.ok) : viatorSteps(c)
  const done = steps.filter((s) => s.state === 'done').length

  return (
    <Card style={{ marginBottom: 16 }} title={<Space wrap>{CHANNEL[channel]} · {c.account_name}<ConnectionBadge mode={c.mode} status={c.status} /><Tag>{done}/{steps.length} bước</Tag></Space>}>
      {channel === 'viator' && (
        <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Viator chỉ cho phát triển sau khi duyệt"
          description="Tài liệu Viator: quyền API dành cho nhà tổ chức tour và reservation system được họ cho phép, sau khi đánh giá kỹ thuật và phê duyệt chính thức. Không có môi trường thử tự phục vụ." />
      )}
      <GridRow gutter={24}>
        <Col xs={24} lg={14}>
          <Typography.Title level={5}>Các bước</Typography.Title>
          <Table rowKey="title" size="small" pagination={false} loading={ev.isLoading} dataSource={steps} showHeader={false} columns={[
            { width: 28, render: (_, s: Step) => ICON[s.state] },
            { render: (_, s: Step) => <><div style={{ fontWeight: 500 }}>{s.title}</div><div className="muted" style={{ fontSize: 12 }}>{s.detail}</div></> },
          ]} />
          {channel === 'getyourguide' && (
            <Space style={{ marginTop: 12 }}>
              <Button onClick={health.check} loading={health.loading} disabled={!c.endpoint_url}>Kiểm tra cổng</Button>
              {health.state && <Tag color={health.state.ok ? 'green' : 'red'}>{health.state.note} · {health.state.at.toLocaleTimeString('vi-VN')}</Tag>}
            </Space>
          )}
        </Col>
        <Col xs={24} lg={10}>
          <Typography.Title level={5}>Cấu hình</Typography.Title>
          <Form form={form} layout="vertical" size="small" disabled={!can('connection.manage')}
            // Tên bí mật không đọc lại được từ database; để trống nghĩa là giữ nguyên.
            onFinish={({ credential_ref, ...v }) => save.mutate(credential_ref?.trim() ? { ...v, credential_ref: credential_ref.trim() } : v)}
            initialValues={{ approval_status: c.approval_status, supplier_account_ref: c.supplier_account_ref ?? '', endpoint_url: c.endpoint_url ?? '', credential_ref: '', hold_ttl_seconds: c.hold_ttl_seconds }}>
            <Form.Item name="approval_status" label="Phê duyệt của kênh"><Select options={Object.entries(APPROVAL_STATUS).filter(([k]) => k !== 'not_required').map(([value, label]) => ({ value, label }))} /></Form.Item>
            <Form.Item name="supplier_account_ref" label={`Mã nhà cung cấp ${CHANNEL[channel]}`}><Input autoComplete="off" /></Form.Item>
            <Form.Item name="endpoint_url" label="Địa chỉ cổng (https)" rules={[{ pattern: /^(https:\/\/\S+)?$/, message: 'Phải bắt đầu bằng https://' }]}
              extra={channel === 'viator' ? 'Chưa có cổng Viator.' : 'URL của Worker saha-tour-hub-gyg sau khi deploy.'}>
              <Input placeholder="https://saha-tour-hub-gyg.<tài khoản>.workers.dev" autoComplete="off" />
            </Form.Item>
            <Form.Item name="credential_ref" label={`Tên bí mật ${c.has_credentials ? '(đã khai)' : '(chưa khai)'}`}
              extra="Chỉ ghi TÊN, ví dụ GYG_INBOUND_PASSWORD. Không dán mật khẩu hay khóa vào đây. Để trống là giữ nguyên.">

              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item name="hold_ttl_seconds" label="Giữ chỗ (giây)" extra={channel === 'getyourguide' ? 'GetYourGuide mong 3600, tối thiểu 900.' : 'Tối thiểu 900.'}>
              <InputNumber min={900} max={86400} style={{ width: '100%' }} />
            </Form.Item>
            <Can perm="connection.manage"><Button type="primary" htmlType="submit" loading={save.isPending}>Lưu cấu hình</Button></Can>
          </Form>
        </Col>
      </GridRow>
      <Typography.Title level={5} style={{ marginTop: 16 }}>Endpoint</Typography.Title>
      <Table rowKey="path" size="small" pagination={false} dataSource={ENDPOINTS[channel]} scroll={{ x: 'max-content' }} columns={[
        { title: 'Chiều', render: (_, e) => (e.dir === 'in' ? `${CHANNEL[channel]} gọi vào` : `Mình gọi ${CHANNEL[channel]}`) },
        { title: 'Endpoint', render: (_, e) => <span className="mono">{e.path}</span> },
        { title: 'Việc', dataIndex: 'what' },
        { title: 'Bắt buộc', render: (_, e) => (e.required ? 'Có' : '') },
        { title: 'Trong hệ thống', render: (_, e) => (e.built ? <Tag color="blue">Đã có code, chưa thử với kênh</Tag> : <Tag>Chưa làm</Tag>) },
      ]} />
    </Card>
  )
}

export function ApiConnectionsTab() {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const list = useApiConnections()
  const [creating, setCreating] = useState<Channel | null>(null)
  const [form] = Form.useForm()
  const create = useMutation({
    mutationFn: (v: Row) => rpcOk('api_connection_create', { p_org: orgId, p_channel: creating, p_account: v.account_name }),
    onSuccess: () => { message.success('Đã tạo kết nối API (Sandbox)'); setCreating(null); qc.invalidateQueries({ queryKey: ['connections'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  const byChannel = (ch: Channel) => (list.data ?? []).filter((c) => c.channel === ch)

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="Kết nối API do kênh gọi vào hệ thống của mình"
        description="Không có kênh nào cho kéo booking về. Mỗi bước dưới đây chỉ được tick khi hệ thống thấy bằng chứng: mã đã khai, ánh xạ đã kiểm tra, cổng trả lời, kênh đã gọi thành công. Trạng thái 'Đã kết nối' chỉ do cổng thật báo, không đặt tay được." />
      {(['getyourguide', 'viator'] as Channel[]).map((ch) => (
        <div key={ch}>
          {byChannel(ch).map((c) => <ConnectionCard key={c.id} c={c} />)}
          {!list.isLoading && byChannel(ch).length === 0 && (
            <Card style={{ marginBottom: 16 }} title={`${CHANNEL[ch]} · chưa có kết nối API`}>
              <Space direction="vertical">
                <span className="muted">{ch === 'viator' ? 'Tạo trước để theo dõi các bước xin duyệt với Viator. Chưa có cổng Viator.' : 'Tạo kết nối Sandbox để ghép mã, khai cổng và theo dõi các bước.'}</span>
                <Can perm="connection.manage"><Button type="primary" onClick={() => { form.setFieldsValue({ account_name: `${CHANNEL[ch]} API` }); setCreating(ch) }}>Tạo kết nối API {CHANNEL[ch]}</Button></Can>
              </Space>
            </Card>
          )}
        </div>
      ))}
      <Modal title={creating ? `Tạo kết nối API ${CHANNEL[creating]}` : ''} open={Boolean(creating)} onCancel={() => setCreating(null)} onOk={() => form.submit()} okText="Tạo" cancelText="Hủy" confirmLoading={create.isPending}>
        <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)}>
          <Form.Item name="account_name" label="Tên kết nối" rules={[{ required: true, message: 'Nhập tên' }]}><Input /></Form.Item>
          <p className="muted">Bắt đầu ở Sandbox, trạng thái "Chưa cấu hình". Không gửi gì ra ngoài khi tạo.</p>
        </Form>
      </Modal>
    </>
  )
}
