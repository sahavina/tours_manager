import {
  ApiOutlined, AuditOutlined, BarChartOutlined, BellOutlined, CalendarOutlined, CarOutlined, CloudUploadOutlined,
  CompassOutlined, DashboardOutlined, DollarOutlined, MenuOutlined, PlusOutlined, ProfileOutlined, ScheduleOutlined,
  SettingOutlined, TeamOutlined, UserOutlined,
} from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AutoComplete, Avatar, Badge, Button, Drawer, Dropdown, Grid, Input, Layout, List, Menu, Popover, Select, Space, Typography } from 'antd'
import { Suspense, useMemo, useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { fmtDateTime, Loading } from '../components/common'
import { rpc, supabase, unwrap, type Row } from '../lib/supabase'

const NAV = [
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
  { key: '/settings', label: 'Cài đặt', icon: <SettingOutlined />, perm: ['member.manage', 'org.manage', 'catalog.manage'] },
]

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

  const items = NAV.filter((n) => (Array.isArray(n.perm) ? n.perm.some(can) : can(n.perm))).map(({ key, label, icon }) => ({ key, label, icon }))
  const selected = items.find((i) => location.pathname.startsWith(i.key))?.key

  const menu = (
    <Menu mode="inline" selectedKeys={selected ? [selected] : []} items={items} style={{ borderInlineEnd: 0 }}
      onClick={({ key }) => { nav(key); setMenuOpen(false) }} />
  )

  return (
    <Layout style={{ minHeight: '100vh' }}>
      {isDesktop && (
        <Layout.Sider width={232} theme="light" style={{ position: 'sticky', top: 0, height: '100vh', overflow: 'auto', borderInlineEnd: '1px solid #eef0f3' }}>
          <div style={{ padding: '16px 20px', fontWeight: 700, fontSize: 16, color: '#0f766e' }}>SAHA Tour Hub</div>
          {menu}
        </Layout.Sider>
      )}
      <Drawer placement="left" open={!isDesktop && menuOpen} onClose={() => setMenuOpen(false)} width={260} title="SAHA Tour Hub" styles={{ body: { padding: 0 } }}>
        {menu}
      </Drawer>
      <Layout>
        <Layout.Header style={{ background: '#fff', padding: '0 16px', display: 'flex', gap: 12, alignItems: 'center', borderBottom: '1px solid #eef0f3', position: 'sticky', top: 0, zIndex: 10 }}>
          {!isDesktop && <Button type="text" icon={<MenuOutlined />} onClick={() => setMenuOpen(true)} aria-label="Mở menu" />}
          {screens.md !== false && (orgs.length > 1
            ? <Select value={org?.organization_id} onChange={switchOrg} style={{ minWidth: 180 }} options={orgs.map((o) => ({ value: o.organization_id, label: o.name }))} aria-label="Doanh nghiệp" />
            : <Typography.Text strong className="nowrap">{org?.name}</Typography.Text>)}
          <div style={{ flex: 1, minWidth: 0 }}><QuickSearch /></div>
          {can('booking.manage') && (
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
