import { useQuery } from '@tanstack/react-query'
import { Card, Drawer, Select, Tabs, Tag } from 'antd'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { ActiveTag, CrudPage } from '../../components/CrudPage'
import { PageHead } from '../../components/common'
import { supabase, unwrap, type Row } from '../../lib/supabase'

const LANG = [{ value: 'en', label: 'Tiếng Anh' }, { value: 'vi', label: 'Tiếng Việt' }, { value: 'ko', label: 'Tiếng Hàn' }, { value: 'ja', label: 'Tiếng Nhật' }, { value: 'zh', label: 'Tiếng Trung' }, { value: 'fr', label: 'Tiếng Pháp' }]

function Options({ tourId }: { tourId?: string }) {
  const { orgId } = useAuth()
  const [selected, setSelected] = useState(tourId)
  const tours = useQuery({
    queryKey: ['tours-lite', orgId],
    queryFn: async () => unwrap(await supabase.from('tours').select('id, name').eq('organization_id', orgId).is('deleted_at', null).order('name')) as Row[],
  })
  return (
    <CrudPage bare title="Gói dịch vụ" table="tour_options" queryKey="tour_options" managePerm="catalog.manage" softDelete order="code"
      select="id, tour_id, code, name, language, has_transfer, is_private, duration_minutes, cutoff_minutes, ops_policy, is_active, price_rules, capacity_rules, tours(name)"
      search={(q) => `code.ilike.%${q}%,name.ilike.%${q}%`}
      extra={<Select allowClear placeholder="Lọc theo tour" style={{ minWidth: 200 }} value={selected} onChange={setSelected} options={(tours.data ?? []).map((t) => ({ value: t.id, label: t.name }))} />}
      columns={[
        { title: 'Mã gói', dataIndex: 'code' },
        { title: 'Tên gói', dataIndex: 'name' },
        { title: 'Tour', render: (_, r) => r.tours?.name },
        { title: 'Ngôn ngữ', dataIndex: 'language' },
        { title: 'Đưa đón', render: (_, r) => (r.has_transfer ? <Tag color="cyan">Có đưa đón</Tag> : 'Không') },
        { title: 'Loại', render: (_, r) => (r.is_private ? 'Tour riêng' : 'Tour ghép') },
        { title: 'Thời lượng', render: (_, r) => (r.duration_minutes ? `${r.duration_minutes} phút` : <span className="muted">Theo tour</span>) },
        { title: 'Hạn nhận khách', render: (_, r) => (r.cutoff_minutes ? `Trước ${r.cutoff_minutes} phút` : 'Đến giờ chạy') },
        { title: 'Trạng thái', render: (_, r) => <ActiveTag value={r.is_active} /> },
      ]}
      mapBeforeSave={({ tours: _t, ...v }) => v}
      fields={[
        { name: 'tour_id', label: 'Tour', type: 'select', required: true, options: (tours.data ?? []).map((t) => ({ value: t.id, label: t.name })), defaultValue: selected },
        { name: 'code', label: 'Mã gói', required: true },
        { name: 'name', label: 'Tên gói', required: true },
        { name: 'language', label: 'Ngôn ngữ', type: 'select', options: LANG, defaultValue: 'en' },
        { name: 'has_transfer', label: 'Có đưa đón', type: 'switch', defaultValue: false },
        { name: 'is_private', label: 'Tour riêng', type: 'switch', defaultValue: false },
        { name: 'duration_minutes', label: 'Thời lượng (phút, bỏ trống thì dùng của tour)', type: 'number', min: 1 },
        { name: 'cutoff_minutes', label: 'Hạn chót nhận khách (phút trước giờ chạy)', type: 'number', min: 0, defaultValue: 0 },
        { name: 'ops_policy', label: 'Chính sách vận hành', type: 'textarea' },
        { name: 'is_active', label: 'Đang hoạt động', type: 'switch', defaultValue: true },
      ]}
      emptyText="Chưa có gói dịch vụ" />
  )
}

function Categories() {
  return (
    <CrudPage bare title="Nhóm khách" table="traveler_categories" queryKey="traveler_categories" managePerm="catalog.manage" order="sort_order"
      columns={[
        { title: 'Mã', dataIndex: 'code' },
        { title: 'Tên', dataIndex: 'name' },
        { title: 'Tuổi', render: (_, r) => [r.min_age, r.max_age].filter((x) => x != null).join(' - ') },
        { title: 'Chiếm chỗ', render: (_, r) => (r.counts_as_seat ? 'Có' : <Tag>Không chiếm chỗ</Tag>) },
      ]}
      fields={[
        { name: 'code', label: 'Mã', required: true, help: 'Trùng với mã trong dữ liệu booking, ví dụ adult' },
        { name: 'name', label: 'Tên', required: true },
        { name: 'min_age', label: 'Tuổi từ', type: 'number', min: 0 },
        { name: 'max_age', label: 'Tuổi đến', type: 'number', min: 0 },
        { name: 'counts_as_seat', label: 'Chiếm chỗ', type: 'switch', defaultValue: true },
        { name: 'sort_order', label: 'Thứ tự', type: 'number', defaultValue: 0 },
      ]} />
  )
}

export function ToursPage() {
  const [params, setParams] = useSearchParams()
  const [detail, setDetail] = useState<Row | null>(null)
  const tab = params.get('tab') ?? 'tours'
  return (
    <>
      <PageHead title="Tour và gói dịch vụ" />
      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'tours' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'tours', label: 'Tour', children: (
            <CrudPage bare title="Tour" table="tours" queryKey="tours" managePerm="catalog.manage" softDelete order="code"
              search={(q) => `code.ilike.%${q}%,name.ilike.%${q}%,destination.ilike.%${q}%`}
              columns={[
                { title: 'Mã', dataIndex: 'code' },
                { title: 'Tên tour', render: (_, r) => <a onClick={() => setDetail(r)}>{r.name}</a> },
                { title: 'Điểm đến', dataIndex: 'destination' },
                { title: 'Thời lượng', render: (_, r) => (r.duration_minutes ? `${Math.round(r.duration_minutes / 60 * 10) / 10} giờ` : '') },
                { title: 'Múi giờ', dataIndex: 'default_timezone' },
                { title: 'Trạng thái', render: (_, r) => <ActiveTag value={r.is_active} /> },
              ]}
              fields={[
                { name: 'code', label: 'Mã tour', required: true },
                { name: 'name', label: 'Tên tour', required: true },
                { name: 'description', label: 'Mô tả', type: 'textarea' },
                { name: 'destination', label: 'Điểm đến' },
                { name: 'duration_minutes', label: 'Thời lượng (phút)', type: 'number', min: 1 },
                { name: 'default_timezone', label: 'Múi giờ mặc định', required: true, defaultValue: 'Asia/Ho_Chi_Minh' },
                { name: 'inclusions', label: 'Bao gồm', type: 'tags', help: 'Nhập rồi bấm Enter' },
                { name: 'exclusions', label: 'Không bao gồm', type: 'tags', help: 'Nhập rồi bấm Enter' },
                { name: 'joining_instructions', label: 'Hướng dẫn tham gia', type: 'textarea' },
                { name: 'is_active', label: 'Đang hoạt động', type: 'switch', defaultValue: true },
              ]}
              emptyText="Chưa có tour" />
          ) },
          { key: 'options', label: 'Gói dịch vụ', children: <Options /> },
          { key: 'categories', label: 'Nhóm khách', children: <Categories /> },
        ]} />
      </Card>
      <Drawer title={detail?.name} open={Boolean(detail)} onClose={() => setDetail(null)} width={520}>
        {detail && (
          <>
            <p>{detail.description}</p>
            <p><b>Bao gồm:</b> {(detail.inclusions ?? []).join(', ') || 'Chưa khai'}</p>
            <p><b>Không bao gồm:</b> {(detail.exclusions ?? []).join(', ') || 'Chưa khai'}</p>
            <p><b>Hướng dẫn tham gia:</b> {detail.joining_instructions || 'Chưa khai'}</p>
            <b>Lịch trình</b>
            <ol>{(detail.itinerary ?? []).map((s: Row | string, i: number) => <li key={i}>{typeof s === 'string' ? s : s.title}</li>)}</ol>
          </>
        )}
      </Drawer>
    </>
  )
}
