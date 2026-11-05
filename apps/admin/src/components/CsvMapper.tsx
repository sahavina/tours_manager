import { InboxOutlined } from '@ant-design/icons'
import { Alert, App, Select, Table, Upload } from 'antd'
import { isGygExport, MAX_IMPORT_BYTES, MAX_IMPORT_ROWS, parseCsv, readXlsx, sha256Hex, type ColumnMap, type ParsedCsv } from '@tours/core'

/** `preset`: định dạng đã biết sẵn, không cần ánh xạ cột. */
export type LoadedFile = { name: string; size: number; hash: string; csv: ParsedCsv; preset?: 'gyg' }

/** Gộp mọi sheet của báo cáo GetYourGuide thành một bảng. File Excel khác thì chưa nhận. */
function loadGygXlsx(bytes: Uint8Array): ParsedCsv | null {
  const sheets = readXlsx(bytes)
  const headers = sheets[0]?.headers ?? []
  if (sheets.length === 0 || !sheets.every((s) => isGygExport(s.headers))) return null
  return { headers, rows: sheets.flatMap((s) => s.rows), delimiter: '' }
}

/** Đọc file ở trình duyệt, chặn sai loại, quá dung lượng, quá số dòng. */
export function CsvDropzone({ onLoaded, allowGygXlsx = false }: { onLoaded: (f: LoadedFile) => void; allowGygXlsx?: boolean }) {
  const { message } = App.useApp()
  return (
    <Upload.Dragger accept={allowGygXlsx ? '.csv,text/csv,.xlsx' : '.csv,text/csv'} multiple={false} showUploadList={false} beforeUpload={(file) => {
      void (async () => {
        if (file.size > MAX_IMPORT_BYTES) return message.error('File vượt quá 5 MB')
        if (allowGygXlsx && /\.xlsx$/i.test(file.name)) {
          let csv: ParsedCsv | null = null
          try {
            csv = loadGygXlsx(new Uint8Array(await file.arrayBuffer()))
          } catch {
            return message.error('Không đọc được file Excel này.')
          }
          if (!csv) return message.error('File Excel này không phải báo cáo booking của GetYourGuide. Hãy lưu thành CSV rồi nhập lại.')
          if (csv.rows.length > MAX_IMPORT_ROWS) return message.error(`File vượt quá ${MAX_IMPORT_ROWS} dòng`)
          return onLoaded({ name: file.name, size: file.size, hash: await sha256Hex(JSON.stringify(csv.rows)), csv, preset: 'gyg' })
        }
        if (!/\.csv$/i.test(file.name)) return message.error(allowGygXlsx ? 'Chỉ nhận file .csv hoặc báo cáo .xlsx của GetYourGuide' : 'Chỉ nhận file .csv')
        const text = await file.text()
        const csv = parseCsv(text)
        if (csv.headers.length === 0) return message.error('File trống')
        if (csv.rows.length > MAX_IMPORT_ROWS) return message.error(`File vượt quá ${MAX_IMPORT_ROWS} dòng`)
        onLoaded({ name: file.name, size: file.size, hash: await sha256Hex(text), csv })
      })()
      return false
    }}>
      <p className="ant-upload-drag-icon"><InboxOutlined /></p>
      <p>{allowGygXlsx ? 'Bấm hoặc kéo file CSV, hoặc báo cáo booking .xlsx của GetYourGuide, vào đây' : 'Bấm hoặc kéo file CSV vào đây'}</p>
      <p className="muted">Tối đa 5 MB, {MAX_IMPORT_ROWS} dòng. Hỗ trợ dấu phẩy, chấm phẩy, tab.</p>
    </Upload.Dragger>
  )
}

type Field = { key: string; label: string; required: boolean }

export function ColumnMapper({ headers, fields, value, onChange }: { headers: string[]; fields: readonly Field[]; value: ColumnMap; onChange: (m: ColumnMap) => void }) {
  const missing = fields.filter((f) => f.required && !value[f.key])
  return (
    <>
      {missing.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`Chưa ánh xạ cột bắt buộc: ${missing.map((m) => m.label).join(', ')}`} />}
      <Table rowKey="key" size="small" pagination={false} dataSource={[...fields]} columns={[
        { title: 'Trường dữ liệu', render: (_, f) => <>{f.label}{f.required && <span style={{ color: '#dc2626' }}> *</span>}</> },
        { title: 'Cột trong file', render: (_, f) => (
          <Select allowClear showSearch style={{ width: '100%', minWidth: 220 }} placeholder="Không dùng" value={value[f.key]}
            options={headers.map((h) => ({ value: h, label: h }))} onChange={(v) => onChange({ ...value, [f.key]: v })} />
        ) },
      ]} />
    </>
  )
}
