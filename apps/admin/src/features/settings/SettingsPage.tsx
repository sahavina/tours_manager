import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Card, Form, Input, InputNumber, Tabs } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, PageHead } from '../../components/common'
import { friendlyError, supabase, unwrap, type Row } from '../../lib/supabase'
import { FeaturesTab } from './FeaturesTab'
import { MembersTab, RolesTab } from './MembersTab'

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

export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'org'
  return (
    <>
      <PageHead title="Cài đặt" />
      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'org' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'org', label: 'Doanh nghiệp', children: <OrgTab /> },
          { key: 'features', label: 'Tính năng', children: <FeaturesTab /> },
          { key: 'members', label: 'Tài khoản và phân quyền', children: <MembersTab /> },
          { key: 'roles', label: 'Vai trò và quyền', children: <RolesTab /> },
        ]} />
      </Card>
    </>
  )
}
