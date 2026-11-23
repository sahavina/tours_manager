// Tab "Trang đặt tour": sửa organizations.storefront_settings (liên hệ, chính sách hủy, khối "Vì sao chọn",
// thẻ đánh giá và widget TripAdvisor). Trang đặt tour đọc thẳng cột này nên lưu xong là khách thấy ngay.
import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Col, Divider, Form, Input, InputNumber, Row as ARow, Select, Space, Typography, type FormListFieldData, type FormListOperation } from 'antd'
import { useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState } from '../../components/common'
import { friendlyError, supabase, unwrap } from '../../lib/supabase'

type Settings = Record<string, unknown> & {
  contact?: { whatsapp?: string; zalo?: string; email?: string; phone?: string }
  cancel_free_hours?: number
  why?: { icon: string; title: string; text: string; vi?: { title?: string; text?: string } }[]
  reviews?: { provider: string; name?: string; url: string; categories?: string[] }[]
  review_widgets?: { provider: 'tripadvisor'; type: string; location_id: string; uniq: string; lang?: string }[]
  destinations_vi?: Record<string, string>
}

const ICONS = [
  { value: 'local', label: 'Bản đồ (người địa phương)' },
  { value: 'jeep', label: 'Xe jeep' },
  { value: 'group', label: 'Nhóm nhỏ' },
  { value: 'calendar', label: 'Lịch linh hoạt' },
  { value: 'chat', label: 'Hỗ trợ trò chuyện' },
  { value: 'shield', label: 'An toàn' },
  { value: 'heart', label: 'Trái tim' },
  { value: 'food', label: 'Ẩm thực' },
]

const https = { pattern: /^https:\/\/\S+$/, message: 'Phải là link https://' }

// Đọc mã nhúng TripAdvisor (đoạn <div id="TA_..."> và <script src=".../wejs?wtype=...&uniq=...&locationId=...">).
export function parseTripadvisorEmbed(code: string) {
  const src = code.match(/wejs\?([^"'\s>]+)/)?.[1]
  if (!src) return null
  const p = new URLSearchParams(src.replace(/&amp;/g, '&'))
  const type = p.get('wtype'), uniq = p.get('uniq'), location_id = p.get('locationId')
  if (!type || !uniq || !location_id) return null
  return { provider: 'tripadvisor' as const, type, uniq, location_id, lang: p.get('lang') ?? 'en_US' }
}

function MoveButtons({ field, ops, total }: { field: FormListFieldData; ops: FormListOperation; total: number }) {
  return (
    <Space size={4}>
      <Button size="small" icon={<ArrowUpOutlined />} disabled={field.name === 0} onClick={() => ops.move(field.name, field.name - 1)} aria-label="Lên" />
      <Button size="small" icon={<ArrowDownOutlined />} disabled={field.name === total - 1} onClick={() => ops.move(field.name, field.name + 1)} aria-label="Xuống" />
      <Button size="small" danger icon={<DeleteOutlined />} onClick={() => ops.remove(field.name)} aria-label="Xóa" />
    </Space>
  )
}

export function StorefrontTab() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const [embed, setEmbed] = useState('')
  const editable = can('org.manage')

  const q = useQuery({
    queryKey: ['org-storefront', orgId],
    queryFn: async () => {
      const row = unwrap(await supabase.from('organizations').select('storefront_settings').eq('id', orgId).single()) as { storefront_settings: Settings | null }
      return row.storefront_settings ?? {}
    },
  })
  // Ảnh có sẵn trong bộ ảnh các tour, để chọn làm ảnh thẻ đánh giá.
  const images = useQuery({
    queryKey: ['org-storefront-images', orgId],
    queryFn: async () => {
      const rows = unwrap(await supabase.from('tours').select('code, name, image_url, gallery').eq('organization_id', orgId).is('deleted_at', null).order('code')) as
        { code: string; name: string; image_url: string | null; gallery: string[] | null }[]
      const seen = new Set<string>()
      return rows.flatMap((t) => [...(t.gallery ?? []), ...(t.image_url ? [t.image_url] : [])].filter((u) => !seen.has(u) && seen.add(u))
        .map((u, i) => ({ value: u, label: `${t.code} · ảnh ${i + 1}` })))
    },
  })

  // Các điểm đến đang dùng trong tour, để nhập tên tiếng Việt.
  const places = useQuery({
    queryKey: ['org-storefront-places', orgId],
    queryFn: async () => {
      const rows = unwrap(await supabase.from('tours').select('destination').eq('organization_id', orgId).is('deleted_at', null)) as { destination: string | null }[]
      return [...new Set(rows.map((r) => r.destination?.trim()).filter(Boolean) as string[])].sort()
    },
  })

  const save = useMutation({
    mutationFn: async (v: Settings) => {
      const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined && x !== null && x !== '' && !(Array.isArray(x) && !x.length)))
      // Bản tiếng Việt của thẻ/widget: bỏ ô trống, không còn gì thì bỏ khóa vi.
      const withVi = <T extends Record<string, unknown>>(o: T) => {
        const vi = clean((o.vi ?? {}) as Record<string, unknown>)
        const { vi: _v, ...rest } = o
        return clean(Object.keys(vi).length ? { ...rest, vi } : rest)
      }
      const next: Settings = {
        ...(q.data ?? {}),
        contact: clean(v.contact ?? {}),
        cancel_free_hours: v.cancel_free_hours ?? undefined,
        why: (v.why ?? []).map((w) => ({ ...w, vi: clean(w.vi ?? {}) })).map((w) => (Object.keys(w.vi).length ? w : { icon: w.icon, title: w.title, text: w.text })),
        reviews: (v.reviews ?? []).map((r) => withVi(r) as NonNullable<Settings['reviews']>[number]),
        review_widgets: (v.review_widgets ?? []).map((w) => withVi(w) as NonNullable<Settings['review_widgets']>[number]),
        destinations_vi: Object.fromEntries(Object.entries(v.destinations_vi ?? {}).map(([k, x]) => [k, String(x ?? '').trim()]).filter(([, x]) => x)),
      }
      if (next.cancel_free_hours == null) delete next.cancel_free_hours
      if (!next.review_widgets?.length) delete next.review_widgets
      if (!Object.keys(next.destinations_vi ?? {}).length) delete next.destinations_vi
      const res = await supabase.from('organizations').update({ storefront_settings: next }).eq('id', orgId).select('id')
      if (res.error) throw new Error(friendlyError(res.error))
      if (!res.data?.length) throw new Error('Bạn không có quyền sửa dữ liệu này.')
    },
    onSuccess: () => { message.success('Đã lưu. Trang đặt tour cập nhật ngay.'); qc.invalidateQueries({ queryKey: ['org-storefront'] }) },
    onError: (e: Error) => message.error(e.message),
  })

  if (q.isLoading) return null
  if (q.isError) return <ErrorState error={q.error} />

  // Ô ảnh dùng chung cho thẻ đánh giá và widget: chọn từ ảnh tour hoặc dán link, kèm ảnh xem trước.
  const imageField = (list: string, idx: number, extra: string) => (
    <>
      <Form.Item name={[idx, 'image']} label="Ảnh" extra={extra}>
        <Select showSearch allowClear options={images.data ?? []} loading={images.isLoading} placeholder="Chọn ảnh tour"
          optionRender={(o) => <Space><img src={String(o.value)} alt="" style={{ width: 48, height: 32, objectFit: 'cover', borderRadius: 4 }} />{o.label}</Space>} />
      </Form.Item>
      <Form.Item name={[idx, 'image']} rules={[https]} style={{ marginTop: -12 }}><Input placeholder="https://..." allowClear /></Form.Item>
      <Form.Item noStyle shouldUpdate>
        {() => {
          const u = form.getFieldValue([list, idx, 'image'])
          return u ? <img src={u} alt="" style={{ width: 160, height: 100, objectFit: 'cover', borderRadius: 8, marginTop: -8, marginBottom: 12 }} /> : null
        }}
      </Form.Item>
    </>
  )

  // Bản tiếng Việt của chữ trên thẻ/widget; ô trống thì khách chọn tiếng Việt vẫn thấy bản English.
  const viFields = (idx: number) => (
    <>
      <Col span={24}><Divider orientation="left" plain style={{ margin: '4px 0 12px' }}>Tiếng Việt (để trống thì dùng bản English)</Divider></Col>
      <Col xs={24} md={12}><Form.Item name={[idx, 'vi', 'name']} label="Tên hiển thị"><Input /></Form.Item></Col>
      <Col xs={24} md={12}><Form.Item name={[idx, 'vi', 'ranking']} label="Xếp hạng" extra="Ví dụ: Hạng 3 / 120 tour ở Hà Nội"><Input /></Form.Item></Col>
      <Col xs={24} md={8}><Form.Item name={[idx, 'vi', 'location']} label="Địa điểm"><Input placeholder="Hà Nội, Việt Nam" /></Form.Item></Col>
      <Col xs={24} md={8}><Form.Item name={[idx, 'vi', 'award']} label="Giải thưởng"><Input /></Form.Item></Col>
      <Col xs={24} md={8}><Form.Item name={[idx, 'vi', 'categories']} label="Nhóm dịch vụ"><Select mode="tags" open={false} tokenSeparators={[',']} /></Form.Item></Col>
    </>
  )

  const addEmbed = () => {
    const w = parseTripadvisorEmbed(embed)
    if (!w) return message.error('Không đọc được mã. Hãy dán nguyên đoạn mã nhúng TripAdvisor (có thẻ <script ... wejs?wtype=...>).')
    const list = (form.getFieldValue('review_widgets') ?? []) as NonNullable<Settings['review_widgets']>
    form.setFieldValue('review_widgets', [...list.filter((x) => !(x.type === w.type && x.uniq === w.uniq)), w])
    setEmbed('')
    message.success('Đã thêm widget, bấm Lưu để áp dụng.')
  }

  return (
    <Form form={form} layout="vertical" disabled={!editable} initialValues={q.data} key={orgId} onFinish={(v) => save.mutate(v)} style={{ maxWidth: 980 }}>
      {!editable && <Alert type="info" showIcon message="Bạn chỉ xem được; cần quyền quản lý doanh nghiệp để sửa." style={{ marginBottom: 16 }} />}

      <Typography.Title level={5}>Liên hệ và chính sách</Typography.Title>
      <ARow gutter={16}>
        <Col xs={24} md={12}><Form.Item name={['contact', 'whatsapp']} label="WhatsApp" extra="Số quốc tế, ví dụ +84..."><Input /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item name={['contact', 'zalo']} label="Zalo"><Input /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item name={['contact', 'email']} label="Email" rules={[{ type: 'email', message: 'Email chưa đúng' }]}><Input /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item name={['contact', 'phone']} label="Điện thoại"><Input /></Form.Item></Col>
        <Col xs={24} md={12}><Form.Item name="cancel_free_hours" label="Hủy miễn phí trước (giờ)" extra="Để trống thì trang không hiện dòng hủy miễn phí."><InputNumber min={0} max={720} style={{ width: '100%' }} /></Form.Item></Col>
      </ARow>

      <Divider />
      <Typography.Title level={5}>Vì sao chọn chúng tôi</Typography.Title>
      <Form.List name="why">
        {(fields, ops) => (
          <>
            {fields.map((f) => (
              <Card key={f.key} size="small" style={{ marginBottom: 12 }} title={`Mục ${f.name + 1}`} extra={<MoveButtons field={f} ops={ops} total={fields.length} />}>
                <ARow gutter={12}>
                  <Col xs={24} md={6}><Form.Item name={[f.name, 'icon']} label="Biểu tượng" rules={[{ required: true }]}><Select options={ICONS} /></Form.Item></Col>
                  <Col xs={24} md={9}><Form.Item name={[f.name, 'title']} label="Tiêu đề (tiếng Anh)" rules={[{ required: true }]}><Input /></Form.Item></Col>
                  <Col xs={24} md={9}><Form.Item name={[f.name, 'vi', 'title']} label="Tiêu đề (tiếng Việt)"><Input /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'text']} label="Nội dung (tiếng Anh)" rules={[{ required: true }]}><Input.TextArea autoSize={{ minRows: 2 }} /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'vi', 'text']} label="Nội dung (tiếng Việt)"><Input.TextArea autoSize={{ minRows: 2 }} /></Form.Item></Col>
                </ARow>
              </Card>
            ))}
            <Button icon={<PlusOutlined />} onClick={() => ops.add({ icon: 'heart' })} disabled={!editable || fields.length >= 8}>Thêm mục</Button>
          </>
        )}
      </Form.List>

      <Divider />
      <Typography.Title level={5}>Điểm đến (tên tiếng Việt)</Typography.Title>
      <Typography.Paragraph type="secondary">Tên gốc lấy từ ô "Điểm đến" của các tour. Khách chọn tiếng Việt thấy tên ở đây; để trống thì giữ tên gốc.</Typography.Paragraph>
      <ARow gutter={12}>
        {(places.data ?? []).map((d) => (
          <Col key={d} xs={24} sm={12} md={8}>
            <Form.Item name={['destinations_vi', d]} label={d}><Input placeholder={d} /></Form.Item>
          </Col>
        ))}
        {!places.isLoading && !places.data?.length && <Col span={24}><Typography.Text type="secondary">Chưa có tour nào nhập điểm đến.</Typography.Text></Col>}
      </ARow>

      <Divider />
      <Typography.Title level={5}>Thẻ đánh giá ở chân trang</Typography.Title>
      <Typography.Paragraph type="secondary">Điểm và số đánh giá do bạn nhập, trang không tự cập nhật từ TripAdvisor. Hãy sao chép đúng số đang hiện trên trang của bạn.</Typography.Paragraph>
      <Form.List name="reviews">
        {(fields, ops) => (
          <>
            {fields.map((f) => (
              <Card key={f.key} size="small" style={{ marginBottom: 12 }} title={form.getFieldValue(['reviews', f.name, 'name']) || `Thẻ ${f.name + 1}`} extra={<MoveButtons field={f} ops={ops} total={fields.length} />}>
                <ARow gutter={12}>
                  <Col xs={24} md={6}><Form.Item name={[f.name, 'provider']} label="Nguồn" rules={[{ required: true }]}><Select options={[{ value: 'tripadvisor', label: 'Tripadvisor' }, { value: 'Google', label: 'Google' }]} /></Form.Item></Col>
                  <Col xs={24} md={18}><Form.Item name={[f.name, 'name']} label="Tên hiển thị"><Input /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'url']} label="Link trang đánh giá" rules={[{ required: true }, https]}><Input /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'write_url']} label="Link viết đánh giá" rules={[https]}><Input /></Form.Item></Col>
                  <Col xs={12} md={4}><Form.Item name={[f.name, 'rating']} label="Điểm (0–5)"><InputNumber min={0} max={5} step={0.5} style={{ width: '100%' }} /></Form.Item></Col>
                  <Col xs={12} md={4}><Form.Item name={[f.name, 'count']} label="Số đánh giá"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
                  <Col xs={24} md={16}><Form.Item name={[f.name, 'ranking']} label="Xếp hạng" extra="Ví dụ: #3 of 120 Tours in Hanoi"><Input /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'categories']} label="Nhóm dịch vụ" extra="Gõ rồi Enter để thêm"><Select mode="tags" open={false} tokenSeparators={[',']} /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'location']} label="Địa điểm"><Input /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'award']} label="Giải thưởng" extra="Ví dụ: Travellers' Choice 2025"><Input /></Form.Item></Col>
                  <Col xs={24} md={12}>
                    {imageField('reviews', f.name, 'Chọn từ ảnh tour, hoặc dán link https:// vào ô dưới')}
                  </Col>
                  {viFields(f.name)}
                </ARow>
              </Card>
            ))}
            <Button icon={<PlusOutlined />} onClick={() => ops.add({ provider: 'tripadvisor' })} disabled={!editable}>Thêm thẻ đánh giá</Button>
          </>
        )}
      </Form.List>

      <Divider />
      <Typography.Title level={5}>Widget TripAdvisor</Typography.Title>
      <Typography.Paragraph type="secondary">Dán mã nhúng lấy ở TripAdvisor (Management Center → Widgets). Widget hiện ở chân trang, dưới các thẻ đánh giá. Điểm, số đánh giá, địa điểm... của widget để trống thì lấy từ thẻ đánh giá cùng locationId.</Typography.Paragraph>
      <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
        <Input.TextArea value={embed} onChange={(e) => setEmbed(e.target.value)} placeholder='<div id="TA_..."> ... <script src="https://www.jscache.com/wejs?wtype=...">' autoSize={{ minRows: 2, maxRows: 6 }} />
        <Button type="default" onClick={addEmbed} disabled={!editable || !embed.trim()}>Đọc mã</Button>
      </Space.Compact>
      <Form.List name="review_widgets">
        {(fields, ops) => (
          <>
            {fields.map((f) => (
              <Card key={f.key} size="small" style={{ marginBottom: 12 }} title={`Widget ${f.name + 1}`} extra={<MoveButtons field={f} ops={ops} total={fields.length} />}>
                <Form.Item name={[f.name, 'provider']} hidden initialValue="tripadvisor"><Input /></Form.Item>
                <ARow gutter={12}>
                  <Col xs={24} md={8}><Form.Item name={[f.name, 'type']} label="Loại (wtype)" rules={[{ required: true, pattern: /^\w+$/ }]}><Input /></Form.Item></Col>
                  <Col xs={12} md={6}><Form.Item name={[f.name, 'location_id']} label="locationId" rules={[{ required: true, pattern: /^\d+$/ }]}><Input /></Form.Item></Col>
                  <Col xs={12} md={5}><Form.Item name={[f.name, 'uniq']} label="uniq" rules={[{ required: true, pattern: /^\d+$/ }]}><Input /></Form.Item></Col>
                  <Col xs={24} md={5}><Form.Item name={[f.name, 'lang']} label="Ngôn ngữ"><Input placeholder="en_US" /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'url']} label="Link trang đánh giá" rules={[https]}><Input /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'write_url']} label="Link viết đánh giá" rules={[https]}><Input /></Form.Item></Col>
                  <Col xs={12} md={4}><Form.Item name={[f.name, 'rating']} label="Điểm (0–5)"><InputNumber min={0} max={5} step={0.5} style={{ width: '100%' }} /></Form.Item></Col>
                  <Col xs={12} md={4}><Form.Item name={[f.name, 'count']} label="Số đánh giá"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item></Col>
                  <Col xs={24} md={16}><Form.Item name={[f.name, 'ranking']} label="Xếp hạng" extra="Ví dụ: #3 of 120 Tours in Hanoi"><Input /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'categories']} label="Nhóm dịch vụ" extra="Gõ rồi Enter để thêm"><Select mode="tags" open={false} tokenSeparators={[',']} /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'location']} label="Địa điểm"><Input /></Form.Item></Col>
                  <Col xs={24} md={12}><Form.Item name={[f.name, 'award']} label="Giải thưởng" extra="Ví dụ: Travellers' Choice 2025"><Input /></Form.Item></Col>
                  <Col xs={24} md={12}>{imageField('review_widgets', f.name, 'Ảnh đầu khung widget. Để trống thì dùng ảnh của thẻ đánh giá cùng địa điểm.')}</Col>
                  {viFields(f.name)}
                </ARow>
              </Card>
            ))}
            {!fields.length && <Typography.Text type="secondary">Chưa có widget.</Typography.Text>}
          </>
        )}
      </Form.List>

      <Divider />
      <Button type="primary" htmlType="submit" loading={save.isPending} disabled={!editable}>Lưu</Button>
    </Form>
  )
}
