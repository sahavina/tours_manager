import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Drawer, List, Popconfirm, Space, Table, Tabs, Tag } from 'antd'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { CrudPage } from '../../components/CrudPage'
import { BookingStatusTag, fmtDateTime, NoData, PageHead } from '../../components/common'
import { rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

function History({ customer, onClose }: { customer: Row; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['customer-bookings', customer.id],
    queryFn: async () => unwrap(await supabase.from('v_booking_list').select('id, code, status, tour_name, local_date, booked_at').eq('customer_id', customer.id).order('booked_at', { ascending: false })) as Row[],
  })
  return (
    <Drawer title={customer.full_name} open onClose={onClose} width={560}>
      <p>{customer.email} {customer.phone}</p>
      <p className="muted">Nguồn dữ liệu: {customer.source}. {customer.marketing_consent ? 'Có đồng ý nhận marketing.' : 'Chưa có đồng ý nhận marketing: không dùng cho mục đích tiếp thị.'}</p>
      {customer.service_notes && <Alert type="info" message={customer.service_notes} style={{ marginBottom: 12 }} />}
      <Table rowKey="id" size="small" loading={q.isLoading} dataSource={q.data} pagination={false} locale={{ emptyText: <NoData text="Chưa có booking" /> }} columns={[
        { title: 'Mã', render: (_, b) => <Link to={`/bookings/${b.id}`}>{b.code}</Link> },
        { title: 'Tour', dataIndex: 'tour_name' },
        { title: 'Ngày đi', dataIndex: 'local_date' },
        { title: 'Trạng thái', render: (_, b) => <BookingStatusTag value={b.status} /> },
      ]} />
    </Drawer>
  )
}

function Duplicates() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['customer-duplicates', orgId], queryFn: () => rpc<Row[]>('customer_duplicate_suggestions', { p_org: orgId }) })
  const merge = useMutation({
    mutationFn: ({ keep, drop }: { keep: string; drop: string }) => rpcOk('merge_customers', { p_keep: keep, p_drop: drop }),
    onSuccess: () => { message.success('Đã gộp'); qc.invalidateQueries({ queryKey: ['customer-duplicates'] }); qc.invalidateQueries({ queryKey: ['customers'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Chỉ gợi ý khi trùng email hoặc số điện thoại, không bao giờ theo tên. Việc gộp cần người có quyền xác nhận." />
      <List loading={q.isLoading} dataSource={q.data ?? []} locale={{ emptyText: <NoData text="Không có gợi ý trùng" /> }} renderItem={(g) => (
        <List.Item>
          <div style={{ width: '100%' }}>
            <div className="muted">Trùng {g.matched_on === 'email' ? 'email' : 'điện thoại'}: {g.value}</div>
            {(g.customers as Row[]).map((c, i, arr) => (
              <Space key={c.id} style={{ marginTop: 4 }} wrap>
                <span>{c.full_name}</span><Tag>{c.source}</Tag>
                {can('customer.manage') && i > 0 && (
                  <Popconfirm title={`Gộp vào ${arr[0]!.full_name}?`} okText="Gộp" cancelText="Hủy" onConfirm={() => merge.mutate({ keep: arr[0]!.id, drop: c.id })}>
                    <Button size="small">Gộp vào khách đầu tiên</Button>
                  </Popconfirm>
                )}
              </Space>
            ))}
          </div>
        </List.Item>
      )} />
    </>
  )
}

export function CustomersPage() {
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<Row | null>(null)
  const tab = params.get('tab') ?? 'all'
  return (
    <>
      <PageHead title="Khách hàng" />
      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'all' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'all', label: 'Danh sách', children: (
            <CrudPage bare title="Khách hàng" table="customers" queryKey="customers" managePerm="customer.manage"
              search={(q) => `full_name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`}
              columns={[
                { title: 'Họ tên', render: (_, r) => <a onClick={() => setSelected(r)}>{r.full_name}</a> },
                { title: 'Email', dataIndex: 'email' },
                { title: 'Điện thoại', dataIndex: 'phone' },
                { title: 'Quốc tịch', dataIndex: 'nationality' },
                { title: 'Nguồn', dataIndex: 'source' },
                { title: 'Đã gộp', render: (_, r) => r.merged_into_id && <Tag>Đã gộp</Tag> },
                { title: 'Tạo lúc', render: (_, r) => <span className="nowrap">{fmtDateTime(r.created_at)}</span> },
              ]}
              fields={[
                { name: 'full_name', label: 'Họ tên', required: true },
                { name: 'email', label: 'Email' },
                { name: 'phone', label: 'Điện thoại' },
                { name: 'nationality', label: 'Quốc tịch' },
                { name: 'service_notes', label: 'Ghi chú phục vụ', type: 'textarea' },
                { name: 'marketing_consent', label: 'Khách đã đồng ý nhận marketing', type: 'switch', defaultValue: false },
              ]}
              emptyText="Chưa có khách hàng" />
          ) },
          { key: 'duplicates', label: 'Gợi ý trùng', children: <Duplicates /> },
        ]} />
      </Card>
      {selected && <History customer={selected} onClose={() => setSelected(null)} />}
    </>
  )
}
