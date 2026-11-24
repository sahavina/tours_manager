// Tài khoản, vai trò và phân quyền. Quyền hiệu lực của một người = quyền của vai trò + cấp thêm − thu hồi
// (giống has_org_permission ở database). Màn hình cho bấm từng quyền; mã tự tính ra cấp thêm / thu hồi.
import { CheckOutlined, SearchOutlined, UndoOutlined } from '@ant-design/icons'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Alert, App, Avatar, Button, Checkbox, Drawer, Form, Input, Modal, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd'
import { useMemo, useState } from 'react'
import { useAuth } from '../../auth/AuthProvider'
import { ErrorState, NoData } from '../../components/common'
import { ChangePasswordModal } from '../../auth/ChangePasswordModal'
import { accountsApi } from '../../lib/accounts'
import { rpc, rpcOk, supabase, unwrap, type Row } from '../../lib/supabase'

type Perm = { key: string; description: string }
type Role = { key: string; name: string; description: string | null }

// Nhóm quyền theo phân hệ cho dễ đọc. Quyền mới chưa có trong danh sách rơi vào nhóm "Khác".
const GROUPS: { label: string; keys: string[] }[] = [
  { label: 'Doanh nghiệp và tài khoản', keys: ['org.manage', 'member.manage', 'audit.read'] },
  { label: 'Tour và lịch khởi hành', keys: ['catalog.read', 'catalog.manage', 'departure.read', 'departure.manage'] },
  { label: 'Booking và khách hàng', keys: ['booking.read', 'booking.manage', 'booking.export', 'booking.source_read', 'customer.read', 'customer.manage'] },
  { label: 'Điều hành', keys: ['ops.read', 'ops.manage', 'resource.read', 'resource.manage', 'guide.portal'] },
  { label: 'Tài chính', keys: ['finance.read', 'finance.manage'] },
  { label: 'Kết nối, nhập dữ liệu, báo cáo', keys: ['connection.read', 'connection.manage', 'connection.simulate', 'import.manage', 'report.read'] },
]

const ROLE_COLOR: Record<string, string> = {
  owner: 'gold', admin: 'purple', booking_agent: 'blue', operator: 'cyan', accountant: 'green', guide: 'orange', viewer: 'default',
}

function groupPerms(perms: Perm[]) {
  const known = new Set(GROUPS.flatMap((g) => g.keys))
  const byKey = new Map(perms.map((p) => [p.key, p]))
  const groups = GROUPS.map((g) => ({ label: g.label, perms: g.keys.map((k) => byKey.get(k)).filter(Boolean) as Perm[] }))
  const other = perms.filter((p) => !known.has(p.key))
  if (other.length) groups.push({ label: 'Khác', perms: other })
  return groups.filter((g) => g.perms.length)
}

function useCatalog() {
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: async () => unwrap(await supabase.from('roles').select('key, name, description')) as Role[],
  })
  const perms = useQuery({
    queryKey: ['permissions'],
    queryFn: async () => unwrap(await supabase.from('permissions').select('key, description').order('key')) as Perm[],
  })
  const rolePerms = useQuery({
    queryKey: ['role-permissions'],
    queryFn: async () => unwrap(await supabase.from('role_permissions').select('role_key, permission_key')) as Row[],
  })
  const byRole = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const r of rolePerms.data ?? []) {
      if (!m.has(r.role_key)) m.set(r.role_key, new Set())
      m.get(r.role_key)!.add(r.permission_key)
    }
    return m
  }, [rolePerms.data])
  // Thứ tự vai trò từ nhiều quyền đến ít quyền, giống thứ tự tạo trong database.
  const order = ['owner', 'admin', 'booking_agent', 'operator', 'accountant', 'guide', 'viewer']
  const sortedRoles = [...(roles.data ?? [])].sort((a, b) => (order.indexOf(a.key) + 99) % 99 - (order.indexOf(b.key) + 99) % 99)
  return {
    roles: sortedRoles,
    perms: perms.data ?? [],
    byRole,
    loading: roles.isLoading || perms.isLoading || rolePerms.isLoading,
    error: roles.error ?? perms.error ?? rolePerms.error,
  }
}

const RoleTag = ({ role }: { role?: Role }) => (role ? <Tag color={ROLE_COLOR[role.key]}>{role.name}</Tag> : null)

// ---------- Tab "Tài khoản" ----------

export function MembersTab() {
  const { orgId, can, session } = useAuth()
  const { message } = App.useApp()
  const qc = useQueryClient()
  const cat = useCatalog()
  const [edit, setEdit] = useState<Row | null>(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<string | undefined>()
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'locked'>('all')
  const members = useQuery({ queryKey: ['members', orgId], enabled: can('member.manage'), queryFn: () => rpc<Row[]>('member_list', { p_org: orgId }) })
  // Link đặt mật khẩu vừa tạo (tài khoản mới hoặc đặt lại), hiện một lần để người quản lý gửi cho thành viên.
  const [linkFor, setLinkFor] = useState<{ email: string; link: string; created: boolean } | null>(null)
  const [changePw, setChangePw] = useState(false)
  const save = useMutation({
    mutationFn: async (v: Row) => {
      // Thêm thành viên mới: chưa có tài khoản thì tạo trước (qua API của Worker, cần khóa service).
      const acc = edit && !edit.id ? await accountsApi(orgId, String(v.email), 'ensure') : null
      await rpcOk('member_upsert', { p_org: orgId, p_email: v.email, p_role: v.role_key, p_granted: v.granted, p_revoked: v.revoked, p_active: v.is_active })
      return { email: String(v.email), acc }
    },
    onSuccess: ({ email, acc }) => {
      message.success(acc?.created ? 'Đã tạo tài khoản và gán vào doanh nghiệp' : 'Đã lưu phân quyền')
      if (acc?.link) setLinkFor({ email, link: acc.link, created: true })
      setEdit(null); qc.invalidateQueries({ queryKey: ['members'] }); qc.invalidateQueries({ queryKey: ['org-context'] })
    },
    onError: (e: Error) => message.error(e.message),
  })
  const reset = useMutation({
    mutationFn: async (email: string) => ({ email, acc: await accountsApi(orgId, email, 'reset') }),
    onSuccess: ({ email, acc }) => acc.link && setLinkFor({ email, link: acc.link, created: false }),
    onError: (e: Error) => message.error(e.message),
  })

  if (!can('member.manage')) return <NoData text="Bạn không có quyền quản lý tài khoản" />
  if (cat.error) return <ErrorState error={cat.error} />

  const roleOf = (k: string) => cat.roles.find((r) => r.key === k)
  const effectiveCount = (m: Row) => {
    const set = new Set(cat.byRole.get(m.role_key) ?? [])
    for (const p of m.granted_permissions as string[]) set.add(p)
    for (const p of m.revoked_permissions as string[]) set.delete(p)
    return set.size
  }
  const descOf = (k: string) => cat.perms.find((p) => p.key === k)?.description ?? k
  const q = search.trim().toLowerCase()
  const rows = (members.data ?? []).filter((m) =>
    (!q || `${m.email} ${m.full_name ?? ''}`.toLowerCase().includes(q)) &&
    (!roleFilter || m.role_key === roleFilter) &&
    (statusFilter === 'all' || (statusFilter === 'active') === Boolean(m.is_active)))
  const countByRole = new Map<string, number>()
  for (const m of members.data ?? []) countByRole.set(m.role_key, (countByRole.get(m.role_key) ?? 0) + 1)

  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="Thêm thành viên bằng email: chưa có tài khoản thì hệ thống tạo mới và cho bạn một link đặt mật khẩu để gửi cho người đó. Quên mật khẩu thì bấm “Link đặt mật khẩu” ở dòng của họ." />

      <div className="role-chips">
        {cat.roles.map((r) => (
          <button key={r.key} type="button" className={`role-chip${roleFilter === r.key ? ' active' : ''}`}
            onClick={() => setRoleFilter(roleFilter === r.key ? undefined : r.key)}>
            <span>{r.name}</span><b>{countByRole.get(r.key) ?? 0}</b>
          </button>
        ))}
      </div>

      <div className="filters">
        <Input allowClear prefix={<SearchOutlined />} placeholder="Tìm email hoặc họ tên" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
        <Select allowClear placeholder="Mọi vai trò" value={roleFilter} onChange={setRoleFilter} style={{ width: 180 }}
          options={cat.roles.map((r) => ({ value: r.key, label: r.name }))} />
        <Select value={statusFilter} onChange={setStatusFilter} style={{ width: 150 }} options={[
          { value: 'all', label: 'Mọi trạng thái' }, { value: 'active', label: 'Đang hoạt động' }, { value: 'locked', label: 'Đã khóa' },
        ]} />
        <div style={{ flex: 1 }} />
        <Button type="primary" onClick={() => setEdit({})}>Thêm thành viên</Button>
      </div>

      {members.isError ? <ErrorState error={members.error} /> : (
        <Table rowKey="id" size="middle" loading={members.isLoading || cat.loading} dataSource={rows} pagination={false} scroll={{ x: 'max-content' }}
          onRow={(m) => ({ onClick: () => setEdit(m), style: { cursor: 'pointer' } })}
          columns={[
            {
              title: 'Thành viên', render: (_, m) => (
                <Space>
                  <Avatar style={{ background: m.is_active ? '#0f766e' : '#bbb' }}>{String(m.full_name || m.email).trim().charAt(0).toUpperCase()}</Avatar>
                  <div>
                    <div style={{ fontWeight: 500 }}>{m.full_name || '(chưa có tên)'}{m.user_id === session?.user.id && <Tag style={{ marginLeft: 6 }}>Bạn</Tag>}</div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{m.email}</Typography.Text>
                  </div>
                </Space>
              ),
            },
            { title: 'Vai trò', render: (_, m) => <RoleTag role={roleOf(m.role_key)} /> },
            {
              title: 'Quyền', render: (_, m) => {
                const g = m.granted_permissions as string[]
                const r = m.revoked_permissions as string[]
                return (
                  <Space size={4} wrap>
                    <span>{effectiveCount(m)} quyền</span>
                    {g.length > 0 && <Tooltip title={g.map(descOf).join(', ')}><Tag color="green">+{g.length} cấp thêm</Tag></Tooltip>}
                    {r.length > 0 && <Tooltip title={r.map(descOf).join(', ')}><Tag color="red">−{r.length} thu hồi</Tag></Tooltip>}
                    {!g.length && !r.length && <Typography.Text type="secondary" style={{ fontSize: 12 }}>theo vai trò</Typography.Text>}
                  </Space>
                )
              },
            },
            { title: 'Trạng thái', render: (_, m) => (m.is_active ? <Tag color="green">Hoạt động</Tag> : <Tag>Đã khóa</Tag>) },
            { title: '', align: 'right', render: (_, m) => (
              <Space size={4}>
                {m.user_id === session?.user.id ? (
                  <Button size="small" onClick={(e) => { e.stopPropagation(); setChangePw(true) }}>Đổi mật khẩu</Button>
                ) : (
                  <Button size="small" loading={reset.isPending && reset.variables === m.email}
                    onClick={(e) => { e.stopPropagation(); reset.mutate(String(m.email)) }}>Link đặt mật khẩu</Button>
                )}
                <Button size="small" onClick={(e) => { e.stopPropagation(); setEdit(m) }}>Phân quyền</Button>
              </Space>
            ) },
          ]} />
      )}

      <ChangePasswordModal open={changePw} onClose={() => setChangePw(false)} />
      <Modal open={Boolean(linkFor)} onCancel={() => setLinkFor(null)} onOk={() => setLinkFor(null)} okText="Xong" cancelButtonProps={{ style: { display: 'none' } }}
        title={linkFor?.created ? 'Đã tạo tài khoản' : 'Link đặt lại mật khẩu'}>
        {linkFor && (
          <>
            <Typography.Paragraph>
              Gửi link này cho <b>{linkFor.email}</b> qua kênh riêng (Zalo, email…). Mở link, người đó tự đặt mật khẩu rồi đăng nhập;
              không ai khác biết mật khẩu.
            </Typography.Paragraph>
            <Typography.Paragraph copyable={{ text: linkFor.link, tooltips: ['Sao chép link', 'Đã sao chép'] }}
              style={{ background: '#f5f7f8', padding: 10, borderRadius: 8, wordBreak: 'break-all', fontSize: 12 }}>
              {linkFor.link}
            </Typography.Paragraph>
            <Typography.Text type="secondary">Link chỉ dùng được một lần và hết hạn sau một thời gian; hết hạn thì bấm “Link đặt mật khẩu” để lấy link mới.</Typography.Text>
          </>
        )}
      </Modal>

      {edit && (
        <MemberDrawer member={edit} cat={cat} saving={save.isPending} isSelf={edit.user_id === session?.user.id}
          canOwner={can('org.manage')} onClose={() => setEdit(null)} onSave={(v) => save.mutate(v)} />
      )}
    </>
  )
}

function MemberDrawer({ member, cat, saving, isSelf, canOwner, onClose, onSave }: {
  member: Row
  cat: ReturnType<typeof useCatalog>
  saving: boolean
  isSelf: boolean
  canOwner: boolean
  onClose: () => void
  onSave: (v: Row) => void
}) {
  const isNew = !member.id
  const [email, setEmail] = useState<string>(member.email ?? '')
  const [role, setRole] = useState<string>(member.role_key ?? 'viewer')
  const [granted, setGranted] = useState<Set<string>>(new Set(member.granted_permissions ?? []))
  const [revoked, setRevoked] = useState<Set<string>>(new Set(member.revoked_permissions ?? []))
  const [active, setActive] = useState<boolean>(member.is_active ?? true)
  const [emailError, setEmailError] = useState<string | null>(null)
  const fromRole = cat.byRole.get(role) ?? new Set<string>()
  const has = (k: string) => (fromRole.has(k) && !revoked.has(k)) || granted.has(k)
  const groups = groupPerms(cat.perms)
  const effective = cat.perms.filter((p) => has(p.key)).length

  // Đổi vai trò: giữ các điều chỉnh còn có nghĩa với vai trò mới.
  const changeRole = (k: string) => {
    const next = cat.byRole.get(k) ?? new Set<string>()
    setGranted(new Set([...granted].filter((p) => !next.has(p))))
    setRevoked(new Set([...revoked].filter((p) => next.has(p))))
    setRole(k)
  }
  const toggle = (k: string, on: boolean) => {
    const g = new Set(granted)
    const r = new Set(revoked)
    if (fromRole.has(k)) { if (on) r.delete(k); else r.add(k) } else { if (on) g.add(k); else g.delete(k) }
    setGranted(g)
    setRevoked(r)
  }
  const toggleGroup = (keys: string[], on: boolean) => {
    const g = new Set(granted)
    const r = new Set(revoked)
    for (const k of keys) {
      if (fromRole.has(k)) { if (on) r.delete(k); else r.add(k) } else { if (on) g.add(k); else g.delete(k) }
    }
    setGranted(g)
    setRevoked(r)
  }
  const submit = () => {
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setEmailError('Nhập email hợp lệ'); return }
    onSave({ email: email.trim(), role_key: role, granted: [...granted], revoked: [...revoked], is_active: active })
  }
  const roleInfo = cat.roles.find((r) => r.key === role)

  return (
    <Drawer open width="min(760px, 100vw)" onClose={onClose} destroyOnClose
      title={isNew ? 'Thêm thành viên' : <Space>Phân quyền<Typography.Text type="secondary" style={{ fontWeight: 400 }}>{member.full_name || member.email}</Typography.Text></Space>}
      extra={<Space><Button onClick={onClose}>Hủy</Button><Button type="primary" loading={saving} onClick={submit}>Lưu</Button></Space>}>
      <Form layout="vertical">
        <Form.Item label="Email tài khoản" required validateStatus={emailError ? 'error' : undefined} help={emailError}>
          <Input value={email} disabled={!isNew} placeholder="ten@congty.vn" onChange={(e) => { setEmail(e.target.value); setEmailError(null) }} />
        </Form.Item>
      </Form>

      <Typography.Title level={5} style={{ marginTop: 0 }}>Vai trò</Typography.Title>
      <div className="role-picker">
        {cat.roles.map((r) => {
          const disabled = r.key === 'owner' && !canOwner
          return (
            <button key={r.key} type="button" disabled={disabled} className={`role-option${role === r.key ? ' active' : ''}`} onClick={() => changeRole(r.key)}>
              <div className="role-option-head"><span>{r.name}</span>{role === r.key && <CheckOutlined />}</div>
              <div className="role-option-desc">{r.description}</div>
              <div className="role-option-count">{cat.byRole.get(r.key)?.size ?? 0} quyền</div>
            </button>
          )
        })}
      </div>

      <div className="perm-summary">
        <div>
          <b>{effective}</b> / {cat.perms.length} quyền hiệu lực
          {granted.size > 0 && <Tag color="green" style={{ marginLeft: 8 }}>+{granted.size} cấp thêm</Tag>}
          {revoked.size > 0 && <Tag color="red">−{revoked.size} thu hồi</Tag>}
          {!granted.size && !revoked.size && <Typography.Text type="secondary"> · đúng theo vai trò {roleInfo?.name}</Typography.Text>}
        </div>
        <Button size="small" icon={<UndoOutlined />} disabled={!granted.size && !revoked.size}
          onClick={() => { setGranted(new Set()); setRevoked(new Set()) }}>Về mặc định của vai trò</Button>
      </div>

      {groups.map((g) => {
        const keys = g.perms.map((p) => p.key)
        const on = keys.filter(has).length
        return (
          <div key={g.label} className="perm-group">
            <div className="perm-group-head">
              <Checkbox checked={on === keys.length} indeterminate={on > 0 && on < keys.length} onChange={(e) => toggleGroup(keys, e.target.checked)}>
                <b>{g.label}</b>
              </Checkbox>
              <Typography.Text type="secondary">{on}/{keys.length}</Typography.Text>
            </div>
            {g.perms.map((p) => {
              const checked = has(p.key)
              const state = granted.has(p.key) ? 'granted' : revoked.has(p.key) ? 'revoked' : fromRole.has(p.key) ? 'role' : 'none'
              return (
                <label key={p.key} className={`perm-row perm-${state}`}>
                  <Checkbox checked={checked} onChange={(e) => toggle(p.key, e.target.checked)} />
                  <span className="perm-desc">{p.description}<code>{p.key}</code></span>
                  {state === 'role' && <Tag>Theo vai trò</Tag>}
                  {state === 'granted' && <Tag color="green">Cấp thêm</Tag>}
                  {state === 'revoked' && <Tag color="red">Thu hồi</Tag>}
                </label>
              )
            })}
          </div>
        )
      })}

      <div className="perm-group" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <b>Đang hoạt động</b>
          <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>Tắt để khóa: người này không vào được doanh nghiệp nhưng lịch sử vẫn giữ.</Typography.Text></div>
        </div>
        <Tooltip title={isSelf ? 'Không thể tự khóa tài khoản của mình' : undefined}>
          <Switch checked={active} disabled={isSelf} onChange={setActive} />
        </Tooltip>
      </div>
    </Drawer>
  )
}

// ---------- Tab "Vai trò và quyền" ----------

export function RolesTab() {
  const cat = useCatalog()
  if (cat.error) return <ErrorState error={cat.error} />
  const groups = groupPerms(cat.perms)
  type MatrixRow = { key: string; group?: string; perm?: Perm }
  const data: MatrixRow[] = groups.flatMap((g) => [
    { key: `g:${g.label}`, group: g.label },
    ...g.perms.map((p) => ({ key: p.key, perm: p })),
  ])
  return (
    <>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="Vai trò mặc định dùng chung cho mọi doanh nghiệp. Muốn một người có nhiều hoặc ít quyền hơn vai trò của họ, mở tab Tài khoản, bấm Phân quyền rồi bật hoặc tắt từng quyền." />
      <div className="role-cards">
        {cat.roles.map((r) => (
          <div key={r.key} className="role-card">
            <RoleTag role={r} />
            <div className="role-option-desc">{r.description}</div>
            <div className="role-option-count">{cat.byRole.get(r.key)?.size ?? 0} / {cat.perms.length} quyền</div>
          </div>
        ))}
      </div>
      <Table<MatrixRow> rowKey="key" size="small" bordered loading={cat.loading} dataSource={data} pagination={false} scroll={{ x: 'max-content' }}
        rowClassName={(r) => (r.group ? 'perm-matrix-group' : '')}
        columns={[
          {
            title: 'Quyền', fixed: 'left', width: 300, onCell: (r) => (r.group ? { colSpan: cat.roles.length + 1 } : {}),
            render: (_, r) => r.group ? <b>{r.group}</b> : (
              <div>{r.perm!.description}<div><code className="perm-code">{r.perm!.key}</code></div></div>
            ),
          },
          ...cat.roles.map((role) => ({
            title: <span style={{ whiteSpace: 'nowrap' }}>{role.name}</span>,
            align: 'center' as const,
            width: 110,
            onCell: (r: MatrixRow) => (r.group ? { colSpan: 0 } : {}),
            render: (_: unknown, r: MatrixRow) => r.perm && cat.byRole.get(role.key)?.has(r.perm.key)
              ? <CheckOutlined style={{ color: '#0f766e' }} /> : <span style={{ color: '#ccc' }}>·</span>,
          })),
        ]} />
    </>
  )
}
