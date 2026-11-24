// Khu "Website" của trang quản trị: mọi thứ khách thấy trên trang đặt tour.
// Tổng quan, yêu cầu đặt từ web, tour trên web (ảnh, nội dung EN/VI, công khai), giá và gói trên web,
// nội dung trang (liên hệ, vì sao chọn, điểm đến, đánh giá, chống bot), email thông báo.
import { useQuery } from '@tanstack/react-query'
import { BOOKING_STATUS } from '@tours/core'
import { Alert, Button, Card, Col, Input, Row as ARow, Segmented, Space, Statistic, Table, Tag, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { CrudPage } from '../../components/CrudPage'
import { ErrorState, fmtDate, fmtDateTime, PageHead } from '../../components/common'
import { friendlyError, supabase, unwrap, type Row } from '../../lib/supabase'
import { TourEditor } from '../catalog/TourEditor'
import { tiersFromText, tiersToText } from '../catalog/ToursPage'
import { viProgress } from '../catalog/translation'
import { EmailTab } from '../settings/EmailTab'
import { StorefrontTab } from '../settings/StorefrontTab'

const STORE_URL = 'https://hanoiadventuretours.com'
const webRequests = (orgId: string) =>
  supabase.from('v_booking_list').select('id, code, status, needs_action, lead_name, lead_email, tour_name, option_name, local_date, local_time, pax_total, gross_amount, currency, booked_at')
    .eq('organization_id', orgId).like('external_ref', 'WEB-%')

function VIProgressTag({ tour }: { tour: Row }) {
  const p = viProgress(tour)
  const color = p.done >= p.total ? 'green' : p.done ? 'gold' : 'red'
  return <Tag color={color}>{p.done >= p.total ? 'Đủ' : p.done ? 'Một phần' : 'Chưa dịch'} {p.done}/{p.total}</Tag>
}

// ---- Tổng quan ----
export function WebDashboardPage() {
  const { orgId, can } = useAuth()
  const nav = useNavigate()
  const data = useQuery({
    queryKey: ['web-dashboard', orgId],
    queryFn: async () => {
      const tours = unwrap(await supabase.from('tours').select('*').eq('organization_id', orgId).is('deleted_at', null)) as Row[]
      const options = unwrap(await supabase.from('tour_options').select('id, is_published, content_vi, price_adult, group_prices')
        .eq('organization_id', orgId).is('deleted_at', null)) as Row[]
      const org = unwrap(await supabase.from('organizations').select('email_settings, storefront_settings, disabled_features').eq('id', orgId).single()) as Row
      const lastMail = unwrap(await supabase.from('email_log').select('status, error, created_at').eq('organization_id', orgId)
        .order('created_at', { ascending: false }).limit(1)) as Row[]
      let pending: number | null = null
      if (can('booking.read')) {
        const r = await webRequests(orgId).eq('status', 'pending').limit(200)
        if (r.error) throw new Error(friendlyError(r.error))
        pending = r.data.length
      }
      return { tours, options, org, lastMail: lastMail[0] ?? null, pending }
    },
  })
  if (data.isLoading) return null
  if (data.isError) return <ErrorState error={data.error} />
  const d = data.data!
  const published = d.tours.filter((t) => t.is_published && t.is_active)
  const missingVi = published.filter((t) => { const p = viProgress(t); return p.done < p.total })
  const noImage = published.filter((t) => !(t.gallery?.length || t.image_url))
  const optsWeb = d.options.filter((o) => o.is_published)
  const optsNoVi = optsWeb.filter((o) => !o.content_vi?.public_name)
  const optsNoPrice = optsWeb.filter((o) => o.price_adult == null && !o.group_prices?.length)
  const storefrontOff = (d.org.disabled_features ?? []).includes('storefront')
  const email = d.org.email_settings ?? {}
  const verified = Boolean(d.org.storefront_settings?.require_verified_booking)

  const card = (title: string, value: number | string, to: string, warn = false, note?: string) => (
    <Col xs={12} md={8} lg={6}>
      <Card hoverable onClick={() => nav(to)} size="small">
        <Statistic title={title} value={value} valueStyle={warn ? { color: '#b45309' } : undefined} />
        {note && <div className="muted" style={{ fontSize: 12 }}>{note}</div>}
      </Card>
    </Col>
  )
  return (
    <>
      <PageHead title="Tổng quan website" extra={<Button href={STORE_URL} target="_blank">Mở trang đặt tour ↗</Button>} />
      {storefrontOff && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="Trang đặt tour đang tắt trong Cài đặt → Tính năng; khách không xem và không đặt được." />}
      <ARow gutter={[12, 12]}>
        {d.pending != null && card('Yêu cầu đặt chờ xác nhận', d.pending, '/web/requests', d.pending > 0)}
        {card('Tour đang công khai', `${published.length}/${d.tours.length}`, '/web/tours')}
        {card('Tour công khai thiếu bản tiếng Việt', missingVi.length, '/web/tours', missingVi.length > 0)}
        {card('Tour công khai chưa có ảnh', noImage.length, '/web/tours', noImage.length > 0)}
        {card('Gói hiện trên web thiếu tên tiếng Việt', optsNoVi.length, '/web/options', optsNoVi.length > 0)}
        {card('Gói hiện trên web chưa có giá', optsNoPrice.length, '/web/options', false, 'Khách thấy "Giá liên hệ"')}
        {card('Email thông báo', email.enabled ? 'Đang bật' : 'Đang tắt', '/web/email', !email.enabled,
          d.lastMail ? `Lần gửi gần nhất: ${d.lastMail.status === 'sent' ? 'thành công' : 'lỗi'} lúc ${fmtDateTime(d.lastMail.created_at)}` : 'Chưa gửi lần nào')}
        {card('Chống bot khi đặt', verified ? 'Bắt buộc' : 'Chưa bắt buộc', '/web/content', false)}
      </ARow>
    </>
  )
}

// ---- Yêu cầu đặt tour từ web ----
export function WebRequestsPage() {
  const { orgId } = useAuth()
  const nav = useNavigate()
  const [status, setStatus] = useState<string>('pending')
  const list = useQuery({
    queryKey: ['web-requests', orgId, status],
    queryFn: async () => {
      let q = webRequests(orgId).order('booked_at', { ascending: false }).limit(300)
      if (status) q = q.eq('status', status)
      return unwrap(await q) as Row[]
    },
  })
  return (
    <>
      <PageHead title="Yêu cầu đặt tour từ website" />
      <Card>
        <Typography.Paragraph type="secondary">
          Danh sách để theo dõi. Bấm vào một yêu cầu để mở booking; xác nhận, hủy, xếp xe và hướng dẫn viên làm ở khu Điều hành như mọi booking.
        </Typography.Paragraph>
        <Space style={{ marginBottom: 12 }} wrap>
          <Segmented value={status} onChange={(v) => setStatus(String(v))} options={[
            { value: 'pending', label: 'Chờ xác nhận' }, { value: 'confirmed', label: 'Đã xác nhận' },
            { value: 'cancelled', label: 'Đã hủy' }, { value: '', label: 'Tất cả' },
          ]} />
        </Space>
        {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : (
          <Table rowKey="id" size="middle" loading={list.isLoading} dataSource={list.data ?? []} scroll={{ x: 'max-content' }}
            pagination={{ pageSize: 25, hideOnSinglePage: true }} locale={{ emptyText: 'Chưa có yêu cầu nào' }}
            onRow={(r) => ({ onClick: () => nav(`/bookings/${r.id}`), style: { cursor: 'pointer' } })}
            columns={[
              { title: 'Mã', dataIndex: 'code', render: (v: string, r: Row) => <><b>{v}</b>{r.needs_action && <Tag color="orange" style={{ marginLeft: 6 }}>Cần xử lý</Tag>}</> },
              { title: 'Gửi lúc', dataIndex: 'booked_at', render: (v: string) => fmtDateTime(v) },
              { title: 'Tour', render: (_: unknown, r: Row) => <div style={{ maxWidth: 320 }}>{r.tour_name}<div className="muted">{r.option_name}</div></div> },
              { title: 'Ngày đi', render: (_: unknown, r: Row) => `${fmtDate(r.local_date)} ${String(r.local_time ?? '').slice(0, 5)}` },
              { title: 'Khách', render: (_: unknown, r: Row) => <>{r.lead_name}<div className="muted">{r.lead_email}</div></> },
              { title: 'Số khách', dataIndex: 'pax_total' },
              { title: 'Tạm tính', render: (_: unknown, r: Row) => (r.gross_amount != null ? `${Number(r.gross_amount).toLocaleString('vi-VN')} ${r.currency ?? ''}` : '') },
              { title: 'Trạng thái', dataIndex: 'status', render: (v: string) => <Tag>{BOOKING_STATUS[v] ?? v}</Tag> },
            ]} />
        )}
      </Card>
    </>
  )
}

// ---- Tour trên web ----
export function WebToursPage() {
  const { orgId } = useAuth()
  const [params, setParams] = useSearchParams()
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<string>('')
  const list = useQuery({
    queryKey: ['web-tours', orgId],
    queryFn: async () => unwrap(await supabase.from('tours').select('*').eq('organization_id', orgId).is('deleted_at', null).order('code')) as Row[],
  })
  const editId = params.get('edit')
  const editing = useMemo(() => (editId ? list.data?.find((t) => t.id === editId) ?? null : null), [editId, list.data])
  const rows = (list.data ?? []).filter((t) => {
    const text = `${t.code} ${t.name} ${t.content_vi?.name ?? ''}`.toLowerCase()
    if (q && !text.includes(q.toLowerCase())) return false
    const p = viProgress(t)
    if (filter === 'published') return t.is_published
    if (filter === 'hidden') return !t.is_published
    if (filter === 'missing_vi') return p.done < p.total
    if (filter === 'no_image') return !(t.gallery?.length || t.image_url)
    return true
  })
  const open = (t: Row) => setParams({ edit: t.id }, { replace: true })
  return (
    <>
      <PageHead title="Tour trên web" />
      <Card>
        <Typography.Paragraph type="secondary">
          Ảnh, nội dung tiếng Anh và tiếng Việt, và việc công khai tour trên trang đặt tour. Thêm tour mới, mã, thời lượng,
          múi giờ làm ở khu Điều hành → Tour và gói dịch vụ.
        </Typography.Paragraph>
        <div className="filters">
          <Input.Search allowClear placeholder="Tìm mã hoặc tên tour" style={{ maxWidth: 280 }} onSearch={setQ} onChange={(e) => !e.target.value && setQ('')} />
          <Segmented value={filter} onChange={(v) => setFilter(String(v))} options={[
            { value: '', label: 'Tất cả' }, { value: 'published', label: 'Công khai' }, { value: 'hidden', label: 'Đang ẩn' },
            { value: 'missing_vi', label: 'Thiếu tiếng Việt' }, { value: 'no_image', label: 'Chưa có ảnh' },
          ]} />
        </div>
        {list.isError ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : (
          <Table rowKey="id" size="middle" loading={list.isLoading} dataSource={rows} scroll={{ x: 'max-content' }}
            pagination={{ pageSize: 25, hideOnSinglePage: true }}
            columns={[
              {
                title: 'Ảnh', width: 92, render: (_: unknown, r: Row) => {
                  const n = r.gallery?.length ?? (r.image_url ? 1 : 0)
                  return r.image_url || r.gallery?.[0]
                    ? <div className="tour-thumb" style={{ backgroundImage: `url("${r.image_url ?? r.gallery[0]}")` }}>{n > 1 && <span>{n}</span>}</div>
                    : <div className="tour-thumb empty">Chưa có</div>
                },
              },
              { title: 'Mã', dataIndex: 'code' },
              { title: 'Tên trên web', render: (_: unknown, r: Row) => <a onClick={() => open(r)}><div style={{ maxWidth: 380 }}>{r.name}{r.content_vi?.name && <div className="muted">🇻🇳 {r.content_vi.name}</div>}</div></a> },
              { title: 'Tiếng Việt', render: (_: unknown, r: Row) => <VIProgressTag tour={r} /> },
              { title: 'Trên web', render: (_: unknown, r: Row) => (r.is_published ? (r.is_active ? <Tag color="green">Công khai</Tag> : <Tag color="orange">Công khai, tour ngừng hoạt động</Tag>) : <Tag>Ẩn</Tag>) },
              { title: '', render: (_: unknown, r: Row) => (
                <Space size={4}>
                  <Button size="small" type="link" onClick={() => open(r)}>Sửa nội dung</Button>
                  {r.is_published && <Button size="small" type="link" href={`${STORE_URL}/tour/${encodeURIComponent(r.code)}`} target="_blank">Xem ↗</Button>}
                </Space>
              ) },
            ]} />
        )}
      </Card>
      {editing && <TourEditor mode="web" tour={editing} onClose={() => setParams({}, { replace: true })} />}
    </>
  )
}

// ---- Giá và gói trên web ----
export function WebOptionsPage() {
  return (
    <>
      <PageHead title="Giá và gói trên web" />
      <Card>
        <Typography.Paragraph type="secondary">
          Tên khách thấy, giá trên web, giá theo số người và việc hiện gói trên trang đặt tour. Sức chứa, hạn nhận khách, chính sách vận hành
          và thêm gói mới làm ở khu Điều hành → Tour và gói dịch vụ → Gói dịch vụ.
        </Typography.Paragraph>
        <CrudPage bare title="Gói trên web" table="tour_options" queryKey="tour_options" managePerm="web.manage" order="code" noCreate softDelete={false}
          select="id, tour_id, code, name, is_published, public_name, price_adult, price_child, price_currency, group_prices, child_note, content_vi, tours(name, is_published)"
          search={(s) => `code.ilike.%${s}%,name.ilike.%${s}%,public_name.ilike.%${s}%`}
          columns={[
            { title: 'Mã gói', dataIndex: 'code' },
            { title: 'Tour', render: (_, r) => <div style={{ maxWidth: 260 }}>{r.tours?.name}{!r.tours?.is_published && <Tag style={{ marginLeft: 6 }}>Tour đang ẩn</Tag>}</div> },
            {
              title: 'Tên cho khách (EN / VI)', key: 'public',
              filters: [{ text: 'Thiếu tên tiếng Việt', value: 'missing' }],
              onFilter: (_, r) => !r.content_vi?.public_name,
              render: (_, r) => (
                <div style={{ minWidth: 200 }}>
                  <div>{r.public_name || <span className="muted">{r.name}</span>}</div>
                  {r.content_vi?.public_name ? <div className="muted">🇻🇳 {r.content_vi.public_name}</div> : <Tag color="red">Chưa có tiếng Việt</Tag>}
                </div>
              ),
            },
            { title: 'Giá người lớn', render: (_, r) => (r.price_adult != null ? `${Number(r.price_adult).toLocaleString('vi-VN')} ${r.price_currency}` : <span className="muted">Giá liên hệ</span>) },
            { title: 'Giá theo số người', render: (_, r) => (r.group_prices?.length ? <span className="nowrap">{r.group_prices.length} bậc, từ {Math.min(...r.group_prices.map((t: Row) => t.per_person))} {r.price_currency}</span> : <span className="muted">Không</span>) },
            { title: 'Trên web', render: (_, r) => (r.is_published ? <Tag color="green">Hiện</Tag> : <Tag>Ẩn</Tag>) },
          ]}
          mapBeforeEdit={(r) => ({
            ...r,
            group_prices_text: tiersToText(r.group_prices),
            vi_public_name: r.content_vi?.public_name ?? '',
            vi_child_note: r.content_vi?.child_note ?? '',
          })}
          // Chỉ gửi cột phần web (database chặn người chỉ có quyền Website sửa cột vận hành).
          mapBeforeSave={(v) => ({
            is_published: v.is_published,
            public_name: v.public_name?.trim() || null,
            price_adult: v.price_adult === '' || v.price_adult == null ? null : Number(v.price_adult),
            price_child: v.price_child === '' || v.price_child == null ? null : Number(v.price_child),
            price_currency: v.price_currency,
            group_prices: tiersFromText(v.group_prices_text),
            child_note: v.child_note?.trim() || null,
            content_vi: Object.fromEntries(Object.entries({ public_name: v.vi_public_name?.trim(), child_note: v.vi_child_note?.trim() }).filter(([, x]) => x)),
          })}
          fields={[
            { name: 'is_published', label: 'Hiện trên trang đặt tour', type: 'switch', help: 'Chỉ hiện khi tour của gói cũng đang công khai' },
            { name: 'public_name', label: 'Tên hiển thị cho khách (English)', help: 'Bỏ trống thì dùng tên gói, ví dụ "Small group, 4 hours"' },
            { name: 'vi_public_name', label: 'Tên hiển thị cho khách (Tiếng Việt)', help: 'Ví dụ "Nhóm nhỏ, 4 giờ"; bỏ trống thì hiện bản English' },
            { name: 'price_adult', label: 'Giá người lớn trên web', type: 'money', help: 'Bỏ trống thì khách thấy "Giá liên hệ"' },
            { name: 'price_child', label: 'Giá trẻ em trên web', type: 'money', help: 'Bỏ trống thì tính bằng giá người lớn. Em bé không tính tiền' },
            { name: 'price_currency', label: 'Tiền tệ giá web', type: 'select', defaultValue: 'USD', options: [{ value: 'USD', label: 'USD' }, { value: 'VND', label: 'VND' }, { value: 'EUR', label: 'EUR' }] },
            { name: 'group_prices_text', label: 'Giá mỗi khách theo số người (tour riêng)', type: 'textarea',
              help: 'Mỗi dòng một bậc: "2: 199", "3-4: 180", "7+: 160". Có bảng này thì mọi khách trả tiền (trừ em bé) tính theo bậc khớp số khách.' },
            { name: 'child_note', label: 'Ghi chú giá trẻ em / tour riêng (English)', help: 'Hiện dưới phần chọn số khách, ví dụ "Kids under 12: 30% off"' },
            { name: 'vi_child_note', label: 'Ghi chú giá trẻ em / tour riêng (Tiếng Việt)' },
          ]}
          emptyText="Chưa có gói dịch vụ" />
      </Card>
    </>
  )
}

// ---- Nội dung trang, email ----
export function WebContentPage() {
  return (
    <>
      <PageHead title="Nội dung trang đặt tour" extra={<Button href={STORE_URL} target="_blank">Xem trang ↗</Button>} />
      <Card><StorefrontTab /></Card>
    </>
  )
}

export function WebEmailPage() {
  return (
    <>
      <PageHead title="Email thông báo" />
      <Card><EmailTab /></Card>
      <div className="muted" style={{ marginTop: 12 }}>Yêu cầu đặt tour mới cũng hiện ở chuông thông báo và trang <Link to="/web/requests">Yêu cầu đặt tour</Link>.</div>
    </>
  )
}
