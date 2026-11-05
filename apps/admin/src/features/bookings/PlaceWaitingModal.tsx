import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Checkbox, InputNumber, Modal, Space, Table, Tag } from 'antd'
import dayjs from 'dayjs'
import { useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, NoData } from '../../components/common'
import { rpcOk, type Row } from '../../lib/supabase'

/** Xem trước rồi mới xếp: danh sách luôn lấy từ database nên chạy lại nhiều lần vẫn an toàn. */
export function PlaceWaitingModal({ onClose }: { onClose: () => void }) {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [createMissing, setCreateMissing] = useState(false)
  const [capacity, setCapacity] = useState<number | null>(null)
  const canCreate = can('departure.manage')

  const preview = useQuery({
    queryKey: ['place-waiting', orgId],
    gcTime: 0,
    queryFn: () => rpcOk('place_waiting_bookings', { p_org: orgId, p_dry_run: true, p_create_capacity: null }),
  })
  const rows = (preview.data?.rows ?? []) as Row[]
  const missing = rows.filter((r) => !r.departure_id).length
  const willPlace = rows.reduce((s, r) => s + (r.departure_id || createMissing ? r.bookings : 0), 0)

  const run = useMutation({
    mutationFn: () => rpcOk('place_waiting_bookings', { p_org: orgId, p_dry_run: false, p_create_capacity: createMissing ? capacity : null }),
    onSuccess: (r) => {
      const notes = [
        r.created > 0 && `tạo ${r.created} chuyến`,
        r.no_seats > 0 && `${r.no_seats} booking không đủ chỗ`,
        r.skipped_private > 0 && `${r.skipped_private} booking tour riêng để xếp tay`,
      ].filter(Boolean).join(', ')
      const text = `Đã xếp ${r.placed} booking${notes ? `, ${notes}` : ''}`
      if (r.no_seats > 0 || r.skipped_private > 0) message.warning(text)
      else message.success(text)
      for (const key of ['bookings', 'departures', 'ops-board', 'place-waiting']) qc.invalidateQueries({ queryKey: [key] })
      onClose()
    },
    onError: (e: Error) => message.error(e.message),
  })

  return (
    <Modal title="Xếp booking đang chờ vào chuyến" open width={820} onCancel={onClose} footer={[
      <Button key="c" onClick={onClose}>Đóng</Button>,
      <Button key="s" type="primary" disabled={willPlace === 0 || (createMissing && !capacity)} loading={run.isPending} onClick={() => run.mutate()}>
        Xếp {willPlace} booking
      </Button>,
    ]}>
      {preview.isError ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} /> : (
        <>
          <Table rowKey={(r) => `${r.local_date}-${r.local_time}-${r.tour_name}-${r.option_name}`} size="small" loading={preview.isLoading} dataSource={rows}
            pagination={{ pageSize: 8, hideOnSinglePage: true }} scroll={{ x: 'max-content' }}
            locale={{ emptyText: <NoData text="Không có booking nào đang chờ xếp chuyến" /> }} columns={[
              { title: 'Ngày giờ', render: (_, r) => <span className="nowrap">{dayjs(r.local_date).format('DD/MM/YYYY')} {String(r.local_time).slice(0, 5)}</span> },
              { title: 'Tour / gói', render: (_, r) => <>{r.tour_name}<div className="muted" style={{ fontSize: 12 }}>{r.option_name}{r.is_private && <Tag style={{ marginLeft: 6 }}>Riêng</Tag>}</div></> },
              { title: 'Booking', dataIndex: 'bookings', align: 'right' },
              { title: 'Chỗ', dataIndex: 'seats', align: 'right' },
              { title: 'Chuyến', render: (_, r) => r.departure_id
                ? <Tag color={r.available_seats < r.seats ? 'red' : 'green'}>Đã có, còn {r.available_seats} chỗ</Tag>
                : <Tag color="orange">Chưa có chuyến</Tag> },
            ]} />
          {missing > 0 && canCreate && (
            <Space wrap style={{ marginTop: 12 }}>
              <Checkbox checked={createMissing} onChange={(e) => setCreateMissing(e.target.checked)}>Tạo {missing} chuyến còn thiếu, sức chứa mỗi chuyến</Checkbox>
              <InputNumber min={1} value={capacity} disabled={!createMissing} placeholder="Số chỗ" onChange={setCapacity} />
            </Space>
          )}
          {missing > 0 && !canCreate && <Alert type="warning" showIcon style={{ marginTop: 12 }} message="Bạn không có quyền tạo chuyến, nên các dòng chưa có chuyến sẽ được bỏ qua." />}
          {rows.some((r) => r.is_private && r.bookings > 1) && <Alert type="warning" showIcon style={{ marginTop: 12 }} message="Tour riêng không được tự gộp: mỗi chuyến chỉ nhận booking đầu tiên, các booking còn lại cần xếp tay." />}
          {preview.data && (preview.data.unmapped > 0 || preview.data.past > 0) && (
            <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
              Không tính {preview.data.unmapped} booking chưa ghép mã hoặc thiếu ngày giờ, và {preview.data.past} booking có ngày đi đã qua.
            </p>
          )}
        </>
      )}
    </Modal>
  )
}
