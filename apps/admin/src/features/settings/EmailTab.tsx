// Tab "Email": cấu hình gửi email thông báo yêu cầu đặt tour từ website (organizations.email_settings).
// Worker trên server gửi qua SMTP. Mật khẩu SMTP không lưu ở đây: đặt SMTP_PASSWORD trong /srv/tourhub/worker.env.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Col, Divider, Form, Input, InputNumber, Row as ARow, Select, Space, Switch, Table, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState } from '../../components/common'
import { friendlyError, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

type EmailSettings = {
  enabled?: boolean; smtp_host?: string; smtp_port?: number; smtp_secure?: boolean; smtp_user?: string
  from_name?: string; from_email?: string; staff_to?: string[]; notify_staff?: boolean; notify_customer?: boolean
}

const KIND: Record<string, string> = { staff_new_booking: 'Báo đội ngũ', customer_ack: 'Xác nhận cho khách', test: 'Email thử' }
const email = { type: 'email' as const, message: 'Email chưa đúng' }

export function EmailTab() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [testTo, setTestTo] = useState('')
  const [watchLog, setWatchLog] = useState(false)
  const editable = can('org.manage') || can('web.manage')

  const q = useQuery({
    queryKey: ['org-email', orgId],
    queryFn: async () => {
      const row = unwrap(await supabase.from('organizations').select('email_settings').eq('id', orgId).single()) as { email_settings: EmailSettings | null }
      const s = row.email_settings ?? {}
      return { smtp_port: 465, smtp_secure: true, notify_staff: true, notify_customer: true, ...s }
    },
  })
  const logs = useQuery({
    queryKey: ['email-log', orgId],
    enabled: editable,
    refetchInterval: watchLog ? 4000 : false,
    queryFn: async () => unwrap(await supabase.from('email_log').select('id, kind, recipient, subject, status, error, created_at')
      .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(20)) as Row[],
  })

  const save = useMutation({
    mutationFn: async (v: EmailSettings) => {
      const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined && x !== null && x !== ''))
      const res = await supabase.from('organizations').update({ email_settings: clean }).eq('id', orgId).select('id')
      if (res.error) throw new Error(friendlyError(res.error))
      if (!res.data?.length) throw new Error('Bạn không có quyền sửa dữ liệu này.')
    },
    onSuccess: () => { message.success('Đã lưu cấu hình email'); qc.invalidateQueries({ queryKey: ['org-email'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  const test = useMutation({
    mutationFn: () => rpcOk('email_send_test', { p_org: orgId, p_to: testTo }),
    onSuccess: () => {
      message.info('Đã xếp email thử, worker gửi trong vài giây. Xem kết quả ở nhật ký bên dưới.')
      setWatchLog(true)
      window.setTimeout(() => setWatchLog(false), 60_000)
    },
    onError: (e: Error) => message.error(e.message),
  })

  if (q.isLoading) return null
  if (q.isError) return <ErrorState error={q.error} />

  return (
    <div style={{ maxWidth: 980 }}>
      <Alert type="info" showIcon style={{ marginBottom: 16 }}
        message="Mật khẩu SMTP không lưu trong trang quản trị"
        description={<>Đặt mật khẩu trên server trong file <Typography.Text code>/srv/tourhub/worker.env</Typography.Text> (dòng <Typography.Text code>SMTP_PASSWORD=...</Typography.Text>) rồi khởi động lại worker. Với Gmail, dùng <b>App Password</b> (Tài khoản Google → Bảo mật → Mật khẩu ứng dụng), không dùng mật khẩu đăng nhập.</>} />
      <Form form={form} layout="vertical" disabled={!editable} initialValues={q.data} key={orgId} onFinish={(v) => save.mutate(v)}>
        <Form.Item name="enabled" label="Gửi email khi có yêu cầu đặt tour từ website" valuePropName="checked"><Switch /></Form.Item>

        <Typography.Title level={5}>Máy chủ gửi mail (SMTP)</Typography.Title>
        <ARow gutter={16}>
          <Col xs={24} md={10}><Form.Item name="smtp_host" label="Máy chủ" extra="Gmail: smtp.gmail.com"><Input placeholder="smtp.gmail.com" /></Form.Item></Col>
          <Col xs={12} md={4}><Form.Item name="smtp_port" label="Cổng"><InputNumber min={1} max={65535} style={{ width: '100%' }} /></Form.Item></Col>
          <Col xs={12} md={4}><Form.Item name="smtp_secure" label="SSL (465)" valuePropName="checked"><Switch /></Form.Item></Col>
          <Col xs={24} md={6}><Form.Item name="smtp_user" label="Tài khoản đăng nhập SMTP" rules={[email]}><Input placeholder="ten@gmail.com" /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="from_name" label="Tên người gửi"><Input placeholder="Hanoi Jeep" /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="from_email" label="Email người gửi" rules={[email]} extra="Với Gmail, nên trùng tài khoản đăng nhập."><Input /></Form.Item></Col>
        </ARow>

        <Divider />
        <Typography.Title level={5}>Ai nhận email</Typography.Title>
        <ARow gutter={16}>
          <Col xs={24} md={8}><Form.Item name="notify_staff" label="Báo đội ngũ khi có yêu cầu mới" valuePropName="checked"><Switch /></Form.Item></Col>
          <Col xs={24} md={16}>
            <Form.Item name="staff_to" label="Email đội ngũ nhận thông báo" extra="Gõ rồi Enter để thêm nhiều địa chỉ. Email khách trả lời sẽ về địa chỉ đầu tiên."
              rules={[{ validator: (_, v: string[] | undefined) => (v ?? []).every((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)) ? Promise.resolve() : Promise.reject(new Error('Có địa chỉ email chưa đúng')) }]}>
              <Select mode="tags" open={false} tokenSeparators={[',', ' ']} placeholder="ops@example.com" />
            </Form.Item>
          </Col>
          <Col xs={24}><Form.Item name="notify_customer" label="Gửi khách email xác nhận đã nhận yêu cầu (tiếng Anh, kèm mã booking)" valuePropName="checked"><Switch /></Form.Item></Col>
        </ARow>
        <Button type="primary" htmlType="submit" loading={save.isPending} disabled={!editable}>Lưu</Button>
      </Form>

      <Divider />
      <Typography.Title level={5}>Gửi thử</Typography.Title>
      <Typography.Paragraph type="secondary">Lưu cấu hình trước, rồi gửi một email thử để kiểm tra máy chủ và mật khẩu SMTP.</Typography.Paragraph>
      <Space.Compact style={{ maxWidth: 480, width: '100%' }}>
        <Input placeholder="Địa chỉ nhận email thử" value={testTo} onChange={(e) => setTestTo(e.target.value)} disabled={!editable} />
        <Button onClick={() => test.mutate()} loading={test.isPending} disabled={!editable || !testTo.trim()}>Gửi thử</Button>
      </Space.Compact>

      <Divider />
      <Typography.Title level={5}>Nhật ký gửi email (20 lần gần nhất)</Typography.Title>
      <Table rowKey="id" size="small" loading={logs.isLoading} dataSource={logs.data ?? []} pagination={false} scroll={{ x: 'max-content' }}
        locale={{ emptyText: 'Chưa gửi email nào' }}
        columns={[
          { title: 'Lúc', dataIndex: 'created_at', render: (v: string) => new Date(v).toLocaleString('vi-VN') },
          { title: 'Loại', dataIndex: 'kind', render: (v: string) => KIND[v] ?? v },
          { title: 'Người nhận', dataIndex: 'recipient' },
          { title: 'Kết quả', render: (_: unknown, r: Row) => r.status === 'sent' ? <Tag color="green">Đã gửi</Tag> : <Tag color="red">Lỗi</Tag> },
          { title: 'Chi tiết', dataIndex: 'error', render: (v: string | null, r: Row) => v ?? r.subject },
        ]} />
    </div>
  )
}
