import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Select, Space, Table, Tag, Tooltip } from 'antd'
import { channelTitles, suggestMapping, type MappingCandidate, type MappingSuggestion } from '@tours/core'
import { useMemo, useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

type Code = { key: string; product_code: string; option_code: string; product_title?: string; option_title?: string; bookings: number; suggestion: MappingSuggestion }

const CONFIDENCE = {
  high: { color: 'green', text: 'Tin cậy cao' },
  medium: { color: 'gold', text: 'Cần xem lại' },
  none: { color: 'default', text: 'Chưa có gợi ý' },
} as const

/**
 * Mã trong file chưa được ghép với gói nội bộ. Gợi ý chỉ để điền sẵn: phải bấm xác nhận mới lưu, vì ghép nhầm làm
 * booking vào sai chuyến. Xác nhận trước khi bấm nhập thì booking của mã đó vào thẳng chuyến.
 */
export function UnmappedCodes({ connection, rows, preset }: { connection: string; rows: Row[]; preset?: 'gyg' | 'viator' }) {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [picked, setPicked] = useState<Record<string, string | undefined>>({})

  const mappings = useQuery({
    queryKey: ['mappings', 'import', connection],
    queryFn: async () => unwrap(await supabase.from('channel_product_mappings')
      .select('external_product_code, external_option_code, is_verified, tour_options(tour_id)')
      .eq('organization_id', orgId).eq('connection_id', connection)) as unknown as Row[],
  })
  const options = useQuery({
    queryKey: ['mapping-candidates', orgId],
    queryFn: async () => unwrap(await supabase.from('tour_options')
      .select('id, code, name, duration_minutes, is_private, tour_id, tours(name, duration_minutes)')
      .eq('organization_id', orgId).is('deleted_at', null).eq('is_active', true).order('code')) as unknown as Row[],
  })

  const candidates: MappingCandidate[] = useMemo(() => (options.data ?? []).map((o) => ({
    id: o.id, code: o.code, name: o.name, tour_id: o.tour_id, tour_name: o.tours?.name ?? '',
    duration_minutes: o.duration_minutes ?? o.tours?.duration_minutes, is_private: o.is_private,
  })), [options.data])

  const codes: Code[] = useMemo(() => {
    if (!mappings.data || !options.data) return []
    const verified = new Set(mappings.data.filter((m) => m.is_verified).map((m) => `${m.external_product_code}|${m.external_option_code}`))
    const byKey = new Map<string, Omit<Code, 'suggestion'>>()
    for (const r of rows) {
      for (const item of (r.normalized?.items ?? []) as Row[]) {
        const key = `${item.product_code}|${item.option_code ?? ''}`
        if (!item.product_code || verified.has(key)) continue
        const prev = byKey.get(key)
        if (prev) prev.bookings += 1
        else byKey.set(key, { key, product_code: item.product_code, option_code: item.option_code ?? '', ...channelTitles(preset, r.raw), bookings: 1 })
      }
    }
    return [...byKey.values()].map((c) => {
      const sameProduct = mappings.data!.filter((m) => m.is_verified && m.external_product_code === c.product_code && m.tour_options?.tour_id).map((m) => m.tour_options.tour_id as string)
      return { ...c, suggestion: suggestMapping(c, candidates, sameProduct) }
    })
  }, [rows, mappings.data, options.data, candidates, preset])

  const save = useMutation({
    mutationFn: async (list: { code: Code; option: string }[]) => {
      let placed = 0
      for (const { code, option } of list) {
        const r = await rpcOk('mapping_save', {
          p_mapping: null, p_org: orgId, p_connection: connection, p_product: code.product_code, p_option: code.option_code,
          p_tour_option: option, p_language: null, p_default_time: null, p_traveler_map: {}, p_verified: true,
        })
        placed += r.placed ?? 0
      }
      return { count: list.length, placed }
    },
    onSuccess: (r) => {
      message.success(`Đã ghép ${r.count} mã${r.placed ? `, xếp được ${r.placed} booking đang chờ` : ''}`)
      for (const key of [['mappings'], ['bookings'], ['departures'], ['ops-board']]) qc.invalidateQueries({ queryKey: key })
    },
    onError: (e: Error) => message.error(e.message),
  })

  if (codes.length === 0) return null
  const choice = (c: Code) => (c.key in picked ? picked[c.key] : c.suggestion.option_id ?? undefined)
  const highOnes = codes.filter((c) => c.suggestion.confidence === 'high' && choice(c) === c.suggestion.option_id)
  const manage = can('connection.manage')

  return (
    <Card size="small" title={`Mã chưa ghép với gói nội bộ (${codes.length})`} style={{ marginBottom: 16 }}
      extra={manage && highOnes.length > 0 && (
        <Button type="primary" loading={save.isPending} onClick={() => save.mutate(highOnes.map((c) => ({ code: c, option: choice(c)! })))}>
          Xác nhận {highOnes.length} gợi ý tin cậy cao
        </Button>
      )}>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="Gợi ý dựa vào tên, thời lượng và kiểu riêng hay ghép. Hãy đối chiếu với sản phẩm trên cổng kênh trước khi xác nhận. Mã bỏ qua vẫn được nhập, booking vào hàng chờ cho tới khi ghép ở Kết nối kênh." />
      {!manage && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="Bạn không có quyền ghép mã. Người quản lý kết nối kênh cần xác nhận các mã này." />}
      <Table rowKey="key" size="small" pagination={false} scroll={{ x: 'max-content' }} dataSource={codes} columns={[
        { title: 'Mã kênh', render: (_, c) => <span className="mono">{c.product_code}{c.option_code ? ` / ${c.option_code}` : ''}</span> },
        { title: 'Tên trên kênh', render: (_, c) => <>{c.option_title ?? <span className="muted">Không có tên</span>}<div className="muted" style={{ fontSize: 12 }}>{c.product_title}</div></> },
        { title: 'Booking', dataIndex: 'bookings', align: 'right' },
        { title: 'Gói nội bộ', render: (_, c) => (
          <Select style={{ width: 280 }} allowClear showSearch optionFilterProp="label" placeholder="Chọn gói" disabled={!manage}
            value={choice(c)} onChange={(v) => setPicked((p) => ({ ...p, [c.key]: v }))}
            options={candidates.map((o) => ({ value: o.id, label: `${o.tour_name} · ${o.name} (${o.code})` }))} />
        ) },
        { title: 'Độ tin cậy', render: (_, c) => {
          const changed = c.key in picked && picked[c.key] !== c.suggestion.option_id
          if (changed) return <Tag color="blue">Bạn tự chọn</Tag>
          const info = CONFIDENCE[c.suggestion.confidence]
          const why = c.suggestion.alternatives.length
            ? `Ngang điểm: ${c.suggestion.alternatives.map((id) => candidates.find((o) => o.id === id)?.name).join(', ')}`
            : c.suggestion.reasons.join('; ')
          return why ? <Tooltip title={why}><Tag color={info.color}>{info.text}</Tag></Tooltip> : <Tag color={info.color}>{info.text}</Tag>
        } },
        { title: '', render: (_, c) => manage && (
          <Button size="small" disabled={!choice(c)} loading={save.isPending} onClick={() => save.mutate([{ code: c, option: choice(c)! }])}>Xác nhận</Button>
        ) },
      ]} />
    </Card>
  )
}
