import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, DatePicker, Input, Modal, Select, Space, Statistic, Table, Tabs, Tag } from 'antd'
import { CHANNEL, SETTLEMENT_FIELDS, normalizeSettlementRow, suggestColumnMap, type ColumnMap } from '@tours/core'
import dayjs from 'dayjs'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { CrudPage } from '../../components/CrudPage'
import { ColumnMapper, CsvDropzone, type LoadedFile } from '../../components/CsvMapper'
import { ErrorState, fmtDate, fmtDateTime, MatchTag, MoneyText, NoData, PageHead, ReconTag } from '../../components/common'
import { CONNECTION_COLUMNS, rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

function ProfitTab() {
  const { orgId } = useAuth()
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>([dayjs().subtract(30, 'day'), dayjs().add(30, 'day')])
  const q = useQuery({
    queryKey: ['report-profit', orgId, range[0].format('YYYY-MM-DD'), range[1].format('YYYY-MM-DD')],
    queryFn: () => rpc<Row[]>('report_profit', { p_org: orgId, p_from: range[0].format('YYYY-MM-DD'), p_to: range[1].format('YYYY-MM-DD') }),
  })
  return <>
    <div className="filters">
      <span>Ngày đi</span>
      <DatePicker.RangePicker format="DD/MM/YYYY" allowClear={false} value={range} onChange={(v) => v?.[0] && v[1] && setRange([v[0], v[1]])} />
    </div>
    <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Mỗi dòng tính riêng theo một tiền tệ, không quy đổi và không cộng chéo. Lợi nhuận chỉ hiện khi đủ giá trị bán, phí kênh và chi phí." />
    {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
      <Table rowKey={(r) => `${r.tour_id}-${r.currency}`} size="small" loading={q.isLoading} dataSource={q.data} pagination={false} scroll={{ x: 'max-content' }}
        locale={{ emptyText: <NoData text="Không có dữ liệu trong khoảng này" /> }} columns={[
          { title: 'Tour', dataIndex: 'tour_name' },
          { title: 'Tiền tệ', dataIndex: 'currency' },
          { title: 'Booking', dataIndex: 'bookings', align: 'right' },
          { title: 'Giá trị bán', align: 'right', render: (_, r) => <MoneyText amount={r.gross} currency={r.currency} /> },
          { title: 'Phí kênh', align: 'right', render: (_, r) => <MoneyText amount={r.channel_fee} currency={r.currency} /> },
          { title: 'Hoàn tiền', align: 'right', render: (_, r) => <MoneyText amount={r.refund} currency={r.currency} /> },
          { title: 'Dự kiến nhận', align: 'right', render: (_, r) => <MoneyText amount={r.expected_payout} currency={r.currency} /> },
          { title: 'Thực nhận', align: 'right', render: (_, r) => <MoneyText amount={r.actual_payout} currency={r.currency} /> },
          { title: 'Chi phí', align: 'right', render: (_, r) => <MoneyText amount={r.costs} currency={r.currency} /> },
          { title: 'Lợi nhuận', align: 'right', render: (_, r) => r.profit == null ? <Tag color="orange">Chưa đủ dữ liệu</Tag> : <b><MoneyText amount={r.profit} currency={r.currency} /></b> },
          { title: 'Mức hoàn thiện dữ liệu', render: (_, r) => {
            const gaps = [
              r.missing_gross > 0 && `${r.missing_gross} booking thiếu giá`,
              r.missing_fee > 0 && `${r.missing_fee} booking thiếu phí`,
              r.departures_without_cost > 0 && `${r.departures_without_cost}/${r.departures_run} chuyến chưa nhập chi phí`,
              r.estimated_cost_lines > 0 && `${r.estimated_cost_lines} khoản chi tạm tính`,
              r.missing_actual > 0 && `${r.missing_actual} booking chưa đối soát`,
            ].filter(Boolean)
            return gaps.length ? <span className="muted" style={{ fontSize: 12 }}>{gaps.join('; ')}</span> : <Tag color="green">Đủ</Tag>
          } },
        ]} />
    )}
  </>
}

function SettlementImport({ onClose }: { onClose: () => void }) {
  const { orgId } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [connection, setConnection] = useState<string>()
  const [file, setFile] = useState<LoadedFile | null>(null)
  const [map, setMap] = useState<ColumnMap>({})
  const connections = useQuery({
    queryKey: ['connections-lite', orgId],
    queryFn: async () => unwrap(await supabase.from('channel_connections').select(CONNECTION_COLUMNS).eq('organization_id', orgId)) as unknown as Row[],
  })
  const send = useMutation({
    mutationFn: () => rpcOk('settlement_preview', {
      p_org: orgId, p_connection: connection, p_filename: file!.name, p_file_hash: file!.hash, p_column_map: map,
      p_rows: file!.csv.rows.map((r, i) => normalizeSettlementRow(r, map, i + 2)),
    }),
    onSuccess: (r) => {
      if (r.code === 'already_imported') message.warning('File này đã được nhập vào tài khoản này trước đó.')
      qc.invalidateQueries({ queryKey: ['settlements'] })
      onClose()
    },
    onError: (e: Error) => message.error(e.message),
  })
  const ready = connection && file && SETTLEMENT_FIELDS.filter((f) => f.required).every((f) => map[f.key])
  return (
    <Modal title="Nhập bảng thanh toán" open onCancel={onClose} width={640} okText="Xem trước kết quả ghép" cancelText="Đóng" okButtonProps={{ disabled: !ready }} confirmLoading={send.isPending} onOk={() => send.mutate()}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select style={{ width: '100%' }} placeholder="Tài khoản kênh" value={connection} onChange={setConnection}
          options={(connections.data ?? []).map((c) => ({ value: c.id, label: `${CHANNEL[c.channel] ?? c.channel} · ${c.account_name}` }))} />
        {!file ? <CsvDropzone onLoaded={(f) => { setFile(f); setMap(suggestColumnMap(f.csv.headers, SETTLEMENT_FIELDS)) }} /> : (
          <>
            <div>{file.name}: {file.csv.rows.length} dòng</div>
            <ColumnMapper headers={file.csv.headers} fields={SETTLEMENT_FIELDS} value={map} onChange={setMap} />
          </>
        )}
      </Space>
    </Modal>
  )
}

function BatchDetail({ batch, onClose }: { batch: Row; onClose: () => void }) {
  const { can, orgId } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [matching, setMatching] = useState<Row | null>(null)
  const [matchRef, setMatchRef] = useState('')
  const [matchNote, setMatchNote] = useState('')
  const q = useQuery({
    queryKey: ['settlement-lines', batch.id],
    queryFn: async () => unwrap(await supabase.from('settlement_lines').select('id, row_no, external_ref, currency, gross_amount, fee_amount, net_amount, match_status, difference, note, booking_id, bookings(code)')
      .eq('batch_id', batch.id).order('row_no')) as unknown as Row[],
  })
  const confirm = useMutation({
    mutationFn: () => rpcOk('settlement_confirm', { p_batch: batch.id }),
    onSuccess: (r) => { message.success(`Đã xác nhận, ghi nhận ${r.applied ?? 0} dòng`); qc.invalidateQueries({ queryKey: ['settlements'] }); qc.invalidateQueries({ queryKey: ['settlement-lines'] }); onClose() },
    onError: (e: Error) => message.error(e.message),
  })
  const match = useMutation({
    mutationFn: async () => {
      const b = unwrap(await supabase.from('bookings').select('id').eq('organization_id', orgId).or(`code.eq.${matchRef.trim()},external_ref.eq.${matchRef.trim()}`).limit(1).maybeSingle()) as Row | null
      if (!b) throw new Error('Không tìm thấy booking với mã này.')
      return rpcOk('settlement_match_line', { p_line: matching!.id, p_booking: b.id, p_note: matchNote })
    },
    onSuccess: () => { setMatching(null); setMatchRef(''); setMatchNote(''); message.success('Đã gán'); qc.invalidateQueries({ queryKey: ['settlement-lines'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  const count = (s: string) => (q.data ?? []).filter((l) => l.match_status === s).length
  const manage = can('finance.manage')
  return (
    <Modal title={`Bảng thanh toán: ${batch.filename}`} open onCancel={onClose} width={1000} footer={[
      <Button key="c" onClick={onClose}>Đóng</Button>,
      batch.status !== 'confirmed' && manage && <Button key="o" type="primary" loading={confirm.isPending} onClick={() => confirm.mutate()}>Xác nhận đối soát</Button>,
    ]}>
      <Space size="large" wrap style={{ marginBottom: 12 }}>
        <Statistic title="Khớp" value={count('matched')} />
        <Statistic title="Lệch" value={count('mismatch')} valueStyle={count('mismatch') ? { color: '#dc2626' } : undefined} />
        <Statistic title="Chưa tìm thấy" value={count('unmatched')} />
        <Statistic title="Trùng" value={count('duplicate')} />
        <Statistic title="Không hợp lệ" value={count('invalid')} />
      </Space>
      {batch.status !== 'confirmed' && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Chưa xác nhận: số thực nhận của booking chưa thay đổi." />}
      <Table rowKey="id" size="small" loading={q.isLoading} dataSource={q.data} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 'max-content' }} columns={[
        { title: 'Dòng', dataIndex: 'row_no' },
        { title: 'Mã booking', dataIndex: 'external_ref' },
        { title: 'Booking', render: (_, l) => l.booking_id ? <Link to={`/bookings/${l.booking_id}`}>{l.bookings?.code}</Link> : '' },
        { title: 'Thực nhận', align: 'right', render: (_, l) => <MoneyText amount={l.net_amount} currency={l.currency} /> },
        { title: 'Phí', align: 'right', render: (_, l) => <MoneyText amount={l.fee_amount} currency={l.currency} /> },
        { title: 'Kết quả', render: (_, l) => <MatchTag value={l.match_status} /> },
        { title: 'Chênh lệch', align: 'right', render: (_, l) => l.difference != null && Number(l.difference) !== 0 ? <span style={{ color: '#dc2626' }}><MoneyText amount={l.difference} currency={l.currency} /></span> : '' },
        { title: 'Ghi chú', dataIndex: 'note' },
        { title: '', render: (_, l) => manage && l.match_status === 'unmatched' && <Button size="small" onClick={() => setMatching(l)}>Gán tay</Button> },
      ]} />
      <Modal title="Gán dòng vào booking" open={Boolean(matching)} onCancel={() => setMatching(null)} okText="Gán" cancelText="Hủy" confirmLoading={match.isPending} okButtonProps={{ disabled: !matchRef.trim() || !matchNote.trim() }} onOk={() => match.mutate()}>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input placeholder="Mã nội bộ hoặc mã bên ngoài của booking" value={matchRef} onChange={(e) => setMatchRef(e.target.value)} />
          <Input.TextArea placeholder="Lý do gán tay" value={matchNote} onChange={(e) => setMatchNote(e.target.value)} />
        </Space>
      </Modal>
    </Modal>
  )
}

function SettlementsTab() {
  const { orgId, can } = useAuth()
  const [importing, setImporting] = useState(false)
  const [open, setOpen] = useState<Row | null>(null)
  const q = useQuery({
    queryKey: ['settlements', orgId],
    queryFn: async () => unwrap(await supabase.from('settlement_batches').select('id, filename, status, created_at, confirmed_at, channel_connections(account_name, channel, mode)')
      .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(100)) as unknown as Row[],
  })
  return <>
    <div className="filters"><div style={{ flex: 1 }} />{can('finance.manage') && <Button type="primary" onClick={() => setImporting(true)}>Nhập bảng thanh toán</Button>}</div>
    {q.isError ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
      <Table rowKey="id" size="small" loading={q.isLoading} dataSource={q.data} pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: <NoData text="Chưa có bảng thanh toán" /> }} columns={[
        { title: 'File', render: (_, b) => <a onClick={() => setOpen(b)}>{b.filename}</a> },
        { title: 'Tài khoản', render: (_, b) => `${CHANNEL[b.channel_connections?.channel] ?? ''} · ${b.channel_connections?.account_name}` },
        { title: 'Nhập lúc', render: (_, b) => fmtDateTime(b.created_at) },
        { title: 'Trạng thái', render: (_, b) => (b.status === 'confirmed' ? <Tag color="green">Đã xác nhận</Tag> : <Tag color="gold">Chờ xác nhận</Tag>) },
      ]} />
    )}
    {importing && <SettlementImport onClose={() => setImporting(false)} />}
    {open && <BatchDetail batch={open} onClose={() => setOpen(null)} />}
  </>
}

function MismatchTab() {
  const { orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['mismatch-bookings', orgId],
    queryFn: async () => unwrap(await supabase.from('bookings').select('id, code, external_ref, lead_name, reconciliation_status, gross_amount, currency, booking_financials(expected_payout, actual_payout)')
      .eq('organization_id', orgId).in('reconciliation_status', ['mismatch', 'adjusted']).order('updated_at', { ascending: false }).limit(200)) as unknown as Row[],
  })
  const adjust = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) => rpcOk('settlement_adjust', { p_booking: id, p_note: note }),
    onSuccess: () => { message.success('Đã ghi nhận'); qc.invalidateQueries({ queryKey: ['mismatch-bookings'] }) },
    onError: (e: Error) => message.error(e.message),
  })
  const ask = (id: string) => {
    let note = ''
    Modal.confirm({
      title: 'Ghi nhận đã xử lý khoản lệch', content: <Input.TextArea placeholder="Lý do (bắt buộc)" onChange={(e) => (note = e.target.value)} />,
      okText: 'Ghi nhận', cancelText: 'Hủy', onOk: () => adjust.mutateAsync({ id, note }),
    })
  }
  return (
    <Table rowKey="id" size="small" loading={q.isLoading} dataSource={q.data} pagination={false} scroll={{ x: 'max-content' }} locale={{ emptyText: <NoData text="Không có khoản lệch" /> }} columns={[
      { title: 'Booking', render: (_, b) => <Link to={`/bookings/${b.id}?tab=finance`}>{b.code}</Link> },
      { title: 'Mã ngoài', dataIndex: 'external_ref' },
      { title: 'Khách', dataIndex: 'lead_name' },
      { title: 'Dự kiến', align: 'right', render: (_, b) => <MoneyText amount={b.booking_financials?.expected_payout} currency={b.currency} /> },
      { title: 'Thực nhận', align: 'right', render: (_, b) => <MoneyText amount={b.booking_financials?.actual_payout} currency={b.currency} /> },
      { title: 'Đối soát', render: (_, b) => <ReconTag value={b.reconciliation_status} /> },
      { title: '', render: (_, b) => can('finance.manage') && b.reconciliation_status === 'mismatch' && <Button size="small" onClick={() => ask(b.id)}>Đã xử lý</Button> },
    ]} />
  )
}

function ExpensesTab() {
  const { org } = useAuth()
  return (
    <CrudPage bare title="Chi phí" table="expenses" queryKey="expenses" managePerm="finance.manage" softDelete
      select="id, category, description, amount, currency, incurred_on, is_final, departure_id, departures(local_date, tours(name))"
      mapBeforeSave={({ departures: _d, ...v }) => v}
      columns={[
        { title: 'Ngày', render: (_, e) => fmtDate(e.incurred_on) },
        { title: 'Loại', dataIndex: 'category' },
        { title: 'Mô tả', dataIndex: 'description' },
        { title: 'Chuyến', render: (_, e) => e.departure_id ? <Link to={`/operations/${e.departure_id}?tab=costs`}>{e.departures?.tours?.name} {fmtDate(e.departures?.local_date)}</Link> : '' },
        { title: 'Số tiền', align: 'right', render: (_, e) => <MoneyText amount={e.amount} currency={e.currency} /> },
        { title: 'Tình trạng', render: (_, e) => (e.is_final ? <Tag color="green">Đã chốt</Tag> : <Tag>Tạm tính</Tag>) },
      ]}
      fields={[
        { name: 'category', label: 'Loại', type: 'select', required: true, defaultValue: 'other', options: [{ value: 'transport', label: 'Xe' }, { value: 'guide', label: 'Hướng dẫn viên' }, { value: 'ticket', label: 'Vé' }, { value: 'meal', label: 'Ăn uống' }, { value: 'other', label: 'Khác' }] },
        { name: 'description', label: 'Mô tả' },
        { name: 'amount', label: 'Số tiền', type: 'money', required: true },
        { name: 'currency', label: 'Tiền tệ', required: true, defaultValue: org?.default_currency },
        { name: 'is_final', label: 'Đã chốt', type: 'switch', defaultValue: false },
      ]}
      emptyText="Chưa có chi phí. Chi phí theo chuyến nhập ở màn hình chuyến." />
  )
}

export function FinancePage() {
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'profit'
  return (
    <>
      <PageHead title="Tài chính và đối soát" />
      <Card>
        <Tabs activeKey={tab} onChange={(k) => setParams(k === 'profit' ? {} : { tab: k }, { replace: true })} items={[
          { key: 'profit', label: 'Lợi nhuận', children: <ProfitTab /> },
          { key: 'settlements', label: 'Đối soát', children: <SettlementsTab /> },
          { key: 'mismatch', label: 'Khoản lệch', children: <MismatchTab /> },
          { key: 'expenses', label: 'Chi phí', children: <ExpensesTab /> },
        ]} />
      </Card>
    </>
  )
}
