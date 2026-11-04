import { DownloadOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Button, Card, Result, Select, Space, Statistic, Steps, Table, Tag } from 'antd'
import { BOOKING_IMPORT_FIELDS, CHANNEL, normalizeBookingRow, suggestColumnMap, toCsv, type ColumnMap } from '@tours/core'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthProvider'
import { ColumnMapper, CsvDropzone, type LoadedFile } from '../../components/CsvMapper'
import { fmtDateTime, NoData, PageHead } from '../../components/common'
import { CONNECTION_COLUMNS, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'
import { downloadText } from '../../lib/use-url-state'

const CLASS_LABEL: Record<string, { text: string; color: string }> = {
  create: { text: 'Tạo mới', color: 'green' },
  update: { text: 'Cập nhật', color: 'blue' },
  duplicate: { text: 'Trùng, bỏ qua', color: 'default' },
  error: { text: 'Lỗi', color: 'red' },
}

export function ImportPage() {
  const { orgId, org } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const [step, setStep] = useState(0)
  const [connection, setConnection] = useState<string>()
  const [file, setFile] = useState<LoadedFile | null>(null)
  const [map, setMap] = useState<ColumnMap>({})
  const [job, setJob] = useState<string | null>(null)
  const [result, setResult] = useState<Row | null>(null)

  const connections = useQuery({
    queryKey: ['connections-lite', orgId],
    queryFn: async () => unwrap(await supabase.from('channel_connections').select(CONNECTION_COLUMNS).eq('organization_id', orgId)) as unknown as Row[],
  })
  const history = useQuery({
    queryKey: ['import-jobs', orgId],
    queryFn: async () => unwrap(await supabase.from('import_jobs').select('id, filename, status, counts, created_at, committed_at, profiles(full_name, email), channel_connections(account_name)')
      .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(20)) as unknown as Row[],
  })
  const rows = useQuery({
    queryKey: ['import-rows', job],
    enabled: Boolean(job),
    queryFn: async () => unwrap(await supabase.from('import_rows').select('id, row_no, classification, errors, raw, normalized').eq('job_id', job!).order('row_no').limit(5000)) as Row[],
  })

  const requiredOk = BOOKING_IMPORT_FIELDS.filter((f) => f.required).every((f) => map[f.key])
  const counts = useMemo(() => {
    const c = { create: 0, update: 0, duplicate: 0, error: 0 }
    for (const r of rows.data ?? []) c[r.classification as keyof typeof c] += 1
    return c
  }, [rows.data])

  const preview = useMutation({
    mutationFn: async () => {
      const payload = file!.csv.rows.map((row, i) => {
        const n = normalizeBookingRow(row, map, org?.default_timezone)
        return { row_no: i + 2, raw: row, normalized: n.normalized, errors: n.errors }
      })
      return rpcOk('import_preview', {
        p_org: orgId, p_connection: connection, p_filename: file!.name, p_file_hash: file!.hash,
        p_file_size: file!.size, p_column_map: map, p_rows: payload,
      })
    },
    onSuccess: (r) => { setJob(r.job_id); setStep(3) },
    onError: (e: Error) => message.error(e.message),
  })
  const commit = useMutation({
    mutationFn: () => rpcOk('import_commit', { p_job: job }),
    onSuccess: (r) => {
      setResult(r)
      setStep(4)
      qc.invalidateQueries({ queryKey: ['import-jobs'] })
      qc.invalidateQueries({ queryKey: ['bookings'] })
    },
    onError: (e: Error) => message.error(e.message),
  })

  const reset = () => { setStep(0); setFile(null); setMap({}); setJob(null); setResult(null) }
  const errorRows = (rows.data ?? []).filter((r) => (r.errors as string[]).length > 0)
  const downloadErrors = () => downloadText(`loi-nhap-${file?.name ?? 'file'}`, toCsv(errorRows.map((r) => ({ Dòng: r.row_no, Lỗi: (r.errors as string[]).join('; '), ...r.raw }))))

  return (
    <>
      <PageHead title="Nhập dữ liệu" />
      <Card style={{ marginBottom: 16 }}>
        <Steps current={step} size="small" responsive style={{ marginBottom: 24 }} items={[
          { title: 'Tải file' }, { title: 'Chọn kênh' }, { title: 'Ánh xạ cột' }, { title: 'Xem trước' }, { title: 'Kết quả' },
        ]} />

        {step === 0 && <CsvDropzone onLoaded={(f) => { setFile(f); setMap(suggestColumnMap(f.csv.headers)); setStep(1) }} />}

        {step === 1 && (
          <Space direction="vertical" style={{ width: '100%', maxWidth: 480 }}>
            <Alert type="info" showIcon message={`${file?.name}: ${file?.csv.rows.length} dòng, ${file?.csv.headers.length} cột. Loại dữ liệu: booking.`} />
            <div>Tài khoản kênh của file này</div>
            <Select style={{ width: '100%' }} placeholder="Chọn tài khoản kênh" value={connection} onChange={setConnection}
              options={(connections.data ?? []).map((c) => ({ value: c.id, label: `${CHANNEL[c.channel] ?? c.channel} · ${c.account_name}` }))} />
            <p className="muted">Mã booking chỉ duy nhất trong một tài khoản, nên nhập lại cùng file vào đúng tài khoản không tạo trùng.</p>
            <Space><Button onClick={reset}>Quay lại</Button><Button type="primary" disabled={!connection} onClick={() => setStep(2)}>Tiếp tục</Button></Space>
          </Space>
        )}

        {step === 2 && file && (
          <>
            <ColumnMapper headers={file.csv.headers} fields={BOOKING_IMPORT_FIELDS} value={map} onChange={setMap} />
            <Space style={{ marginTop: 16 }}>
              <Button onClick={() => setStep(1)}>Quay lại</Button>
              <Button type="primary" disabled={!requiredOk} loading={preview.isPending} onClick={() => preview.mutate()}>Kiểm tra và xem trước</Button>
            </Space>
          </>
        )}

        {step === 3 && (
          <>
            <Space size="large" wrap style={{ marginBottom: 16 }}>
              <Statistic title="Tạo mới" value={counts.create} />
              <Statistic title="Cập nhật" value={counts.update} />
              <Statistic title="Trùng, bỏ qua" value={counts.duplicate} />
              <Statistic title="Lỗi" value={counts.error} valueStyle={counts.error ? { color: '#dc2626' } : undefined} />
            </Space>
            <Table rowKey="id" size="small" loading={rows.isLoading} dataSource={rows.data} pagination={{ pageSize: 20 }} scroll={{ x: 'max-content' }} columns={[
              { title: 'Dòng', dataIndex: 'row_no', width: 70 },
              { title: 'Phân loại', render: (_, r) => <Tag color={CLASS_LABEL[r.classification]?.color}>{CLASS_LABEL[r.classification]?.text}</Tag> },
              { title: 'Mã booking', render: (_, r) => r.normalized?.external_ref ?? r.raw?.[map.external_ref ?? ''] },
              { title: 'Sản phẩm', render: (_, r) => r.normalized?.items?.[0]?.product_code },
              { title: 'Ngày đi', render: (_, r) => r.normalized?.items?.[0]?.local_date },
              { title: 'Ghi chú', render: (_, r) => (r.errors as string[]).join('; ') },
            ]} />
            <Space style={{ marginTop: 16 }} wrap>
              <Button onClick={reset}>Hủy</Button>
              {errorRows.length > 0 && <Button icon={<DownloadOutlined />} onClick={downloadErrors}>Tải danh sách lỗi</Button>}
              <Button type="primary" disabled={counts.create + counts.update === 0} loading={commit.isPending} onClick={() => commit.mutate()}>
                Xác nhận nhập {counts.create + counts.update} dòng
              </Button>
            </Space>
          </>
        )}

        {step === 4 && result && (
          <Result status="success" title="Đã nhập xong" subTitle={`Tạo ${result.created}, cập nhật ${result.updated}. ${result.queued ? `${result.queued} booking vào hàng chờ do chưa ghép mã hoặc chưa có chuyến.` : ''}`}
            extra={[
              <Link key="b" to="/bookings"><Button type="primary">Xem booking</Button></Link>,
              errorRows.length > 0 && <Button key="e" icon={<DownloadOutlined />} onClick={downloadErrors}>Tải danh sách lỗi</Button>,
              <Button key="n" onClick={reset}>Nhập file khác</Button>,
            ]} />
        )}
      </Card>

      <Card title="Lịch sử nhập" size="small">
        <Table rowKey="id" size="small" loading={history.isLoading} dataSource={history.data} pagination={false} scroll={{ x: 'max-content' }}
          locale={{ emptyText: <NoData text="Chưa có lượt nhập" /> }} columns={[
            { title: 'File', dataIndex: 'filename' },
            { title: 'Tài khoản', render: (_, j) => j.channel_connections?.account_name },
            { title: 'Người nhập', render: (_, j) => j.profiles?.full_name ?? j.profiles?.email },
            { title: 'Thời điểm', render: (_, j) => <span className="nowrap">{fmtDateTime(j.created_at)}</span> },
            { title: 'Trạng thái', render: (_, j) => (j.status === 'committed' ? <Tag color="green">Đã nhập</Tag> : <Tag>Chỉ xem trước</Tag>) },
            { title: 'Kết quả', render: (_, j) => {
              const c = j.counts ?? {}
              return j.status === 'committed'
                ? `Tạo ${c.created ?? 0}, cập nhật ${c.updated ?? 0}, vào hàng chờ ${c.queued ?? 0}, lỗi ${c.error ?? 0}`
                : `Tạo mới ${c.create ?? 0}, cập nhật ${c.update ?? 0}, trùng ${c.duplicate ?? 0}, lỗi ${c.error ?? 0}`
            } },
          ]} />
      </Card>
    </>
  )
}
