import { Alert, Button, Empty, Result, Skeleton, Tag, Tooltip } from 'antd'
import {
  BOOKING_STATUS, CHANNEL, CONNECTION_MODE, CONNECTION_STATUS, EVENT_STATUS, MATCH_STATUS, OPS_STATUS,
  RECONCILIATION_STATUS, SYNC_STATUS, formatMoney,
} from '@tours/core'
import dayjs from 'dayjs'
import type { ReactNode } from 'react'
import { useAuth } from '../auth/AuthProvider'

export function Forbidden() {
  return <Result status="403" title="Không có quyền" subTitle="Tài khoản của bạn chưa được cấp quyền xem mục này." />
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <Alert
      type="error"
      showIcon
      message="Không tải được dữ liệu"
      description={error instanceof Error ? error.message : undefined}
      action={onRetry ? <Button size="small" onClick={onRetry}>Thử lại</Button> : undefined}
    />
  )
}

export function Loading() {
  return <Skeleton active paragraph={{ rows: 6 }} />
}

export function NoData({ text = 'Chưa có dữ liệu', action }: { text?: string; action?: ReactNode }) {
  return <Empty description={text}>{action}</Empty>
}

/** Kiểm tra quyền phía giao diện chỉ để trải nghiệm; database vẫn kiểm tra lại mọi thao tác. */
export function Need({ perm, children }: { perm: string | string[]; children: ReactNode }) {
  const { can } = useAuth()
  const perms = Array.isArray(perm) ? perm : [perm]
  return perms.some(can) ? <>{children}</> : <Forbidden />
}

export function Can({ perm, children }: { perm: string; children: ReactNode }) {
  const { can } = useAuth()
  return can(perm) ? <>{children}</> : null
}

const COLOR: Record<string, string> = {
  confirmed: 'green', pending: 'gold', cancelled: 'red', completed: 'blue', no_show: 'volcano',
  new: 'default', needs_mapping: 'red', needs_departure: 'orange', needs_info: 'gold', ready: 'cyan', assigned: 'green', done: 'blue',
  manual: 'default', simulated: 'purple', synced: 'green', stale: 'orange', error: 'red',
  unreconciled: 'default', matched: 'green', mismatch: 'red', adjusted: 'blue',
  processed: 'green', ignored_stale: 'default', failed: 'orange', dead: 'red', received: 'blue',
  unmatched: 'orange', duplicate: 'default', invalid: 'red',
}

const mapTag = (labels: Record<string, string>) =>
  function StatusTag({ value }: { value?: string | null }) {
    if (!value) return <span className="muted">Không có</span>
    return <Tag color={COLOR[value] ?? 'default'}>{labels[value] ?? value}</Tag>
  }

export const BookingStatusTag = mapTag(BOOKING_STATUS)
export const OpsStatusTag = mapTag(OPS_STATUS)
export const SyncStatusTag = mapTag(SYNC_STATUS)
export const ReconTag = mapTag(RECONCILIATION_STATUS)
export const EventStatusTag = mapTag(EVENT_STATUS)
export const MatchTag = mapTag(MATCH_STATUS)

export function ChannelLabel({ channel, account, mode }: { channel?: string | null; account?: string | null; mode?: string | null }) {
  if (!channel) return <span className="muted">Nội bộ</span>
  return (
    <span>
      {CHANNEL[channel] ?? channel}
      {mode === 'mock' && <Tag color="purple" style={{ marginLeft: 6 }}>Mô phỏng</Tag>}
      {account && <div className="muted" style={{ fontSize: 12 }}>{account}</div>}
    </span>
  )
}

/** Trạng thái kết nối luôn đi kèm chế độ, để "đang mô phỏng" không bao giờ đọc thành "đã kết nối". */
export function ConnectionBadge({ mode, status }: { mode: string; status: string }) {
  return (
    <span>
      <Tag color={mode === 'mock' ? 'purple' : mode === 'sandbox' ? 'blue' : 'green'}>{CONNECTION_MODE[mode] ?? mode}</Tag>
      <Tag color={status === 'connected' ? 'green' : status === 'error' ? 'red' : 'default'}>{CONNECTION_STATUS[status] ?? status}</Tag>
    </span>
  )
}

export function MoneyText({ amount, currency }: { amount: unknown; currency?: string | null }) {
  const text = formatMoney(amount === null || amount === undefined ? null : String(amount), currency)
  if (text === 'Chưa có dữ liệu') return <span className="muted nowrap">Chưa có dữ liệu</span>
  return <span className="nowrap" style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</span>
}

export const fmtDateTime = (v?: string | null) => (v ? dayjs(v).format('DD/MM/YYYY HH:mm') : '')
export const fmtDate = (v?: string | null) => (v ? dayjs(v).format('DD/MM/YYYY') : '')

/** Giờ địa phương của chuyến, ghi rõ múi giờ nếu khác múi giờ doanh nghiệp. */
export function LocalTime({ date, time, tz }: { date?: string | null; time?: string | null; tz?: string | null }) {
  const { org } = useAuth()
  if (!date) return <span className="muted">Chưa có</span>
  return (
    <span className="nowrap">
      {fmtDate(date)} {time ? String(time).slice(0, 5) : ''}
      {tz && tz !== org?.default_timezone && (
        <Tooltip title={`Giờ địa phương theo múi giờ ${tz}`}><Tag style={{ marginLeft: 4 }}>{tz.split('/').pop()}</Tag></Tooltip>
      )}
    </span>
  )
}

export function PageHead({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  return (
    <div className="page-head">
      <h1 className="page-title">{title}</h1>
      {extra && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{extra}</div>}
    </div>
  )
}
