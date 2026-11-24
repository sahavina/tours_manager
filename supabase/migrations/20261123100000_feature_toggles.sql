-- Bật tắt tính năng theo doanh nghiệp.
--
-- Tắt một tính năng = bỏ các quyền thuộc tính năng đó khỏi mọi thành viên của doanh nghiệp. Vì mọi policy và
-- RPC đều đi qua has_org_permission, tắt ở đây chặn cả database chứ không chỉ ẩn menu. Bật lại thì quyền cũ
-- của từng người trở lại nguyên vẹn (không sửa memberships).
-- Trang đặt tour cho khách không gắn với quyền nào nên chặn riêng ở _storefront_org.
-- Phần lõi (booking, lịch, tour, khách hàng, cài đặt, nhật ký) không tắt được.

alter table public.organizations add column disabled_features text[] not null default '{}';

-- Danh sách tính năng tắt được. Đổi danh sách này thì sửa cả check constraint bên dưới và FEATURES ở trang quản trị.
create function public._feature_keys() returns text[]
language sql immutable set search_path = '' as $$
  select array['storefront', 'operations', 'finance', 'channels', 'imports', 'reports']
$$;

alter table public.organizations add constraint organizations_disabled_features_known
  check (disabled_features <@ array['storefront', 'operations', 'finance', 'channels', 'imports', 'reports']::text[]);

-- Tính năng mà một quyền thuộc về; null là quyền lõi, luôn còn.
create function public._feature_of(p_permission text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_permission like 'ops.%' or p_permission like 'resource.%' or p_permission = 'guide.portal' then 'operations'
    when p_permission like 'finance.%' then 'finance'
    when p_permission like 'connection.%' then 'channels'
    when p_permission = 'import.manage' then 'imports'
    when p_permission = 'report.read' then 'reports'
  end
$$;

create or replace function public.has_org_permission(p_org uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.organizations o on o.id = m.organization_id
    left join public.role_permissions rp
      on rp.role_key = m.role_key and rp.permission_key = p_permission
    where m.organization_id = p_org
      and m.user_id = (select auth.uid())
      and m.is_active
      and not (p_permission = any (m.revoked_permissions))
      and (rp.permission_key is not null or p_permission = any (m.granted_permissions))
      and not coalesce(public._feature_of(p_permission) = any (o.disabled_features), false)
  );
$$;

create or replace function public.my_org_context() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'organization_id', o.id,
    'name', o.name,
    'default_timezone', o.default_timezone,
    'default_currency', o.default_currency,
    'role_key', m.role_key,
    'role_name', r.name,
    'disabled_features', to_jsonb(o.disabled_features),
    'permissions', (
      select coalesce(jsonb_agg(distinct p.key), '[]'::jsonb)
      from public.permissions p
      where not (p.key = any (m.revoked_permissions))
        and (p.key = any (m.granted_permissions)
          or exists (select 1 from public.role_permissions rp
                     where rp.role_key = m.role_key and rp.permission_key = p.key))
        and not coalesce(public._feature_of(p.key) = any (o.disabled_features), false)
    )
  ) order by o.name), '[]'::jsonb)
  from public.memberships m
  join public.organizations o on o.id = m.organization_id
  join public.roles r on r.key = m.role_key
  where m.user_id = (select auth.uid()) and m.is_active;
$$;

-- Trang khách: doanh nghiệp tắt trang đặt tour thì như không tồn tại (not_found), không nhận yêu cầu mới.
create or replace function public._storefront_org(p_slug text) returns public.organizations
language sql stable security definer set search_path = '' as $$
  select o.* from public.organizations o
  where o.slug = coalesce(p_slug, '')
    and not ('storefront' = any (o.disabled_features))
    and exists (select 1 from public.tours t where t.organization_id = o.id and t.is_published and t.is_active and t.deleted_at is null)
$$;

-- Lưu danh sách tính năng đang tắt. Chỉ người có quyền cấu hình doanh nghiệp.
create function public.org_set_features(p_org uuid, p_disabled text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_old text[];
  v_new text[];
begin
  perform public._require(p_org, 'org.manage');
  select coalesce(array_agg(distinct x order by x), '{}') into v_new from unnest(coalesce(p_disabled, '{}')) x;
  if not (v_new <@ public._feature_keys()) then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  select disabled_features into v_old from public.organizations where id = p_org for update;
  update public.organizations set disabled_features = v_new where id = p_org;
  perform public._audit(p_org, 'features_update', 'organizations', p_org::text,
    jsonb_build_object('disabled_features', v_old), jsonb_build_object('disabled_features', v_new));
  return jsonb_build_object('ok', true, 'disabled_features', to_jsonb(v_new));
end $$;

revoke all on function public._feature_keys(), public._feature_of(text), public.org_set_features(uuid, text[]) from public, anon, authenticated;
grant execute on function public.org_set_features(uuid, text[]) to authenticated, service_role;
grant select (disabled_features) on public.organizations to authenticated;
