import { CHANNEL } from '@tours/core'
import { Tag } from 'antd'
import type { Row } from '../../lib/supabase'

type Mix = { channel: string; bookings: number; seats: number }

/** "GetYourGuide 2 · Viator 1": số booking đang giữ chỗ theo từng kênh. */
export function mixText(mix: Mix[] = []) {
  return mix.map((m) => `${CHANNEL[m.channel] ?? m.channel} ${m.bookings}`).join(' · ')
}

/** Tour riêng đã có từ 2 booking: hệ thống chỉ cảnh báo, người điều hành quyết định tách hay giữ. */
export const isPrivateConflict = (isPrivate: boolean, bookings: number) => isPrivate && bookings >= 2

export const MIX_FILTERS: Record<string, { label: string; test: (bookings: number, mix: Mix[], isPrivate: boolean) => boolean }> = {
  merged: { label: 'Có từ 2 booking', test: (n) => n >= 2 },
  multi: { label: 'Ghép nhiều kênh', test: (_, mix) => mix.length >= 2 },
  private: { label: 'Tour riêng bị ghép', test: (n, _, p) => isPrivateConflict(p, n) },
}
export const MIX_OPTIONS = Object.entries(MIX_FILTERS).map(([value, v]) => ({ value, label: v.label }))

export function BookingMix({ bookings, mix = [], isPrivate = false }: { bookings: number; mix?: Row[]; isPrivate?: boolean }) {
  if (!bookings) return isPrivate ? <Tag>Riêng</Tag> : <span className="muted">Chưa có booking</span>
  return (
    <>
      <div>
        {bookings} booking
        {isPrivate && !isPrivateConflict(isPrivate, bookings) && <Tag style={{ marginLeft: 6 }}>Riêng</Tag>}
        {isPrivateConflict(isPrivate, bookings) && <Tag color="red" style={{ marginLeft: 6 }}>Tour riêng bị ghép</Tag>}
        {mix.length >= 2 && <Tag color="geekblue" style={{ marginLeft: 6 }}>Ghép {mix.length} kênh</Tag>}
      </div>
      <div className="muted" style={{ fontSize: 12 }}>{mixText(mix as Mix[])}</div>
    </>
  )
}
