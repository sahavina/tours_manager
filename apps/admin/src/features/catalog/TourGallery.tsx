// Quản lý bộ ảnh của tour: tải nhiều ảnh lên kho "tour-images", kéo thả để sắp xếp, ảnh đầu tiên là ảnh bìa.
// Ảnh được thu nhỏ còn rộng tối đa 1600px và chuyển sang WebP ngay trên trình duyệt trước khi tải lên.
import { ArrowLeftOutlined, ArrowRightOutlined, DeleteOutlined, LinkOutlined, StarOutlined, UploadOutlined } from '@ant-design/icons'
import { App, Button, Empty, Input, Popconfirm, Space, Tag, Tooltip, Typography } from 'antd'
import { useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'

export const MAX_IMAGES = 20
const BUCKET = 'tour-images'

async function toWebp(file: File): Promise<Blob> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / bmp.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bmp.width * scale)
  canvas.height = Math.round(bmp.height * scale)
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height)
  bmp.close()
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/webp', 0.82))
  if (blob && blob.type === 'image/webp') return blob
  // Trình duyệt không xuất được WebP thì dùng JPEG.
  return await new Promise<Blob>((r, j) => canvas.toBlob((b) => (b ? r(b) : j(new Error('Không đọc được ảnh'))), 'image/jpeg', 0.85))
}

export function TourGallery({ value, onChange, orgId, folder }: { value: string[]; onChange: (v: string[]) => void; orgId: string; folder: string }) {
  const { message } = App.useApp()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null)
  const [url, setUrl] = useState('')
  const [drag, setDrag] = useState<number | null>(null)
  const room = MAX_IMAGES - value.length

  const upload = async (files: FileList | null) => {
    if (!files?.length) return
    const list = [...files].filter((f) => f.type.startsWith('image/')).slice(0, room)
    if (files.length > room) message.warning(`Mỗi tour tối đa ${MAX_IMAGES} ảnh; chỉ tải ${room} ảnh đầu.`)
    if (!list.length) return
    setBusy({ done: 0, total: list.length })
    const added: string[] = []
    for (const file of list) {
      try {
        const blob = await toWebp(file)
        const ext = blob.type === 'image/webp' ? 'webp' : 'jpg'
        const path = `${orgId}/${folder}/${crypto.randomUUID()}.${ext}`
        const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false })
        if (error) throw error
        added.push(supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl)
      } catch (e) {
        message.error(`${file.name}: ${(e as Error).message || 'không tải lên được'}`)
      }
      setBusy((b) => b && { ...b, done: b.done + 1 })
    }
    setBusy(null)
    if (added.length) {
      onChange([...value, ...added])
      message.success(`Đã tải ${added.length} ảnh. Bấm Lưu để giữ thay đổi.`)
    }
    if (input.current) input.current.value = ''
  }

  const addUrl = () => {
    const u = url.trim()
    if (!/^https:\/\/\S+$/.test(u) || u.length > 500) {
      message.error('Link ảnh phải bắt đầu bằng https:// và không có khoảng trắng')
      return
    }
    if (value.includes(u)) return message.info('Ảnh này đã có')
    if (!room) return message.warning(`Mỗi tour tối đa ${MAX_IMAGES} ảnh`)
    onChange([...value, u])
    setUrl('')
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= value.length || from === to) return
    const next = [...value]
    const [x] = next.splice(from, 1)
    next.splice(to, 0, x!)
    onChange(next)
  }

  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => upload(e.target.files)} />
        <Button type="primary" icon={<UploadOutlined />} disabled={!room || Boolean(busy)} loading={Boolean(busy)} onClick={() => input.current?.click()}>
          {busy ? `Đang tải ${busy.done}/${busy.total}` : 'Tải ảnh lên'}
        </Button>
        <Input style={{ width: 320 }} placeholder="Hoặc dán link ảnh https://..." prefix={<LinkOutlined />} value={url}
          onChange={(e) => setUrl(e.target.value)} onPressEnter={addUrl} />
        <Button onClick={addUrl} disabled={!url.trim()}>Thêm link</Button>
        <Typography.Text type="secondary">{value.length}/{MAX_IMAGES} ảnh</Typography.Text>
      </Space>
      <Typography.Paragraph type="secondary" style={{ marginTop: -4 }}>
        Kéo thả để sắp xếp. Ảnh đầu tiên là ảnh bìa trên trang chủ và danh sách tour. Ảnh được thu nhỏ còn rộng 1600px trước khi tải lên.
      </Typography.Paragraph>
      {value.length === 0 ? <Empty description="Chưa có ảnh" image={Empty.PRESENTED_IMAGE_SIMPLE} /> : (
        <div className="gallery-admin"
          onDragOver={(e) => e.preventDefault()}>
          {value.map((src, i) => (
            <div key={src} className={`ga-item${drag === i ? ' dragging' : ''}`} draggable
              onDragStart={() => setDrag(i)} onDragEnd={() => setDrag(null)}
              onDrop={(e) => { e.preventDefault(); if (drag != null) move(drag, i); setDrag(null) }}>
              <img src={src} alt="" loading="lazy" />
              {i === 0 && <Tag color="gold" className="ga-cover">Ảnh bìa</Tag>}
              <div className="ga-actions">
                {i > 0 && <Tooltip title="Đặt làm ảnh bìa"><Button size="small" icon={<StarOutlined />} onClick={() => move(i, 0)} /></Tooltip>}
                <Tooltip title="Sang trái"><Button size="small" icon={<ArrowLeftOutlined />} disabled={i === 0} onClick={() => move(i, i - 1)} /></Tooltip>
                <Tooltip title="Sang phải"><Button size="small" icon={<ArrowRightOutlined />} disabled={i === value.length - 1} onClick={() => move(i, i + 1)} /></Tooltip>
                <Popconfirm title="Bỏ ảnh này khỏi tour?" okText="Bỏ" cancelText="Hủy" onConfirm={() => onChange(value.filter((_, j) => j !== i))}>
                  <Tooltip title="Bỏ khỏi tour"><Button size="small" danger icon={<DeleteOutlined />} /></Tooltip>
                </Popconfirm>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
