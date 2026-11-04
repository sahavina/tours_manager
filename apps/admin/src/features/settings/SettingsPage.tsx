import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Form, Input, InputNumber, Modal, Select, Switch, Table, Tabs, Tag } from 'antd'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, NoData, PageHead } from '../../components/common'
import { friendlyError, rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

function OrgTab() {
  const { org, orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['org', orgId],
    queryFn: async () => unwrap(await supabase.from('organizations').select('*').eq('id', orgId).single()) as Row,
  })
  const save = useMutation({
    mutationFn: async (v: Row) => {
      const res = await supabase.from('organizations').update(v).eq('id', orgId).select('id')
      if (res.error) throw new Error(friendlyError(res.error))
      if (!res.data?.length) throw new Error('Bạn không có quyền sửa dữ liệu này.')
    },
    onSuccess: () => { message.success('Đã lưu'); qc.invalidateQueries({ queryKey: ['org'] }); qc.invalidateQueries({ queryKey: ['org-context'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  if (q.isLoading) return null
  if (q.isError) return <ErrorState error={q.error} />
  return (
    <Form layout="vertical" style={{ maxWidth: 480 }} disabled={!can('org.manage')} initialValues={q.data} key={org?.organization_id} onFinish={(v) => save.mutate(v)}>
      <Form.Item name="name" label="Tên doanh nghiệp" rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="default_timezone" label="Múi giờ mặc định" rules={[{ required: true }]}><Input /></Form.Item>
      <Form.Item name="default_currency" label="Tiền tệ mặc định" rules={[{ required: true, pattern: /^[A-Z]{3}$/, message: '3 chữ in hoa' }]}><Input /></Form.Item>
      <Form.Item name="payload_retention_days" label="Lưu dữ liệu nguồn của sự kiện (ngày)" extra="Hết hạn, worker xóa nội dung payload và giữ lại khung sự kiện để truy vết."><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
      <Button type="primary" htmlType="submit" loading={save.isPending}>Lưu</Button>
    </Form>
  )
}

function MembersTab() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [edit, setEdit] = useState<Row | null>(null)
  const [form] = Form.useForm()
  const members = useQuery({ queryKey: ['members', orgId], enabled: can('member.manage'), queryFn: () => rpc<Row[]>('member_list', { p_org: orgId }) })
  const roles = useQuery({ queryKey: ['roles'], queryFn: async () => unwrap(await supabase.from('roles').select('key, name')) as Row[] })
  const perms = useQuery({ queryKey: ['permissions'], queryFn: async () => unwrap(await supabase.from('permissions').select('key, description').order('key')) as Row[] })
  const save = useMutation({
    mutationFn: (v: Row) => rpcOk('member_upsert', { p_org: orgId, p_email: v.email, p_role: v.role_key, p_granted: v.granted_permissions ?? [], p_revoked: v.revoked_permissions ?? [], p_active: v.is_active ?? true }),
    onSuccess: () => { message.success('Đã lưu'); setEdit(null); qc.invalidateQueries({ queryKey: ['members'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  if (!can('member.manage')) return <NoData text="Bạn không có quyền quản lý tài khoản" />
  const permOptions = (perms.data ?? []).map((p) => ({ value: p.key, label: `${p.key} · ${p.description}` }))
  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Tạo tài khoản đăng nhập mới bằng lệnh quản trị (scripts/create-user.mjs) vì việc đó cần khóa service role, không đưa ra trình duyệt. Ở đây gán tài khoản đã có vào doanh nghiệp." />
      <div className="filters"><div style={{ flex: 1 }} /><Button type="primary" onClick={() => { form.resetFields(); form.setFieldsValue({ is_active: true }); setEdit({}) }}>Thêm thành viên</Button></div>
      {members.isError ? <ErrorState error={members.error} /> : (
        <Table rowKey="id" size="small" loading={members.isLoading} dataSource={members.data} pagination={false} scroll={{ x: 'max-content' }} columns={[
          { title: 'Email', dataIndex: 'email' },
          { title: 'Họ tên', dataIndex: 'full_name' },
          { title: 'Vai trò', render: (_, m) => roles.data?.find((r) => r.key === m.role_key)?.name ?? m.role_key },
          { title: 'Quyền cấp thêm', render: (_, m) => (m.granted_permissions as string[]).map((p) => <Tag key={p}>{p}</Tag>) },
          { title: 'Quyền thu hồi', render: (_, m) => (m.revoked_permissions as string[]).map((p) => <Tag key={p} color="red">{p}</Tag>) },
          { title: 'Trạng thái', render: (_, m) => (m.is_active ? <Tag color="green">Hoạt động</Tag> : <Tag>Đã khóa</Tag>) },
          { title: '', render: (_, m) => <Button size="small" type="link" onClick={() => { form.setFieldsValue(m); setEdit(m) }}>Sửa</Button> },
        ]} />
      )}
      <Modal title="Thành viên" open={Boolean(edit)} onCancel={() => setEdit(null)} onOk={() => form.submit()} okText="Lưu" cancelText="Hủy" confirmLoading={save.isPending}>
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item name="email" label="Email tài khoản" rules={[{ required: true, type: 'email', message: 'Nhập email' }]}><Input disabled={Boolean(edit?.id)} /></Form.Item>
          <Form.Item name="role_key" label="Vai trò" rules={[{ required: true, message: 'Chọn vai trò' }]}><Select options={(roles.data ?? []).map((r) => ({ value: r.key, label: r.name }))} /></Form.Item>
          <Form.Item name="granted_permissions" label="Cấp thêm quyền"><Select mode="multiple" options={permOptions} /></Form.Item>
          <Form.Item name="revoked_permissions" label="Thu hồi quyền"><Select mode="multiple" options={permOptions} /></Form.Item>
          <Form.Item name="is_active" label="Đang hoạt động" valuePropName="checked"><Switch /></Form.Item>
        </Form>
      </Modal>
    </>
  )
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'org'
  return (
    <>
      <PageHead title="Cài đặt" />
      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'org' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'org', label: 'Doanh nghiệp', children: <OrgTab /> },
          { key: 'members', label: 'Tài khoản và vai trò', children: <MembersTab /> },
        ]} />
      </Card>
    </>
  )
}
