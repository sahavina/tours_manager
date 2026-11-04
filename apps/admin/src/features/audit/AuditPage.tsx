import { useQuery } from '@tanstack/react-query'
import { Card, Input, Modal, Select, Table } from 'antd'
import { useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, fmtDateTime, NoData, PageHead } from '../../components/common'
import { friendlyError, supabase, type Row } from '../../lib/supabase'
import { useUrlTable } from '../../lib/use-url-state'

const ENTITIES = ['bookings', 'booking_items', 'departures', 'inventory_pools', 'tours', 'tour_options', 'customers', 'guides', 'vehicles', 'suppliers', 'expenses', 'channel_connections', 'channel_product_mappings', 'import_jobs', 'settlement_batches', 'settlement_lines', 'memberships']

export function AuditPage() {
  const { orgId } = useAuth()
  const table = useUrlTable(50)
  const f = table.filters
  const [detail, setDetail] = useState<Row | null>(null)

  const q = useQuery({
    queryKey: ['audit', orgId, JSON.stringify(f), table.page, table.pageSize],
    placeholderData: (p) => p,
    queryFn: async () => {
      let query = supabase.from('audit_logs').select('*', { count: 'exact' }).eq('organization_id', orgId)
      if (f.entity) query = query.eq('entity', f.entity)
      if (f.action) query = query.ilike('action', `%${f.action.replace(/[%_]/g, '\\$&')}%`)
      if (f.entity_id) query = query.eq('entity_id', f.entity_id)
      const from = (table.page - 1) * table.pageSize
      const res = await query.order('created_at', { ascending: false }).range(from, from + table.pageSize - 1)
      if (res.error) throw new Error(friendlyError(res.error))
      return { rows: res.data as Row[], total: res.count ?? 0 }
    },
  })
  const actors = useQuery({
    queryKey: ['audit-actors', orgId, q.data?.rows.map((r) => r.actor_id).join()],
    enabled: Boolean(q.data?.rows.length),
    queryFn: async () => {
      const ids = [...new Set((q.data?.rows ?? []).map((r) => r.actor_id).filter(Boolean))]
      const { data } = await supabase.from('profiles').select('id, full_name, email').in('id', ids)
      return new Map((data ?? []).map((p) => [p.id, p.full_name ?? p.email]))
    },
  })

  return (
    <>
      <PageHead title="Nhật ký hoạt động" />
      <Card>
        <div className="filters">
          <Select allowClear placeholder="Đối tượng" style={{ minWidth: 200 }} value={f.entity} options={ENTITIES.map((e) => ({ value: e, label: e }))} onChange={(v) => table.patch({ filters: { entity: v } })} />
          <Input.Search allowClear placeholder="Hành động" style={{ width: 200 }} defaultValue={f.action} onSearch={(v) => table.patch({ filters: { action: v || undefined } })} />
        </div>
        {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
          <Table rowKey="id" size="small" loading={q.isLoading} dataSource={q.data?.rows} scroll={{ x: 'max-content' }} locale={{ emptyText: <NoData text="Chưa có nhật ký" /> }}
            pagination={{ current: table.page, pageSize: table.pageSize, total: q.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [25, 50, 100] }}
            onChange={(p) => table.patch({ page: p.current, pageSize: p.pageSize })}
            columns={[
              { title: 'Thời điểm', render: (_, r) => <span className="nowrap">{fmtDateTime(r.created_at)}</span> },
              { title: 'Người thực hiện', render: (_, r) => r.actor_id ? (actors.data?.get(r.actor_id) ?? '...') : <span className="muted">Hệ thống</span> },
              { title: 'Hành động', dataIndex: 'action' },
              { title: 'Đối tượng', dataIndex: 'entity' },
              { title: 'Mã', dataIndex: 'entity_id', render: (v) => <span className="mono">{v}</span> },
              { title: '', render: (_, r) => (r.before_data || r.after_data) && <a onClick={() => setDetail(r)}>Chi tiết</a> },
            ]} />
        )}
      </Card>
      <Modal title="Chi tiết" open={Boolean(detail)} onCancel={() => setDetail(null)} footer={null} width={720}>
        {detail && <pre className="payload">{JSON.stringify({ before: detail.before_data, after: detail.after_data }, null, 2)}</pre>}
      </Modal>
    </>
  )
}
