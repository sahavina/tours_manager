import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Card, Drawer, Popconfirm, Select, Tabs, Tag } from 'antd'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { ActiveTag, CrudPage } from '../../components/CrudPage'
import { PageHead } from '../../components/common'
import { rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'
import { TourEditor } from './TourEditor'

// Bảng giá theo số người dạng chữ, mỗi dòng một bậc: "2: 199", "3-4: 180", "7+: 160".
export const tiersToText = (v: unknown) => (Array.isArray(v) ? v.map((t: Row) =>
  `${t.max == null ? `${t.min ?? 1}+` : t.min === t.max ? t.min : `${t.min}-${t.max}`}: ${t.per_person}`).join('\n') : '')
export function tiersFromText(text: unknown) {
  const out: { min: number; max: number | null; per_person: number }[] = []
  for (const line of String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean)) {
    const m = line.match(/^(\d+)\s*(?:-\s*(\d+)|(\+))?\s*[:=]\s*(\d+(?:[.,]\d+)?)$/)
    if (!m) throw new Error(`Dòng giá theo số người không đúng dạng: "${line}". Ví dụ: 2: 199 hoặc 3-4: 180 hoặc 7+: 160`)
    const min = Number(m[1])
    out.push({ min, max: m[3] ? null : m[2] ? Number(m[2]) : min, per_person: Number(m[4]!.replace(',', '.')) })
  }
  return out.sort((a, b) => a.min - b.min)
}

const LANG = [{ value: 'en', label: 'Tiếng Anh' }, { value: 'vi', label: 'Tiếng Việt' }, { value: 'ko', label: 'Tiếng Hàn' }, { value: 'ja', label: 'Tiếng Nhật' }, { value: 'zh', label: 'Tiếng Trung' }, { value: 'fr', label: 'Tiếng Pháp' }]

function Options({ tourId }: { tourId?: string }) {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [selected, setSelected] = useState(tourId)
  // Chuyến đã tạo giữ sức chứa riêng; đổi số ở gói chỉ áp cho chuyến mới, trừ khi bấm áp cho chuyến sắp tới.
  const apply = useMutation({
    mutationFn: (option: string) => rpcOk('apply_option_capacity', { p_option: option }),
    onSuccess: (r) => {
      const skipped = (r.skipped as Row[]).length
      const text = `Đã đổi ${r.updated} chuyến sang ${r.capacity} chỗ${r.unchanged ? `, ${r.unchanged} chuyến đã đúng` : ''}${skipped ? `, giữ nguyên ${skipped} chuyến vì đã có nhiều khách hơn hoặc dùng chung nguồn chỗ` : ''}`
      if (skipped) message.warning(text, 8)
      else message.success(text)
      for (const key of ['departures', 'ops-board']) qc.invalidateQueries({ queryKey: [key] })
    },
    onError: (e: Error) => message.error(e.message),
  })
  const tours = useQuery({
    queryKey: ['tours-lite', orgId],
    queryFn: async () => unwrap(await supabase.from('tours').select('id, name').eq('organization_id', orgId).is('deleted_at', null).order('name')) as Row[],
  })
  return (
    <CrudPage bare title="Gói dịch vụ" table="tour_options" queryKey="tour_options" managePerm="catalog.manage" softDelete order="code"
      select="id, tour_id, code, name, language, has_transfer, is_private, duration_minutes, default_capacity, cutoff_minutes, ops_policy, is_active, price_rules, capacity_rules, is_published, public_name, price_adult, price_child, price_currency, group_prices, child_note, content_vi, tours(name)"
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
        { title: 'Sức chứa mỗi chuyến', render: (_, r) => r.default_capacity ? (
          <span className="nowrap">{r.default_capacity} khách
            {can('departure.manage') && (
              <Popconfirm title={`Đổi các chuyến sắp chạy của gói này sang ${r.default_capacity} chỗ?`}
                description="Chuyến đã có nhiều khách hơn sẽ giữ nguyên." okText="Áp dụng" cancelText="Hủy" onConfirm={() => apply.mutate(r.id)}>
                <Button type="link" size="small" loading={apply.isPending && apply.variables === r.id}>Áp cho chuyến sắp tới</Button>
              </Popconfirm>
            )}
          </span>
        ) : <span className="muted">Chưa cấu hình</span> },
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
        { name: 'default_capacity', label: 'Sức chứa mỗi chuyến (số khách, dùng khi tạo chuyến mới)', type: 'number', min: 1 },
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
  const { can } = useAuth()
  const [detail, setDetail] = useState<Row | null>(null)
  const [editing, setEditing] = useState<Row | null>(null)
  const tab = params.get('tab') ?? 'tours'
  const openTour = (r: Row) => (can('catalog.manage') ? setEditing(r) : setDetail(r))
  return (
    <>
      <PageHead title="Tour và gói dịch vụ" />
      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'tours' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'tours', label: 'Tour', children: (
            <CrudPage bare title="Tour" table="tours" queryKey="tours" managePerm="catalog.manage" softDelete order="code"
              search={(q) => `code.ilike.%${q}%,name.ilike.%${q}%,destination.ilike.%${q}%`}
              onEdit={(r) => setEditing(r ?? {})}
              columns={[
                {
                  title: 'Ảnh', width: 92, render: (_, r) => {
                    const n = r.gallery?.length ?? (r.image_url ? 1 : 0)
                    return r.image_url || r.gallery?.[0]
                      ? <div className="tour-thumb" style={{ backgroundImage: `url("${r.image_url ?? r.gallery[0]}")` }}>{n > 1 && <span>{n}</span>}</div>
                      : <div className="tour-thumb empty">Chưa có</div>
                  },
                },
                { title: 'Mã', dataIndex: 'code' },
                { title: 'Tên tour', render: (_, r) => <a onClick={() => openTour(r)}>{r.name}</a> },
                { title: 'Điểm đến', dataIndex: 'destination' },
                { title: 'Thời lượng', render: (_, r) => r.duration_label || (r.duration_minutes ? `${Math.round(r.duration_minutes / 60 * 10) / 10} giờ` : '') },
                { title: 'Múi giờ', dataIndex: 'default_timezone' },
                { title: 'Trên web', render: (_, r) => (r.is_published ? <Tag color="green">Công khai</Tag> : <Tag>Ẩn</Tag>) },
                { title: 'Trạng thái', render: (_, r) => <ActiveTag value={r.is_active} /> },
              ]}
              // Thêm và sửa tour dùng TourEditor chế độ vận hành; ảnh, nội dung, tiếng Việt sửa ở khu Website.
              fields={[]}
              emptyText="Chưa có tour" />
          ) },
          { key: 'options', label: 'Gói dịch vụ', children: <Options /> },
          { key: 'categories', label: 'Nhóm khách', children: <Categories /> },
        ]} />
      </Card>
      {editing && <TourEditor tour={editing} onClose={() => setEditing(null)} />}
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
