import { useQuery } from '@tanstack/react-query'
import { Card, Tabs, Tag } from 'antd'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { ActiveTag, CrudPage } from '../../components/CrudPage'
import { PageHead } from '../../components/common'
import { supabase, unwrap, type Row } from '../../lib/supabase'

export function GuidesPage() {
  return (
    <CrudPage title="Hướng dẫn viên" table="guides" queryKey="guides" managePerm="resource.manage" softDelete order="full_name"
      search={(q) => `full_name.ilike.%${q}%,phone.ilike.%${q}%`}
      columns={[
        { title: 'Họ tên', dataIndex: 'full_name' },
        { title: 'Điện thoại', dataIndex: 'phone' },
        { title: 'Ngôn ngữ', render: (_, r) => (r.languages ?? []).map((l: string) => <Tag key={l}>{l}</Tag>) },
        { title: 'Tài khoản', render: (_, r) => (r.profile_id ? <Tag color="green">Đã liên kết</Tag> : <span className="muted">Chưa có</span>) },
        { title: 'Trạng thái', render: (_, r) => <ActiveTag value={r.is_active} /> },
      ]}
      fields={[
        { name: 'full_name', label: 'Họ tên', required: true },
        { name: 'phone', label: 'Điện thoại' },
        { name: 'languages', label: 'Ngôn ngữ', type: 'tags', help: 'Nhập rồi bấm Enter, ví dụ en' },
        { name: 'note', label: 'Ghi chú', type: 'textarea' },
        { name: 'is_active', label: 'Đang hoạt động', type: 'switch', defaultValue: true },
      ]}
      emptyText="Chưa có hướng dẫn viên" />
  )
}

export function VehiclesPage() {
  const { orgId } = useAuth()
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'vehicles'
  const suppliers = useQuery({
    queryKey: ['suppliers-lite', orgId],
    queryFn: async () => unwrap(await supabase.from('suppliers').select('id, name').eq('organization_id', orgId).is('deleted_at', null).order('name')) as Row[],
  })
  return (
    <>
      <PageHead title="Xe và nhà cung cấp" />
      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'vehicles' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'vehicles', label: 'Xe', children: (
            <CrudPage bare title="Xe" table="vehicles" queryKey="vehicles" managePerm="resource.manage" softDelete order="name"
              select="id, name, plate, seats, driver_name, driver_phone, supplier_id, is_active, suppliers(name)"
              search={(q) => `name.ilike.%${q}%,plate.ilike.%${q}%`}
              mapBeforeSave={({ suppliers: _s, ...v }) => v}
              columns={[
                { title: 'Tên xe', dataIndex: 'name' },
                { title: 'Biển số', dataIndex: 'plate' },
                { title: 'Số chỗ', dataIndex: 'seats', align: 'right' },
                { title: 'Tài xế', render: (_, r) => `${r.driver_name ?? ''} ${r.driver_phone ?? ''}` },
                { title: 'Nhà cung cấp', render: (_, r) => r.suppliers?.name },
                { title: 'Trạng thái', render: (_, r) => <ActiveTag value={r.is_active} /> },
              ]}
              fields={[
                { name: 'name', label: 'Tên xe', required: true },
                { name: 'plate', label: 'Biển số' },
                { name: 'seats', label: 'Số chỗ khách', type: 'number', required: true, min: 1 },
                { name: 'driver_name', label: 'Tài xế' },
                { name: 'driver_phone', label: 'Điện thoại tài xế' },
                { name: 'supplier_id', label: 'Nhà cung cấp', type: 'select', options: (suppliers.data ?? []).map((s) => ({ value: s.id, label: s.name })) },
                { name: 'is_active', label: 'Đang hoạt động', type: 'switch', defaultValue: true },
              ]}
              emptyText="Chưa có xe" />
          ) },
          { key: 'suppliers', label: 'Nhà cung cấp', children: (
            <CrudPage bare title="Nhà cung cấp" table="suppliers" queryKey="suppliers" managePerm="resource.manage" softDelete order="name"
              search={(q) => `name.ilike.%${q}%`}
              columns={[
                { title: 'Tên', dataIndex: 'name' },
                { title: 'Loại', dataIndex: 'kind' },
                { title: 'Liên hệ', render: (_, r) => `${r.contact_name ?? ''} ${r.phone ?? ''}` },
                { title: 'Email', dataIndex: 'email' },
                { title: 'Trạng thái', render: (_, r) => <ActiveTag value={r.is_active} /> },
              ]}
              fields={[
                { name: 'name', label: 'Tên', required: true },
                { name: 'kind', label: 'Loại', type: 'select', defaultValue: 'transport', options: [{ value: 'transport', label: 'Vận chuyển' }, { value: 'ticket', label: 'Vé' }, { value: 'restaurant', label: 'Nhà hàng' }, { value: 'other', label: 'Khác' }] },
                { name: 'contact_name', label: 'Người liên hệ' },
                { name: 'phone', label: 'Điện thoại' },
                { name: 'email', label: 'Email' },
                { name: 'note', label: 'Ghi chú', type: 'textarea' },
                { name: 'is_active', label: 'Đang hoạt động', type: 'switch', defaultValue: true },
              ]}
              emptyText="Chưa có nhà cung cấp" />
          ) },
        ]} />
      </Card>
    </>
  )
}
