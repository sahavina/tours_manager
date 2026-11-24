import { PlusOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { App, Button, Card, Drawer, Form, Input, InputNumber, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { ErrorState, NoData, PageHead } from './common'
import { friendlyError, supabase, type Row } from '../lib/supabase'

export type Field = {
  name: string
  label: string
  type?: 'text' | 'textarea' | 'number' | 'switch' | 'select' | 'tags' | 'money'
  required?: boolean
  options?: Array<{ value: string; label: string }>
  defaultValue?: unknown
  min?: number
  help?: string
}

type Props = {
  title: ReactNode
  table: string
  select?: string
  queryKey: string
  managePerm: string
  columns: ColumnsType<Row>
  fields: Field[]
  softDelete?: boolean
  order?: string
  search?: (q: string) => string
  extra?: ReactNode
  bare?: boolean
  emptyText?: string
  mapBeforeSave?: (values: Row) => Row
  /** Đổi dòng dữ liệu trước khi đưa vào form sửa (ví dụ mảng JSON thành chữ). */
  mapBeforeEdit?: (row: Row) => Row
  /** Mở form riêng thay cho form chung (null = thêm mới). */
  onEdit?: (row: Row | null) => void
  /** Không cho thêm mới ở trang này (ví dụ khu Website chỉ sửa phần web của gói có sẵn). */
  noCreate?: boolean
}

/** Bảng danh mục đơn giản qua PostgREST + RLS. Không dùng cho bảng có bất biến xuyên bảng (booking, chuyến). */
export function CrudPage(p: Props) {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Row | null>(null)
  // Tìm nhanh ở header mở trang này kèm ?q=...
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('q') ?? '')
  const [form] = Form.useForm()
  const canManage = can(p.managePerm)

  const list = useQuery({
    queryKey: [p.queryKey, orgId, q],
    enabled: Boolean(orgId),
    queryFn: async () => {
      let query = supabase.from(p.table).select(p.select ?? '*').eq('organization_id', orgId).limit(500)
      if (p.softDelete) query = query.is('deleted_at', null)
      if (q && p.search) query = query.or(p.search(q.replace(/[,()%]/g, ' ')))
      query = query.order(p.order ?? 'created_at', { ascending: Boolean(p.order) })
      const { data, error } = await query
      if (error) throw new Error(friendlyError(error))
      return data as unknown as Row[]
    },
  })

  const save = useMutation({
    mutationFn: async (values: Row) => {
      const payload = p.mapBeforeSave ? p.mapBeforeSave(values) : values
      const res = editing?.id
        ? await supabase.from(p.table).update(payload).eq('id', editing.id).select('id')
        : await supabase.from(p.table).insert({ ...payload, organization_id: orgId }).select('id')
      if (res.error) throw new Error(friendlyError(res.error))
      // RLS chặn UPDATE thì khớp 0 dòng và KHÔNG báo lỗi: phải đếm, không được báo đã lưu.
      if (!res.data || res.data.length === 0) throw new Error('Bạn không có quyền sửa dữ liệu này.')
    },
    onSuccess: () => {
      message.success('Đã lưu')
      setEditing(null)
      qc.invalidateQueries({ queryKey: [p.queryKey] })
    },
    onError: (e: Error) => message.error(e.message),
  })

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await supabase.from(p.table).update({ deleted_at: new Date().toISOString() }).eq('id', id).select('id')
      if (res.error) throw new Error(friendlyError(res.error))
      if (!res.data || res.data.length === 0) throw new Error('Bạn không có quyền xóa dữ liệu này.')
    },
    onSuccess: () => {
      message.success('Đã xóa')
      qc.invalidateQueries({ queryKey: [p.queryKey] })
    },
    onError: (e: Error) => message.error(e.message),
  })

  const [openCount, setOpenCount] = useState(0)
  const open = (row: Row | null) => {
    if (p.onEdit) return p.onEdit(row)
    setOpenCount((n) => n + 1)
    const values = row ? (p.mapBeforeEdit ? p.mapBeforeEdit(row) : row) : {}
    setEditing(values)
  }

  // initialValues, không dùng form.setFieldsValue: Drawer destroyOnClose nên Form chưa mount lúc bấm mở, giá
  // trị đặt trước bị mất; hậu quả là form sửa mở ra trống và trường bắt buộc có mặc định chặn nút Lưu.
  const defaults = Object.fromEntries(p.fields.filter((f) => f.defaultValue !== undefined).map((f) => [f.name, f.defaultValue]))
  // Sau khi khung sửa hiện ra (form đã gắn), nạp đúng giá trị của dòng đang mở. initialValues chỉ áp dụng
  // lần gắn đầu nên không đủ khi đóng rồi mở dòng khác nhanh.
  useEffect(() => {
    if (!editing) return
    form.resetFields()
    form.setFieldsValue(editing.id ? editing : defaults)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, openCount])

  const columns: ColumnsType<Row> = [
    ...p.columns,
    ...(canManage
      ? [{
          title: '', key: '_actions', width: 130, fixed: 'right' as const,
          render: (_: unknown, row: Row) => (
            <Space size={4}>
              <Button size="small" type="link" onClick={() => open(row)}>Sửa</Button>
              {p.softDelete && (
                <Popconfirm title="Xóa mục này?" onConfirm={() => remove.mutate(row.id)} okText="Xóa" cancelText="Hủy">
                  <Button size="small" type="link" danger>Xóa</Button>
                </Popconfirm>
              )}
            </Space>
          ),
        }]
      : []),
  ]

  const body = (
    <>
      <div className="filters">
        {p.search && <Input.Search allowClear placeholder="Tìm kiếm" style={{ maxWidth: 280 }} defaultValue={q} onSearch={setQ} />}
        <div style={{ flex: 1 }} />
        {p.extra}
        {canManage && !p.noCreate && <Button type="primary" icon={<PlusOutlined />} onClick={() => open(null)}>Thêm mới</Button>}
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <Table rowKey="id" size="middle" loading={list.isLoading} dataSource={list.data} columns={columns}
          scroll={{ x: 'max-content' }} pagination={{ pageSize: 25, hideOnSinglePage: true }}
          locale={{ emptyText: <NoData text={p.emptyText} /> }} />
      )}
      <Drawer title={editing?.id ? 'Sửa' : 'Thêm mới'} open={Boolean(editing)} onClose={() => setEditing(null)} width={480} destroyOnClose
        extra={<Button type="primary" loading={save.isPending} onClick={() => form.submit()}>Lưu</Button>}>
        {/* key theo dòng đang sửa: mỗi lần mở dòng khác là form mới với đúng dữ liệu của dòng đó. Không có key,
            đóng rồi mở nhanh dòng khác thì form cũ chưa kịp hủy, hiện dữ liệu dòng trước hoặc ô trống. */}
        <Form key={editing ? String(editing.id ?? 'new') + ':' + openCount : 'closed'} form={form} layout="vertical" onFinish={(v) => save.mutate(v)} preserve={false}
          initialValues={editing?.id ? editing : defaults}>
          {p.fields.map((f) => (
            <Form.Item key={f.name} name={f.name} label={f.label} help={f.help} valuePropName={f.type === 'switch' ? 'checked' : 'value'}
              rules={f.required ? [{ required: true, message: `Nhập ${f.label.toLowerCase()}` }] : undefined}>
              {f.type === 'textarea' ? <Input.TextArea rows={3} />
                : f.type === 'number' ? <InputNumber style={{ width: '100%' }} min={f.min} />
                : f.type === 'money' ? <Input inputMode="decimal" />
                : f.type === 'switch' ? <Switch />
                : f.type === 'select' ? <Select options={f.options} allowClear showSearch optionFilterProp="label" />
                : f.type === 'tags' ? <Select mode="tags" tokenSeparators={[',']} open={false} suffixIcon={null} />
                : <Input />}
            </Form.Item>
          ))}
        </Form>
      </Drawer>
    </>
  )

  if (p.bare) return body
  return (
    <>
      <PageHead title={p.title} />
      <Card>{body}</Card>
    </>
  )
}

export const ActiveTag = ({ value }: { value: boolean }) =>
  value ? <Tag color="green">Hoạt động</Tag> : <Tag>Ngừng</Tag>
