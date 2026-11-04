import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Select, Space } from 'antd'
import dayjs from 'dayjs'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

export function CreateBookingDrawer({ onClose, departureId }: { onClose: () => void; departureId?: string }) {
  const { orgId, org } = useAuth()
  const { message } = App.useApp()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [form] = Form.useForm()
  const optionId = Form.useWatch('tour_option_id', form)

  const options = useQuery({
    queryKey: ['options-with-tour', orgId],
    queryFn: async () => unwrap(await supabase.from('tour_options').select('id, name, code, tour_id, has_transfer, tours(name)')
      .eq('organization_id', orgId).eq('is_active', true).is('deleted_at', null).order('code')) as unknown as Row[],
  })
  const option = options.data?.find((o) => o.id === optionId)

  const departures = useQuery({
    queryKey: ['departures-for-option', orgId, option?.tour_id, optionId],
    enabled: Boolean(option),
    queryFn: async () => unwrap(await supabase.from('v_departure_availability')
      .select('id, local_date, local_time, timezone, available_seats, sale_open, tour_option_id')
      .eq('organization_id', orgId).eq('tour_id', option!.tour_id).eq('status', 'scheduled')
      .or(`tour_option_id.is.null,tour_option_id.eq.${optionId}`)
      .gte('local_date', dayjs().format('YYYY-MM-DD')).order('starts_at').limit(200)) as Row[],
  })
  const categories = useQuery({
    queryKey: ['traveler-categories', orgId],
    queryFn: async () => unwrap(await supabase.from('traveler_categories').select('code, name').eq('organization_id', orgId).order('sort_order')) as Row[],
  })

  const create = useMutation({
    mutationFn: async (v: Row) => {
      const pax = Object.fromEntries(Object.entries(v.pax ?? {}).filter(([, n]) => Number(n) > 0))
      return rpcOk('create_manual_booking', {
        p_org: orgId,
        p_data: {
          tour_option_id: v.tour_option_id, departure_id: v.departure_id,
          lead: { name: v.lead_name, email: v.lead_email, phone: v.lead_phone },
          pax, gross_amount: v.gross_amount?.trim() || undefined,
          currency: v.gross_amount?.trim() ? v.currency : undefined,
          special_requests: v.special_requests,
          ...(v.pickup_hotel || v.pickup_address ? { pickup: { hotel: v.pickup_hotel, address: v.pickup_address } } : {}),
        },
      })
    },
    onSuccess: (res) => {
      message.success(`Đã tạo booking ${res.code}`)
      qc.invalidateQueries({ queryKey: ['bookings'] })
      qc.invalidateQueries({ queryKey: ['departures'] })
      onClose()
      nav(`/bookings/${res.booking_id}`)
    },
    onError: (e: Error) => message.error(e.message),
  })

  return (
    <Drawer title="Tạo booking thủ công" open onClose={onClose} width={520}
      extra={<Button type="primary" loading={create.isPending} onClick={() => form.submit()}>Tạo booking</Button>}>
      <Form form={form} layout="vertical" onFinish={(v) => create.mutate(v)} initialValues={{ currency: org?.default_currency, departure_id: departureId, pax: { adult: 2 } }}>
        <Form.Item name="tour_option_id" label="Tour / gói" rules={[{ required: true, message: 'Chọn gói' }]}>
          <Select showSearch optionFilterProp="label" loading={options.isLoading} onChange={() => form.setFieldValue('departure_id', undefined)}
            options={(options.data ?? []).map((o) => ({ value: o.id, label: `${o.tours?.name} · ${o.name}` }))} />
        </Form.Item>
        <Form.Item name="departure_id" label="Chuyến" rules={[{ required: true, message: 'Chọn chuyến' }]}
          extra={option && !departures.isLoading && departures.data?.length === 0 ? 'Gói này chưa có chuyến sắp tới. Tạo chuyến ở mục Lịch khởi hành.' : undefined}>
          <Select disabled={!option} loading={departures.isLoading}
            options={(departures.data ?? []).map((d) => ({
              value: d.id,
              disabled: d.available_seats <= 0,
              label: `${dayjs(d.local_date).format('DD/MM/YYYY')} ${String(d.local_time).slice(0, 5)} · còn ${d.available_seats} chỗ${d.sale_open ? '' : ' · đang đóng bán'}`,
            }))} />
        </Form.Item>
        <Space wrap>
          {(categories.data ?? []).map((c) => (
            <Form.Item key={c.code} name={['pax', c.code]} label={c.name}><InputNumber min={0} style={{ width: 90 }} /></Form.Item>
          ))}
        </Space>
        <Form.Item name="lead_name" label="Khách đại diện" rules={[{ required: true, message: 'Nhập tên khách' }]}><Input /></Form.Item>
        <Space.Compact block>
          <Form.Item name="lead_email" label="Email" style={{ flex: 1 }} rules={[{ type: 'email', message: 'Email chưa hợp lệ' }]}><Input /></Form.Item>
          <Form.Item name="lead_phone" label="Điện thoại" style={{ flex: 1 }}><Input /></Form.Item>
        </Space.Compact>
        {option?.has_transfer && (
          <>
            <Form.Item name="pickup_hotel" label="Khách sạn đón"><Input /></Form.Item>
            <Form.Item name="pickup_address" label="Địa chỉ đón"><Input /></Form.Item>
          </>
        )}
        <Space.Compact block>
          <Form.Item name="gross_amount" label="Giá trị bán" style={{ flex: 2 }} rules={[{ pattern: /^\d+(\.\d+)?$/, message: 'Nhập số, dùng dấu chấm cho phần lẻ' }]}><Input inputMode="decimal" placeholder="Bỏ trống nếu chưa biết" /></Form.Item>
          <Form.Item name="currency" label="Tiền tệ" style={{ flex: 1 }} rules={[{ pattern: /^[A-Z]{3}$/, message: '3 chữ in hoa' }]}><Input /></Form.Item>
        </Space.Compact>
        <Form.Item name="special_requests" label="Yêu cầu đặc biệt"><Input.TextArea rows={2} /></Form.Item>
        <Alert type="info" showIcon message="Booking thủ công trừ chỗ ngay khi tạo. Nếu chuyến hết chỗ, hệ thống sẽ từ chối và không tạo gì." />
      </Form>
    </Drawer>
  )
}
