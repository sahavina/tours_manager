// Bật tắt tính năng theo doanh nghiệp. Tắt một tính năng thì database bỏ các quyền thuộc tính năng đó khỏi mọi
// thành viên (has_org_permission), nên menu, trang và thao tác đều theo. Bật lại thì quyền cũ trở lại nguyên vẹn.
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Popconfirm, Switch, Tag, Typography } from 'antd'
import { useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { rpcOk } from '../../lib/supabase'

// Giữ khớp với public._feature_keys() và public._feature_of() trong migration 20261123100000_feature_toggles.sql.
const FEATURES: { key: string; name: string; hides: string; note?: string; warn?: string }[] = [
  {
    key: 'storefront', name: 'Trang đặt tour cho khách',
    hides: 'Trang đặt tour công khai báo "không tìm thấy" và không nhận yêu cầu đặt mới. Yêu cầu đã gửi vẫn nằm trong danh sách booking.',
  },
  {
    key: 'operations', name: 'Điều hành, hướng dẫn viên và xe',
    hides: 'Ẩn Điều hành, Hướng dẫn viên, Xe và nhà cung cấp, giao diện hướng dẫn viên.',
    warn: 'Hướng dẫn viên sẽ không vào được giao diện của họ.',
  },
  { key: 'finance', name: 'Tài chính và đối soát', hides: 'Ẩn Tài chính và đối soát, và các thao tác thu chi, đối soát.' },
  {
    key: 'channels', name: 'Kết nối kênh', hides: 'Ẩn màn hình Kết nối kênh và nhật ký đồng bộ.',
    warn: 'Không ngắt kết nối API đang chạy: cổng GetYourGuide vẫn nhận booking. Muốn ngừng nhận booking từ kênh, tắt từng kết nối trong màn hình Kết nối kênh trước khi tắt tính năng này.',
  },
  { key: 'imports', name: 'Nhập dữ liệu từ file', hides: 'Ẩn màn hình Nhập dữ liệu (file đặt chỗ từ các sàn).' },
  { key: 'reports', name: 'Báo cáo', hides: 'Ẩn màn hình Báo cáo vận hành.' },
]

const CORE = ['Tổng quan', 'Booking', 'Lịch khởi hành', 'Tour và gói dịch vụ', 'Khách hàng', 'Nhật ký hoạt động', 'Cài đặt']

export function FeaturesTab() {
  const { org, orgId, can } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const disabled = new Set(org?.disabled_features ?? [])
  const [pending, setPending] = useState<string | null>(null)
  const canEdit = can('org.manage')

  const save = useMutation({
    mutationFn: (next: string[]) => rpcOk('org_set_features', { p_org: orgId, p_disabled: next }),
    onSuccess: () => { message.success('Đã lưu cài đặt tính năng'); qc.invalidateQueries({ queryKey: ['org-context'] }) },
    onError: (e: Error) => message.error(e.message),
    onSettled: () => setPending(null),
  })
  const set = (key: string, on: boolean) => {
    const next = new Set(disabled)
    if (on) next.delete(key); else next.add(key)
    setPending(key)
    save.mutate([...next])
  }

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 16 }} message="Tắt một tính năng là ẩn và khóa phần đó với mọi tài khoản trong doanh nghiệp này, kể cả chủ doanh nghiệp. Dữ liệu không bị xóa; bật lại thì mọi thứ và quyền của từng người trở lại như cũ."
        description={!canEdit ? 'Bạn chỉ xem được: cần quyền cấu hình doanh nghiệp để bật tắt.' : undefined} />
      <div className="feature-list">
        {FEATURES.map((f) => {
          const on = !disabled.has(f.key)
          const toggle = <Switch checked={on} loading={pending === f.key} disabled={!canEdit || save.isPending} checkedChildren="Bật" unCheckedChildren="Tắt" />
          return (
            <div key={f.key} className={`feature-card${on ? '' : ' off'}`}>
              <div style={{ flex: 1 }}>
                <div className="feature-name">{f.name} {!on && <Tag>Đang tắt</Tag>}</div>
                <div className="feature-desc">Khi tắt: {f.hides}</div>
                {f.warn && <div className="feature-warn">{f.warn}</div>}
              </div>
              {on
                ? <Popconfirm title={`Tắt "${f.name}"?`} description="Mọi tài khoản sẽ không thấy phần này nữa." okText="Tắt" cancelText="Hủy" disabled={!canEdit} onConfirm={() => set(f.key, false)}>{toggle}</Popconfirm>
                : <span onClick={() => canEdit && !save.isPending && set(f.key, true)}>{toggle}</span>}
            </div>
          )
        })}
      </div>
      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
        Phần lõi luôn bật: {CORE.join(', ')}.
      </Typography.Paragraph>
    </>
  )
}
