import {
  ApiOutlined, AuditOutlined, BarChartOutlined, BellOutlined, CalendarOutlined, CarOutlined, CloudUploadOutlined,
  CompassOutlined, DashboardOutlined, DollarOutlined, FileTextOutlined, GlobalOutlined, InboxOutlined, MailOutlined,
  MenuOutlined, PictureOutlined, PlusOutlined, ProfileOutlined, ScheduleOutlined, SettingOutlined, TagsOutlined, TeamOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AutoComplete, Avatar, Badge, Button, Drawer, Dropdown, Grid, Input, Layout, List, Menu, Popover, Segmented, Select, Space, Typography } from 'antd'
import { Suspense, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { fmtDateTime, Loading } from '../components/common'
import { rpc, supabase, unwrap, type Row } from '../lib/supabase'
import { areaOf, rememberArea, type Area } from './area'

type NavItem = { key: string; label: string; icon: React.ReactNode; perm: string | string[] }

// Khu Điều hành: vận hành tour, booking, nguồn lực, tài chính, cấu hình.
const NAV: NavItem[] = [
  { key: '/dashboard', label: 'Tổng quan', icon: <DashboardOutlined />, perm: 'booking.read' },
  { key: '/bookings', label: 'Booking', icon: <ProfileOutlined />, perm: 'booking.read' },
  { key: '/departures', label: 'Lịch khởi hành', icon: <CalendarOutlined />, perm: 'departure.read' },
  { key: '/operations', label: 'Điều hành', icon: <ScheduleOutlined />, perm: 'ops.read' },
  { key: '/tours', label: 'Tour và gói dịch vụ', icon: <CompassOutlined />, perm: 'catalog.read' },
  { key: '/customers', label: 'Khách hàng', icon: <UserOutlined />, perm: 'customer.read' },
  { key: '/guides', label: 'Hướng dẫn viên', icon: <TeamOutlined />, perm: 'resource.read' },
  { key: '/vehicles', label: 'Xe và nhà cung cấp', icon: <CarOutlined />, perm: 'resource.read' },
  { key: '/finance', label: 'Tài chính và đối soát', icon: <DollarOutlined />, perm: 'finance.read' },
  { key: '/connections', label: 'Kết nối kênh', icon: <ApiOutlined />, perm: 'connection.read' },
  { key: '/imports', label: 'Nhập dữ liệu', icon: <CloudUploadOutlined />, perm: 'import.manage' },
  { key: '/reports', label: 'Báo cáo', icon: <BarChartOutlined />, perm: 'report.read' },
  { key: '/audit', label: 'Nhật ký hoạt động', icon: <AuditOutlined />, perm: 'audit.read' },
  { key: '/settings', label: 'Cài đặt', icon: <SettingOutlined />, perm: ['member.manage', 'org.manage'] },
]

// Khu Website: mọi thứ khách thấy trên trang đặt tour.
const WEB_NAV: NavItem[] = [
  { key: '/web', label: 'Tổng quan website', icon: <GlobalOutlined />, perm: 'web.manage' },
  { key: '/web/requests', label: 'Yêu cầu đặt tour', icon: <InboxOutlined />, perm: 'booking.read' },
  { key: '/web/tours', label: 'Tour trên web', icon: <PictureOutlined />, perm: 'web.manage' },
  { key: '/web/options', label: 'Giá và gói trên web', icon: <TagsOutlined />, perm: 'web.manage' },
  { key: '/web/content', label: 'Nội dung trang', icon: <FileTextOutlined />, perm: 'web.manage' },
  { key: '/web/email', label: 'Email thông báo', icon: <MailOutlined />, perm: 'web.manage' },
]
const allowed = (items: NavItem[], can: (p: string) => boolean) =>
  items.filter((n) => (Array.isArray(n.perm) ? n.perm.some(can) : can(n.perm)))

function QuickSearch() {
  const { orgId } = useAuth()
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const { data } = useQuery({
    queryKey: ['quick-search', orgId, q],
    enabled: q.trim().length >= 2,
    queryFn: () => rpc<Row>('quick_search', { p_org: orgId, p_query: q }),
  })
  const options = useMemo(() => {
    if (!data) return []
    const group = (label: string, rows: Row[], map: (r: Row) => { value: string; label: string }) =>
      rows.length ? [{ label, options: rows.map(map) }] : []
    return [
      ...group('Booking', data.bookings ?? [], (b) => ({ value: `/bookings/${b.id}`, label: `${b.code} · ${b.lead_name ?? ''} ${b.external_ref ? `· ${b.external_ref}` : ''}` })),
      ...group('Khách hàng', data.customers ?? [], (c) => ({ value: `/customers?q=${encodeURIComponent(c.full_name)}`, label: `${c.full_name}${c.email ? ` · ${c.email}` : ''}` })),
      ...group('Tour', data.tours ?? [], (t) => ({ value: `/tours?q=${encodeURIComponent(t.code)}`, label: `${t.code} · ${t.name}` })),
    ]
  }, [data])

  return (
    <AutoComplete style={{ width: '100%', maxWidth: 360 }} options={options} value={q} onChange={setQ}
      onSelect={(v: string) => { setQ(''); nav(v) }}>
      <Input.Search placeholder="Tìm mã booking, khách, tour" aria-label="Tìm nhanh" />
    </AutoComplete>
  )
}

function Notifications() {
  const { orgId } = useAuth()
  const nav = useNavigate()
  const qc = useQueryClient()
  const { data } = useQuery({
    queryKey: ['notifications', orgId],
    enabled: Boolean(orgId),
    refetchInterval: 60_000,
    queryFn: async () =>
      unwrap(await supabase.from('notifications').select('id, title, body, link, read_at, created_at')
        .eq('organization_id', orgId).order('created_at', { ascending: false }).limit(20)) as Row[],
  })
  const unread = data?.filter((n) => !n.read_at).length ?? 0
  const markAll = useMutation({
    mutationFn: () => rpc('notifications_mark_read', { p_org: orgId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  })
  return (
    <Popover trigger="click" placement="bottomRight" title={
      <Space style={{ width: '100%', justifyContent: 'space-between' }}>
        <span>Thông báo</span>
        {unread > 0 && <Button size="small" type="link" onClick={() => markAll.mutate()}>Đánh dấu đã đọc</Button>}
      </Space>
    } content={
      <List style={{ width: 320, maxHeight: 400, overflow: 'auto' }} size="small" dataSource={data ?? []}
        locale={{ emptyText: 'Chưa có thông báo' }}
        renderItem={(n) => (
          <List.Item style={{ cursor: n.link ? 'pointer' : undefined, opacity: n.read_at ? 0.6 : 1 }} onClick={() => n.link && nav(n.link)}>
            <List.Item.Meta title={n.title} description={<>{n.body && <div>{n.body}</div>}<span className="muted">{fmtDateTime(n.created_at)}</span></>} />
          </List.Item>
        )} />
    }>
      <Badge count={unread} size="small"><Button type="text" icon={<BellOutlined />} aria-label="Thông báo" /></Badge>
    </Popover>
  )
}

export function AdminLayout() {
  const { org, orgs, switchOrg, can, session, signOut } = useAuth()
  const location = useLocation()
  const nav = useNavigate()
  const screens = Grid.useBreakpoint()
  const [menuOpen, setMenuOpen] = useState(false)
  const isDesktop = screens.lg !== false

  const area: Area = areaOf(location.pathname)
  useEffect(() => rememberArea(area), [area])
  // Người chỉ xem được danh mục tour (vai trò Biên tập web) không có khu Điều hành.
  const opsAll = allowed(NAV, can)
  const opsItems = opsAll.some((i) => i.key !== '/tours') || can('catalog.manage') ? opsAll : []
  // Người chỉ có quyền Website không thấy trang "Yêu cầu đặt tour" nếu không được xem booking (lọc theo quyền ở trên).
  const webItems = can('web.manage') ? allowed(WEB_NAV, can) : []
  const both = opsItems.length > 0 && webItems.length > 0
  const items = (area === 'web' ? webItems : opsItems).map(({ key, label, icon }) => ({ key, label, icon }))
  // Mục khớp dài nhất (để /web/tours không chọn nhầm /web).
  const selected = items.filter((i) => location.pathname === i.key || location.pathname.startsWith(i.key + '/'))
    .sort((a, b) => b.key.length - a.key.length)[0]?.key
  const switchArea = (a: Area) => nav(a === 'web' ? webItems[0]!.key : opsItems[0]!.key)
  const brand = (
    <div style={{ padding: '16px 20px 8px' }}>
      <div style={{ fontWeight: 700, fontSize: 16, color: area === 'web' ? '#7c3aed' : '#0f766e' }}>SAHA Tour Hub</div>
      <div className="muted" style={{ fontSize: 12 }}>{area === 'web' ? 'Website đặt tour' : 'Điều hành'}</div>
      {both && (
        <Segmented block size="small" style={{ marginTop: 10 }} value={area} onChange={(v) => { switchArea(v as Area); setMenuOpen(false) }}
          options={[{ value: 'ops', label: 'Điều hành' }, { value: 'web', label: 'Website' }]} />
      )}
    </div>
  )

  const menu = (
    <Menu mode="inline" selectedKeys={selected ? [selected] : []} items={items} style={{ borderInlineEnd: 0 }}
      onClick={({ key }) => { nav(key); setMenuOpen(false) }} />
  )

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {isDesktop && (
        <Layout.Sider width={232} theme="light" style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'auto', borderInlineEnd: '1px solid #eef0f3' }}>
          {brand}
          {menu}
        </Layout.Sider>
      )}
      <Drawer placement="left" open={!isDesktop && menuOpen} onClose={() => setMenuOpen(false)} width={260} title={null} styles={{ body: { padding: 0 } }}>
        {brand}
        {menu}
      </Drawer>
      <Layout>
        <Layout.Header style={{ background: '#fff', padding: '0 16px', display: 'flex', gap: 12, alignItems: 'center', borderBottom: '1px solid #eef0f3', position: 'sticky', top: 0, zIndex: 10 }}>
          {!isDesktop && <Button type="text" icon={<MenuOutlined />} onClick={() => setMenuOpen(true)} aria-label="Mở menu" />}
          {screens.md !== false && (orgs.length > 1
            ? <Select value={org?.organization_id} onChange={switchOrg} style={{ minWidth: 180 }} options={orgs.map((o) => ({ value: o.organization_id, label: o.name }))} aria-label="Doanh nghiệp" />
            : <Typography.Text strong className="nowrap">{org?.name}</Typography.Text>)}
          <div style={{ flex: 1, minWidth: 0 }}><QuickSearch /></div>
          {both && !isDesktop && (
            <Segmented size="small" value={area} onChange={(v) => switchArea(v as Area)}
              options={[{ value: 'ops', label: 'Điều hành' }, { value: 'web', label: 'Web' }]} />
          )}
          {area === 'ops' && can('booking.manage') && (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => nav('/bookings?new=1')}>{screens.md !== false ? 'Tạo booking' : ''}</Button>
          )}
          <Notifications />
          <Dropdown trigger={['click']} menu={{ items: [
            { key: 'who', disabled: true, label: <div>{session?.user.email}<div className="muted">{org?.role_name}</div></div> },
            { type: 'divider' },
            ...(can('guide.portal') ? [{ key: 'guide', label: 'Giao diện hướng dẫn viên', onClick: () => nav('/guide') }] : []),
            { key: 'out', label: 'Đăng xuất', onClick: () => void signOut() },
          ] }}>
            <Avatar style={{ background: '#0f766e', cursor: 'pointer', flex: 'none' }} icon={<UserOutlined />} />
          </Dropdown>
        </Layout.Header>
        <Layout.Content style={{ padding: 20 }}>
          <Suspense fallback={<Loading />}><Outlet /></Suspense>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
