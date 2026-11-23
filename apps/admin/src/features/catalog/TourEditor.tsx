// Thêm / sửa tour: thông tin chung, bộ ảnh, nội dung trang khách. Công tắc English / Tiếng Việt đổi các ô chữ
// (tên, nhãn thời lượng, nội dung) giữa bản gốc tiếng Anh và bản tiếng Việt (content_vi).
// Danh sách (điểm nổi bật, bao gồm...) nhập mỗi dòng một mục. Lịch trình là các bước có tiêu đề và mô tả.
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { App, Alert, Button, Col, Drawer, Form, Input, InputNumber, Row as AntRow, Segmented, Space, Switch, Tabs, Tag } from 'antd'
import { useMemo, useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { friendlyError, supabase, type Row } from '../../lib/supabase'
import { TourGallery } from './TourGallery'
import { viProgress } from './translation'
import './catalog.css'

type Step = { title: string; description: string }
const LIST_KEYS = ['highlights', 'inclusions', 'exclusions', 'what_to_bring', 'good_to_know'] as const

const toText = (v: unknown) => (Array.isArray(v) ? v.join('\n') : '')
const fromText = (v: unknown) => String(v ?? '').split('\n').map((s) => s.trim()).filter(Boolean)
const toSteps = (v: unknown): Step[] =>
  Array.isArray(v) ? v.map((s) => (typeof s === 'string' ? { title: s, description: '' } : { title: s?.title ?? '', description: s?.description ?? '' })) : []
const cleanSteps = (v: Step[] | undefined) =>
  (v ?? []).map((s) => ({ title: (s?.title ?? '').trim(), description: (s?.description ?? '').trim() })).filter((s) => s.title || s.description)
const blank = (v: unknown) => (typeof v === 'string' ? v.trim() || null : v ?? null)

function ContentFields({ prefix }: { prefix: string[] }) {
  const n = (k: string) => [...prefix, k]
  return (
    <>
      <Form.Item name={n('description')} label="Giới thiệu" help="Vài đoạn ngắn, cách nhau một dòng trống">
        <Input.TextArea rows={5} />
      </Form.Item>
      <Form.Item name={n('highlights')} label="Điểm nổi bật" help="Mỗi dòng một ý, tối đa 12">
        <Input.TextArea rows={4} />
      </Form.Item>
      <Form.Item label="Lịch trình" required={false}>
        <Form.List name={n('itinerary')}>
          {(fields, { add, remove, move }) => (
            <>
              {fields.map((f, i) => (
                <div key={f.key} className="step-edit">
                  <span className="step-no">{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <Form.Item name={[f.name, 'title']} style={{ marginBottom: 6 }}>
                      <Input placeholder="Tiêu đề, ví dụ 08:00 – Đón tại khách sạn" />
                    </Form.Item>
                    <Form.Item name={[f.name, 'description']} style={{ marginBottom: 0 }}>
                      <Input.TextArea rows={2} placeholder="Mô tả ngắn" />
                    </Form.Item>
                  </div>
                  <Space direction="vertical" size={4}>
                    <Button size="small" disabled={i === 0} onClick={() => move(i, i - 1)}>↑</Button>
                    <Button size="small" disabled={i === fields.length - 1} onClick={() => move(i, i + 1)}>↓</Button>
                    <Button size="small" danger icon={<DeleteOutlined />} onClick={() => remove(f.name)} />
                  </Space>
                </div>
              ))}
              <Button icon={<PlusOutlined />} onClick={() => add({ title: '', description: '' })}>Thêm bước</Button>
            </>
          )}
        </Form.List>
      </Form.Item>
      <AntRow gutter={16}>
        <Col span={12}><Form.Item name={n('inclusions')} label="Bao gồm" help="Mỗi dòng một mục"><Input.TextArea rows={4} /></Form.Item></Col>
        <Col span={12}><Form.Item name={n('exclusions')} label="Không bao gồm" help="Mỗi dòng một mục"><Input.TextArea rows={4} /></Form.Item></Col>
      </AntRow>
      <Form.Item name={n('joining_instructions')} label="Điểm hẹn và đón"><Input.TextArea rows={2} /></Form.Item>
      <AntRow gutter={16}>
        <Col span={12}><Form.Item name={n('what_to_bring')} label="Nên mang theo" help="Mỗi dòng một mục"><Input.TextArea rows={3} /></Form.Item></Col>
        <Col span={12}><Form.Item name={n('good_to_know')} label="Lưu ý" help="Mỗi dòng một mục"><Input.TextArea rows={3} /></Form.Item></Col>
      </AntRow>
    </>
  )
}

// Số mục đã dịch, cập nhật theo ô đang nhập.
function ViBadge({ form }: { form: ReturnType<typeof Form.useForm>[0] }) {
  const values = Form.useWatch([], form) as Row | undefined
  if (!values) return null
  const toTour = (src: Row) => ({
    ...src,
    highlights: fromText(src.highlights), inclusions: fromText(src.inclusions), exclusions: fromText(src.exclusions),
    what_to_bring: fromText(src.what_to_bring), good_to_know: fromText(src.good_to_know), itinerary: cleanSteps(src.itinerary),
  })
  const p = viProgress({ ...toTour(values), content_vi: toTour(values.vi ?? {}) })
  return <Tag color={p.done >= p.total ? 'green' : p.done ? 'gold' : 'default'} style={{ marginInlineEnd: 0 }}>{p.done}/{p.total}</Tag>
}

export function TourEditor({ tour, onClose }: { tour: Row; onClose: () => void }) {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const isNew = !tour.id
  const [lang, setLang] = useState<'en' | 'vi'>('en')
  const vi = lang === 'vi'
  const [gallery, setGallery] = useState<string[]>(() => (tour.gallery?.length ? tour.gallery : tour.image_url ? [tour.image_url] : []))
  // Thư mục ảnh: theo id tour; tour mới chưa có id thì dùng một mã tạm.
  const folder = useMemo(() => tour.id ?? `new-${crypto.randomUUID().slice(0, 8)}`, [tour.id])

  const initial = useMemo(() => {
    const vi = (tour.content_vi ?? {}) as Row
    const content = (src: Row) => ({
      ...Object.fromEntries(LIST_KEYS.map((k) => [k, toText(src[k])])),
      itinerary: toSteps(src.itinerary),
      description: src.description ?? '',
      joining_instructions: src.joining_instructions ?? '',
    })
    return {
      code: tour.code, name: tour.name, destination: tour.destination, duration_minutes: tour.duration_minutes,
      duration_label: tour.duration_label, group_max: tour.group_max, default_timezone: tour.default_timezone ?? 'Asia/Ho_Chi_Minh',
      is_active: tour.is_active ?? true, is_published: tour.is_published ?? false,
      ...content(tour),
      vi: { name: vi.name ?? '', duration_label: vi.duration_label ?? '', ...content(vi) },
    }
  }, [tour])

  const save = useMutation({
    mutationFn: async (v: Row) => {
      const content = (src: Row) => ({
        description: blank(src.description),
        joining_instructions: blank(src.joining_instructions),
        itinerary: cleanSteps(src.itinerary),
        ...Object.fromEntries(LIST_KEYS.map((k) => [k, fromText(src[k])])),
      })
      const main = content(v)
      if (fromText(v.highlights).length > 12 || fromText(v.vi?.highlights).length > 12) throw new Error('Điểm nổi bật tối đa 12 dòng')
      const viRaw = { name: blank(v.vi?.name), duration_label: blank(v.vi?.duration_label), ...content(v.vi ?? {}) }
      // Chỉ lưu khóa tiếng Việt có nội dung; thiếu khóa nào thì trang khách dùng bản gốc.
      const content_vi = Object.fromEntries(Object.entries(viRaw).filter(([, x]) => (Array.isArray(x) ? x.length > 0 : x != null)))
      const payload = {
        code: String(v.code).trim(), name: String(v.name).trim(), destination: blank(v.destination),
        duration_minutes: v.duration_minutes ?? null, duration_label: blank(v.duration_label), group_max: v.group_max ?? null,
        default_timezone: v.default_timezone, is_active: v.is_active, is_published: v.is_published,
        ...main, gallery, image_url: gallery[0] ?? null, content_vi,
      }
      const res = isNew
        ? await supabase.from('tours').insert({ ...payload, organization_id: orgId }).select('id')
        : await supabase.from('tours').update(payload).eq('id', tour.id).select('id')
      if (res.error) throw new Error(friendlyError(res.error))
      if (!res.data?.length) throw new Error('Bạn không có quyền sửa dữ liệu này.')
    },
    onSuccess: () => {
      message.success('Đã lưu tour')
      for (const k of ['tours', 'tours-lite']) qc.invalidateQueries({ queryKey: [k] })
      onClose()
    },
    onError: (e: Error) => message.error(e.message),
  })

  // Chép bản tiếng Anh vào các ô tiếng Việt còn trống, để dịch đè lên thay vì gõ lại từ đầu.
  const copyEmpty = () => {
    const v = form.getFieldsValue(true) as Row
    const cur = (v.vi ?? {}) as Row
    const empty = (x: unknown) => (Array.isArray(x) ? x.length === 0 : !String(x ?? '').trim())
    const next = { ...cur }
    let n = 0
    for (const k of ['name', 'duration_label', 'description', 'joining_instructions', 'itinerary', ...LIST_KEYS]) {
      if (empty(cur[k]) && !empty(v[k])) { next[k] = k === 'itinerary' ? toSteps(v[k]) : v[k]; n++ }
    }
    form.setFieldValue('vi', next)
    message.info(n ? `Đã chép ${n} mục từ bản English, hãy dịch rồi Lưu.` : 'Không có ô trống để chép.')
  }

  return (
    <Drawer open width="min(900px, 100vw)" onClose={onClose} destroyOnClose
      title={isNew ? 'Thêm tour' : `Sửa tour ${tour.code}`}
      extra={<Space><Button onClick={onClose}>Hủy</Button><Button type="primary" loading={save.isPending} onClick={() => form.submit()}>Lưu</Button></Space>}>
      <Form form={form} layout="vertical" initialValues={initial} onFinish={(v) => save.mutate(v)}
        onFinishFailed={() => { setLang('en'); message.error('Còn ô bắt buộc chưa nhập ở tab Thông tin (English)') }}>
        <Space style={{ marginBottom: 8 }} wrap>
          <Segmented value={lang} onChange={(v) => setLang(v as 'en' | 'vi')} options={[
            { value: 'en', label: 'English' },
            { value: 'vi', label: <Space size={6}>Tiếng Việt<ViBadge form={form} /></Space> },
          ]} />
          <span className="muted">Đổi ngôn ngữ cho tên, nhãn thời lượng và tab Nội dung.</span>
        </Space>
        <Tabs items={[
          {
            key: 'info', label: 'Thông tin', forceRender: true, children: (
              <>
                <AntRow gutter={16}>
                  <Col span={8}><Form.Item name="code" label="Mã tour" rules={[{ required: true, message: 'Nhập mã tour' }]}><Input /></Form.Item></Col>
                  <Col span={16}>
                    <Form.Item name="name" label="Tên tour (English)" rules={[{ required: true, message: 'Nhập tên tour tiếng Anh' }]} hidden={vi}><Input /></Form.Item>
                    <Form.Item name={['vi', 'name']} label="Tên tour (Tiếng Việt)" hidden={!vi}><Input placeholder={tour.name} /></Form.Item>
                  </Col>
                </AntRow>
                <AntRow gutter={16}>
                  <Col span={8}><Form.Item name="destination" label="Điểm đến"><Input placeholder="Hanoi" /></Form.Item></Col>
                  <Col span={8}><Form.Item name="duration_minutes" label="Thời lượng (phút)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item></Col>
                  <Col span={8}>
                    <Form.Item name="duration_label" label="Nhãn thời lượng (English)" help='Ví dụ "2 days, 1 night"' hidden={vi}><Input /></Form.Item>
                    <Form.Item name={['vi', 'duration_label']} label="Nhãn thời lượng (Tiếng Việt)" help='Ví dụ "2 ngày 1 đêm"' hidden={!vi}><Input /></Form.Item>
                  </Col>
                </AntRow>
                <AntRow gutter={16}>
                  <Col span={8}><Form.Item name="group_max" label="Số khách tối đa mỗi nhóm"><InputNumber min={1} max={100} style={{ width: '100%' }} /></Form.Item></Col>
                  <Col span={8}><Form.Item name="default_timezone" label="Múi giờ" rules={[{ required: true }]}><Input /></Form.Item></Col>
                </AntRow>
                <AntRow gutter={16}>
                  <Col span={8}><Form.Item name="is_active" label="Đang hoạt động" valuePropName="checked"><Switch /></Form.Item></Col>
                  <Col span={16}><Form.Item name="is_published" label="Công khai trên trang đặt tour" valuePropName="checked"
                    help="Khách thấy tour, ảnh, nội dung, gói, giá và lịch còn chỗ"><Switch /></Form.Item></Col>
                </AntRow>
              </>
            ),
          },
          {
            key: 'images', label: `Ảnh (${gallery.length})`, forceRender: true,
            children: <TourGallery value={gallery} onChange={setGallery} orgId={orgId} folder={folder} />,
          },
          {
            key: 'content', label: 'Nội dung', forceRender: true, children: (
              <>
                {vi && (
                  <Alert type="info" showIcon style={{ marginBottom: 16 }}
                    message="Khách chọn tiếng Việt thấy các ô có nội dung ở đây; ô nào để trống thì hiện bản tiếng Anh."
                    action={<Button size="small" onClick={copyEmpty}>Chép bản English vào ô trống</Button>} />
                )}
                <div style={{ display: vi ? 'none' : undefined }}><ContentFields prefix={[]} /></div>
                <div style={{ display: vi ? undefined : 'none' }}><ContentFields prefix={['vi']} /></div>
              </>
            ),
          },
        ]} />
      </Form>
    </Drawer>
  )
}
