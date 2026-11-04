-- SAHA Tour Hub: nền tảng đa doanh nghiệp, định danh, phân quyền, nhật ký.
--
-- Quy ước (theo keodansaha):
--   * Mọi bảng nghiệp vụ có organization_id và UNIQUE (organization_id, id), để bảng con trỏ bằng FK
--     HAI CỘT: liên kết chéo doanh nghiệp bị database chặn, không phụ thuộc code nhớ kiểm tra.
--   * RPC trả kết quả nghiệp vụ bằng jsonb {ok, code, ...}, chỉ raise khi sai quyền hoặc sai đầu vào.
--   * Hàm tiền tố `_` là nội bộ: không cấp EXECUTE cho anon/authenticated (xem migration cuối).

create type public.channel_kind as enum ('viator', 'getyourguide', 'manual', 'other');
create type public.connection_mode as enum ('mock', 'sandbox', 'production');
create type public.connection_status as enum
  ('not_configured', 'simulated', 'pending_approval', 'connected', 'error', 'disabled');
create type public.booking_status as enum ('pending', 'confirmed', 'cancelled', 'completed', 'no_show');
create type public.ops_status as enum
  ('new', 'needs_mapping', 'needs_departure', 'needs_info', 'ready', 'assigned', 'done', 'cancelled');
create type public.payment_status as enum
  ('unknown', 'unpaid', 'partially_paid', 'paid', 'partially_refunded', 'refunded');
create type public.reconciliation_status as enum ('unreconciled', 'matched', 'mismatch', 'adjusted');
create type public.sync_status as enum ('manual', 'simulated', 'synced', 'stale', 'error');
create type public.hold_status as enum ('active', 'converted', 'released', 'expired');
create type public.departure_status as enum ('scheduled', 'cancelled', 'completed');
create type public.attendance_status as enum ('pending', 'picked_up', 'no_show');
create type public.event_status as enum
  ('received', 'processed', 'ignored_stale', 'failed', 'dead');
create type public.job_status as enum ('pending', 'running', 'done', 'failed', 'dead');
create type public.channel_request_status as enum
  ('not_applicable', 'manual_required', 'requested', 'confirmed', 'rejected');
create type public.import_classification as enum ('create', 'update', 'duplicate', 'error');

create function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  default_timezone text not null default 'Asia/Ho_Chi_Minh',
  default_currency char(3) not null default 'VND',
  booking_prefix text not null default 'SH',
  payload_retention_days int not null default 180 check (payload_retention_days > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger organizations_updated before update on public.organizations
  for each row execute function public.set_updated_at();

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated before update on public.profiles
  for each row execute function public.set_updated_at();

create function public._handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public._handle_new_user();

create table public.permissions (
  key text primary key,
  description text not null
);

create table public.roles (
  key text primary key,
  name text not null,
  description text
);

create table public.role_permissions (
  role_key text not null references public.roles (key) on delete cascade,
  permission_key text not null references public.permissions (key) on delete cascade,
  primary key (role_key, permission_key)
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role_key text not null references public.roles (key),
  -- Tinh chỉnh theo người: vai trò "Chỉ xem" được cấp thêm phân hệ tài chính chẳng hạn.
  granted_permissions text[] not null default '{}',
  revoked_permissions text[] not null default '{}',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id) where is_active;
create trigger memberships_updated before update on public.memberships
  for each row execute function public.set_updated_at();

insert into public.permissions (key, description) values
  ('org.manage', 'Cấu hình doanh nghiệp'),
  ('member.manage', 'Quản lý tài khoản và vai trò'),
  ('catalog.read', 'Xem tour và gói'),
  ('catalog.manage', 'Sửa tour và gói'),
  ('departure.read', 'Xem lịch khởi hành'),
  ('departure.manage', 'Sửa chuyến và sức chứa'),
  ('booking.read', 'Xem booking'),
  ('booking.manage', 'Tạo và sửa thông tin nội bộ của booking'),
  ('booking.export', 'Xuất CSV booking'),
  ('booking.source_read', 'Xem dữ liệu nguồn của booking'),
  ('customer.read', 'Xem khách hàng'),
  ('customer.manage', 'Sửa và gộp khách hàng'),
  ('resource.read', 'Xem hướng dẫn viên, xe, nhà cung cấp'),
  ('resource.manage', 'Sửa hướng dẫn viên, xe, nhà cung cấp'),
  ('ops.read', 'Xem điều hành'),
  ('ops.manage', 'Phân công, điểm đón, điểm danh'),
  ('finance.read', 'Xem tài chính và đối soát'),
  ('finance.manage', 'Sửa tài chính, chi phí, đối soát'),
  ('connection.read', 'Xem kết nối kênh và nhật ký'),
  ('connection.manage', 'Sửa kết nối và ghép mã'),
  ('connection.simulate', 'Chạy bộ mô phỏng trên kết nối Mock'),
  ('import.manage', 'Nhập dữ liệu từ file'),
  ('report.read', 'Xem báo cáo vận hành'),
  ('audit.read', 'Xem nhật ký hoạt động'),
  ('guide.portal', 'Dùng giao diện hướng dẫn viên');

insert into public.roles (key, name, description) values
  ('owner', 'Chủ doanh nghiệp', 'Toàn quyền trong doanh nghiệp'),
  ('admin', 'Quản trị viên', 'Cấu hình, tài khoản, danh mục, kết nối'),
  ('booking_agent', 'Nhân viên booking', 'Xem/tạo booking, cập nhật thông tin nội bộ'),
  ('operator', 'Điều hành', 'Quản lý chuyến, phân xe, hướng dẫn viên, điểm đón'),
  ('accountant', 'Kế toán', 'Đối soát, thu chi, chi phí và báo cáo tài chính'),
  ('guide', 'Hướng dẫn viên', 'Chỉ chuyến được giao'),
  ('viewer', 'Chỉ xem', 'Xem các phân hệ vận hành; tài chính phải được cấp riêng');

insert into public.role_permissions (role_key, permission_key)
select 'owner', key from public.permissions where key <> 'guide.portal'
union all
select 'admin', key from public.permissions
  where key in ('org.manage', 'member.manage', 'catalog.read', 'catalog.manage', 'departure.read',
    'departure.manage', 'booking.read', 'booking.manage', 'booking.source_read', 'customer.read',
    'resource.read', 'resource.manage', 'ops.read', 'connection.read', 'connection.manage',
    'connection.simulate', 'import.manage', 'report.read', 'audit.read')
union all
select 'booking_agent', key from public.permissions
  where key in ('catalog.read', 'departure.read', 'booking.read', 'booking.manage', 'booking.export',
    'customer.read', 'customer.manage', 'import.manage', 'ops.read', 'report.read')
union all
select 'operator', key from public.permissions
  where key in ('catalog.read', 'departure.read', 'departure.manage', 'booking.read',
    'customer.read', 'resource.read', 'resource.manage', 'ops.read', 'ops.manage', 'report.read')
union all
select 'accountant', key from public.permissions
  where key in ('catalog.read', 'departure.read', 'booking.read', 'booking.export', 'customer.read',
    'finance.read', 'finance.manage', 'connection.read', 'import.manage', 'report.read')
union all
select 'guide', 'guide.portal'
union all
select 'viewer', key from public.permissions
  where key in ('catalog.read', 'departure.read', 'booking.read', 'customer.read', 'resource.read',
    'ops.read', 'report.read');

-- Quyền hiệu lực của một người trong một doanh nghiệp. SECURITY DEFINER để policy gọi được mà không
-- đệ quy RLS; search_path rỗng để không bị đánh tráo bảng.
create function public.has_org_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    left join public.role_permissions rp
      on rp.role_key = m.role_key and rp.permission_key = p_permission
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and m.is_active
      and not (p_permission = any (m.revoked_permissions))
      and (rp.permission_key is not null or p_permission = any (m.granted_permissions))
  );
$$;

create function public.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.organization_id = p_org and m.user_id = (select auth.uid()) and m.is_active
  );
$$;

-- Chặn ở đầu mọi RPC. Raise (không trả ok=false) vì sai quyền không phải kết quả nghiệp vụ.
create function public._require(p_org uuid, p_permission text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_org is null or not public.has_org_permission(p_org, p_permission) then
    raise exception 'forbidden' using errcode = '42501', detail = p_permission;
  end if;
end $$;

-- Trình duyệt dùng hàm này để biết doanh nghiệp và quyền của mình.
create function public.my_org_context() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id', o.id,
    'name', o.name,
    'default_timezone', o.default_timezone,
    'default_currency', o.default_currency,
    'role_key', m.role_key,
    'role_name', r.name,
    'permissions', (
      select coalesce(jsonb_agg(distinct p.key), '[]'::jsonb)
      from public.permissions p
      where not (p.key = any (m.revoked_permissions))
        and (p.key = any (m.granted_permissions)
          or exists (select 1 from public.role_permissions rp
                     where rp.role_key = m.role_key and rp.permission_key = p.key))
    )
  ) order by o.name), '[]'::jsonb)
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  join public.roles r on r.key = m.role_key
  where m.user_id = (select auth.uid()) and m.is_active;
$$;

-- Nhật ký chỉ-ghi-thêm: không policy update/delete, và trigger chặn cả owner lỡ tay qua PostgREST.
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations (id) on delete cascade,
  actor_id uuid,
  action text not null,
  entity text not null,
  entity_id text,
  before_data jsonb,
  after_data jsonb,
  correlation_id text,
  created_at timestamptz not null default now()
);
create index audit_logs_org_time_idx on public.audit_logs (organization_id, created_at desc);
create index audit_logs_entity_idx on public.audit_logs (organization_id, entity, entity_id);

create function public._audit(
  p_org uuid, p_action text, p_entity text, p_entity_id text,
  p_before jsonb default null, p_after jsonb default null, p_correlation text default null
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_logs
    (organization_id, actor_id, action, entity, entity_id, before_data, after_data, correlation_id)
  values (p_org, (select auth.uid()), p_action, p_entity, p_entity_id, p_before, p_after, p_correlation);
$$;

-- Trigger ghi nhật ký cho bảng danh mục và phân công.
create function public._audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb := case when tg_op = 'DELETE' then null else to_jsonb(new) end;
  v_old jsonb := case when tg_op = 'INSERT' then null else to_jsonb(old) end;
begin
  perform public._audit(
    coalesce((v_new ->> 'organization_id')::uuid, (v_old ->> 'organization_id')::uuid),
    lower(tg_op), tg_table_name, coalesce(v_new ->> 'id', v_old ->> 'id'), v_old, v_new
  );
  return coalesce(new, old);
end $$;

-- Lọc khóa nhạy cảm khỏi payload trước khi lưu. Đệ quy cả mảng lồng nhau.
create function public._sanitize_payload(p jsonb) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_key text;
  v_val jsonb;
  v_out jsonb;
begin
  if jsonb_typeof(p) = 'object' then
    v_out := '{}'::jsonb;
    for v_key, v_val in select * from jsonb_each(p) loop
      if v_key ~* '(password|passwd|secret|token|api[_-]?key|authorization|cvv|cvc|card[_-]?number|pan$|passport)' then
        v_out := v_out || jsonb_build_object(v_key, '[đã che]');
      else
        v_out := v_out || jsonb_build_object(v_key, public._sanitize_payload(v_val));
      end if;
    end loop;
    return v_out;
  elsif jsonb_typeof(p) = 'array' then
    select coalesce(jsonb_agg(public._sanitize_payload(e)), '[]'::jsonb) into v_out
    from jsonb_array_elements(p) e;
    return v_out;
  end if;
  return p;
end $$;
