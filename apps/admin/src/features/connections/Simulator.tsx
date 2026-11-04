import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Col, List, Row as GridRow, Select, Space, Tag } from 'antd'
import { simulate, type SimulationContext } from '@tours/channels'
import { CHANNEL } from '@tours/core'
import dayjs from 'dayjs'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { CONNECTION_COLUMNS, rpc, supabase, unwrap, type Row } from '../../lib/supabase'

type LogLine = { at: string; scenario: string; expected: string; outcome: string; ok: boolean; bookingId?: string }

const uid = () => crypto.randomUUID().slice(0, 8).toUpperCase()

// Mọi kịch bản gọi đúng các RPC mà cổng kênh thật sẽ gọi; database chỉ nhận chúng từ người dùng khi
// kết nối đang ở chế độ mô phỏng.
export function Simulator() {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [connectionId, setConnectionId] = useState<string>()
  const [departureId, setDepartureId] = useState<string>()
  const [log, setLog] = useState<LogLine[]>([])
  const [lastRef, setLastRef] = useState<{ ref: string; version: number; event: Row } | null>(null)

  const connections = useQuery({
    queryKey: ['sim-connections', orgId],
    queryFn: async () => unwrap(await supabase.from('channel_connections').select(CONNECTION_COLUMNS).eq('organization_id', orgId).eq('mode', 'mock')) as unknown as Row[],
  })
  const connection = connections.data?.find((c) => c.id === connectionId) ?? connections.data?.[0]

  const mappings = useQuery({
    queryKey: ['sim-mappings', connection?.id],
    enabled: Boolean(connection),
    queryFn: async () => unwrap(await supabase.from('channel_product_mappings').select('external_product_code, external_option_code, tour_option_id, default_local_time, tour_options(tour_id, name)')
      .eq('connection_id', connection!.id).eq('is_verified', true)) as unknown as Row[],
  })
  const departures = useQuery({
    queryKey: ['sim-departures', orgId],
    queryFn: async () => unwrap(await supabase.from('v_departure_availability').select('id, tour_id, tour_option_id, tour_name, option_name, local_date, local_time, timezone, available_seats, capacity')
      .eq('organization_id', orgId).eq('status', 'scheduled').eq('sale_open', true).gte('local_date', dayjs().add(1, 'day').format('YYYY-MM-DD')).order('starts_at').limit(100)) as Row[],
  })

  // Chỉ những chuyến có mã đã ghép với tài khoản này mới mô phỏng được đường đầy đủ.
  const usable = (departures.data ?? []).flatMap((d) => {
    const m = (mappings.data ?? []).find((x) => x.tour_options?.tour_id === d.tour_id && (!d.tour_option_id || d.tour_option_id === x.tour_option_id))
    return m ? [{ d, m }] : []
  })
  const target = usable.find((u) => u.d.id === departureId) ?? usable[0]

  const ctx = (): SimulationContext => ({
    channel: connection!.channel,
    productCode: target!.m.external_product_code,
    optionCode: target!.m.external_option_code,
    localDate: target!.d.local_date,
    localTime: target!.d.local_time,
    timezone: target!.d.timezone,
    uid,
  })
  const ingest = (event: unknown) => rpc<Row>('ingest_channel_event', { p_connection: connection!.id, p_event: event })
  const write = (scenario: string, expected: string, outcome: string, ok: boolean, bookingId?: string) =>
    setLog((l) => [{ at: dayjs().format('HH:mm:ss'), scenario, expected, outcome, ok, bookingId }, ...l].slice(0, 30))

  const refresh = () => {
    for (const k of ['sim-departures', 'departures', 'bookings', 'events', 'dashboard']) qc.invalidateQueries({ queryKey: [k] })
  }

  const run = useMutation({
    mutationFn: async (scenario: string) => {
      const c = ctx()
      switch (scenario) {
        case 'new': {
          const ev = simulate.newBooking(c)
          const r = await ingest(ev)
          setLastRef({ ref: ev.external_ref, version: 1, event: ev })
          write(`Booking mới từ ${CHANNEL[connection!.channel]}`, 'Tạo một booking, trừ chỗ', r.ok ? `Booking ${r.code}${r.queued ? ' (vào hàng chờ)' : ''}` : r.code, Boolean(r.ok), r.booking_id)
          break
        }
        case 'cancel': {
          if (!lastRef) throw new Error('Hãy tạo booking mô phỏng trước.')
          const version = lastRef.version + 1
          const r = await ingest(simulate.cancel(c, lastRef.ref, version))
          setLastRef({ ...lastRef, version })
          write('Hủy booking', 'Trả chỗ, đổi trạng thái', r.ok ? `Đã hủy ${lastRef.ref}` : r.code, Boolean(r.ok), r.booking_id)
          break
        }
        case 'amend': {
          if (!lastRef) throw new Error('Hãy tạo booking mô phỏng trước.')
          const version = lastRef.version + 1
          const r = await ingest(simulate.amend(c, lastRef.ref, version, { adult: 3 }))
          setLastRef({ ...lastRef, version })
          write('Thay đổi số khách', 'Cập nhật booking, chỉnh số chỗ', r.ok ? `Đã đổi ${lastRef.ref} thành 3 khách${r.queued ? ' (hết chỗ, vào hàng chờ)' : ''}` : r.code, Boolean(r.ok), r.booking_id)
          break
        }
        case 'replay': {
          if (!lastRef) throw new Error('Hãy tạo booking mô phỏng trước.')
          const r = await ingest(lastRef.event)
          write('Gửi lại cùng sự kiện', 'Không tạo thêm, không trừ thêm chỗ', r.duplicate ? 'Nhận diện trùng, trả kết quả cũ' : 'KHÔNG nhận diện được trùng', Boolean(r.duplicate))
          break
        }
        case 'hold_expire': {
          const ref = `HOLD-SIM-${uid()}`
          const r = await rpc<Row>('channel_reserve', { p_connection: connection!.id, p_departure: target!.d.id, p_quantity: 1, p_reference: ref, p_ttl_seconds: 5 })
          write('Giữ chỗ 5 giây', 'Giữ 1 chỗ, tự hết hạn', r.ok ? `Đang giữ đến ${dayjs(r.expires_at).format('HH:mm:ss')}, còn ${r.available_after} chỗ` : r.code, Boolean(r.ok))
          refresh()
          if (!r.ok) break
          await new Promise((res) => setTimeout(res, 6000))
          const data = simulate.newBooking(c).data
          const late = await rpc<Row>('channel_book', { p_connection: connection!.id, p_reference: ref, p_data: data })
          write('Xác nhận sau khi hết hạn', 'Bị từ chối hold_expired', late.ok ? 'KHÔNG bị từ chối' : late.code, !late.ok)
          break
        }
        case 'timeout_retry': {
          const ref = `HOLD-SIM-${uid()}`
          await rpc('channel_reserve', { p_connection: connection!.id, p_departure: target!.d.id, p_quantity: 1, p_reference: ref })
          const data = { ...simulate.newBooking(c, { adult: 1 }).data }
          const first = await rpc<Row>('channel_book', { p_connection: connection!.id, p_reference: ref, p_data: data })
          // Kênh mất phản hồi nên gửi lại; giao dịch đầu thực ra đã thành công.
          const retry = await rpc<Row>('channel_book', { p_connection: connection!.id, p_reference: ref, p_data: data })
          const same = first.booking_id === retry.booking_id
          write('Timeout rồi gửi lại', 'Trả đúng booking cũ, không tạo thêm', same ? `Cùng booking ${first.code}` : 'TẠO TRÙNG', same && Boolean(first.ok), first.booking_id)
          break
        }
        case 'race': {
          const fresh = unwrap(await supabase.from('v_departure_availability').select('available_seats').eq('id', target!.d.id).single()) as Row
          const left = fresh.available_seats as number
          if (left <= 0) throw new Error('Chuyến đã hết chỗ, hãy chọn chuyến khác.')
          const makeHold = (q: number) => rpc<Row>('channel_reserve', { p_connection: connection!.id, p_departure: target!.d.id, p_quantity: q, p_reference: `RACE-SIM-${uid()}`, p_ttl_seconds: 60 })
          const [a, b] = await Promise.all([makeHold(left), makeHold(left)])
          const winners = [a, b].filter((r) => r.ok).length
          write(`Hai yêu cầu cùng giữ ${left} chỗ cuối`, 'Đúng một yêu cầu thành công', `${winners} thành công, ${2 - winners} bị từ chối (${[a, b].find((r) => !r.ok)?.code ?? 'không có'}). Chỗ giữ tự trả sau 60 giây.`, winners === 1)
          break
        }
      }
      refresh()
    },
    onError: (e: Error) => message.error(e.message),
  })

  const noConnection = connections.data?.length === 0
  return (
    <>
      <div className="mock-banner">Bộ mô phỏng sinh dữ liệu thử nghiệm có tiền tố <b>SIM</b>. Không có gì được gửi tới Viator hay GetYourGuide. Không dùng trên dữ liệu vận hành thật.</div>
      {noConnection && <Alert type="warning" showIcon message="Chưa có kết nối ở chế độ mô phỏng." style={{ marginBottom: 12 }} />}
      <div className="filters">
        <Select placeholder="Kết nối mô phỏng" style={{ minWidth: 240 }} value={connection?.id} onChange={setConnectionId}
          options={(connections.data ?? []).map((c) => ({ value: c.id, label: `${CHANNEL[c.channel]} · ${c.account_name}` }))} />
        <Select placeholder="Chuyến đích" style={{ minWidth: 320 }} value={target?.d.id} onChange={setDepartureId} loading={departures.isLoading}
          options={usable.map(({ d }) => ({ value: d.id, label: `${dayjs(d.local_date).format('DD/MM')} ${String(d.local_time).slice(0, 5)} · ${d.tour_name} · còn ${d.available_seats}` }))} />
      </div>
      {connection && !target && !departures.isLoading && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Không có chuyến sắp tới nào có mã đã ghép với kết nối này. Hãy tạo chuyến và ghép mã trước." />}
      <GridRow gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card size="small" title="Kịch bản">
            <Space direction="vertical" style={{ width: '100%' }}>
              {[
                ['new', `1-2. Booking mới từ ${connection ? CHANNEL[connection.channel] : 'kênh'}`],
                ['cancel', '3. Hủy booking vừa tạo'],
                ['amend', '4. Thay đổi số khách'],
                ['replay', '5. Gửi lại cùng sự kiện'],
                ['hold_expire', '6. Giữ chỗ rồi hết hạn (đợi 6 giây)'],
                ['timeout_retry', '7. Timeout sau khi giao dịch đã thành công'],
                ['race', '8. Hai yêu cầu cạnh tranh chỗ cuối'],
              ].map(([key, label]) => (
                <Button key={key} block style={{ textAlign: 'left' }} disabled={!target || run.isPending} loading={run.isPending && run.variables === key} onClick={() => run.mutate(key!)}>{label}</Button>
              ))}
            </Space>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card size="small" title="Kết quả" className="sim-log">
            <List size="small" dataSource={log} locale={{ emptyText: 'Chưa chạy kịch bản nào' }} renderItem={(l) => (
              <List.Item>
                <div>
                  <Tag color={l.ok ? 'green' : 'red'}>{l.ok ? 'Đúng' : 'Sai'}</Tag><b>{l.scenario}</b> <span className="muted">{l.at}</span>
                  <div className="muted" style={{ fontSize: 12 }}>Mong đợi: {l.expected}</div>
                  <div>{l.outcome}{l.bookingId && <> · <Link to={`/bookings/${l.bookingId}`}>Mở booking</Link></>}</div>
                </div>
              </List.Item>
            )} />
          </Card>
        </Col>
      </GridRow>
    </>
  )
}
