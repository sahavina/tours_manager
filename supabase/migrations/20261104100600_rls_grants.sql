-- RLS và quyền. Migration này chạy CUỐI: nó quét toàn bộ hàm và bảng đã có.

-- Mặc định của Supabase cấp ALL cho anon/authenticated. Thu về rồi cấp lại đúng cái cần.
revoke all on all tables in schema public from anon, public, authenticated;
revoke all on all functions in schema public from anon, public, authenticated;
revoke all on all sequences in schema public from anon, public, authenticated;

alter default privileges in schema public revoke all on tables from anon, public, authenticated;
alter default privileges in schema public revoke all on functions from anon, public, authenticated;

do $$
declare
  t text;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;

grant select on public.v_booking_list, public.v_departure_availability to authenticated;
grant all on public.v_booking_list, public.v_departure_availability to service_role;
grant usage on all sequences in schema public to service_role;

-- Chỉ cần chọn đúng bộ quyền đọc; bảng còn lại không có quyền ghi trực tiếp, chỉ qua RPC.
do $$
declare
  r record;
begin
  for r in select * from (values
    ('tours', 'catalog.read'), ('tour_options', 'catalog.read'), ('traveler_categories', 'catalog.read'),
    ('inventory_pools', 'departure.read'), ('departures', 'departure.read'), ('inventory_holds', 'departure.read'),
    ('customers', 'customer.read'), ('suppliers', 'resource.read'), ('guides', 'resource.read'), ('vehicles', 'resource.read'),
    ('channel_product_mappings', 'connection.read'),
    ('bookings', 'booking.read'), ('booking_items', 'booking.read'), ('booking_participants', 'booking.read'),
    ('booking_pickups', 'booking.read'), ('booking_notes', 'booking.read'), ('booking_status_history', 'booking.read'),
    ('booking_changes', 'booking.read'), ('booking_source_snapshots', 'booking.source_read'),
    ('booking_financials', 'finance.read'), ('expenses', 'finance.read'),
    ('settlement_batches', 'finance.read'), ('settlement_lines', 'finance.read'), ('reconciliation_matches', 'finance.read'),
    ('guide_assignments', 'ops.read'), ('vehicle_assignments', 'ops.read'), ('passenger_allocations', 'ops.read'),
    ('attendance_records', 'ops.read'), ('departure_incidents', 'ops.read'),
    ('import_jobs', 'import.manage'), ('import_rows', 'import.manage'),
    ('integration_events', 'connection.read'), ('sync_jobs', 'connection.read'), ('outbox_events', 'connection.read'),
    ('audit_logs', 'audit.read')
  ) as x(tbl, perm) loop
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.has_org_permission(organization_id, %L))',
      r.tbl || '_read', r.tbl, r.perm);
  end loop;
end $$;

-- Danh sách booking cần tên kênh, nên người có booking.read cũng đọc được kết nối. Nếu chỉ cho
-- connection.read thì view v_booking_list im lặng trả cột kênh rỗng với nhân viên booking.
-- credential_ref không nằm trong quyền đọc: chỉ có has_credentials.
create policy channel_connections_read on public.channel_connections for select to authenticated using (
  public.has_org_permission(organization_id, 'connection.read')
  or public.has_org_permission(organization_id, 'booking.read')
);
revoke select on public.channel_connections from authenticated;
grant select (id, organization_id, channel, account_name, supplier_account_ref, mode, status, approval_status,
  capabilities, hold_ttl_seconds, has_credentials, last_success_at, last_simulated_at, last_error, last_error_at,
  stale_after_minutes, created_at, updated_at) on public.channel_connections to authenticated;

-- Danh mục sửa trực tiếp được (không có bất biến xuyên bảng). Xóa mềm nên không cấp DELETE.
do $$
declare
  r record;
begin
  for r in select * from (values
    ('tours', 'catalog.manage'), ('tour_options', 'catalog.manage'), ('traveler_categories', 'catalog.manage'),
    ('customers', 'customer.manage'), ('suppliers', 'resource.manage'), ('guides', 'resource.manage'),
    ('vehicles', 'resource.manage'), ('expenses', 'finance.manage')
  ) as x(tbl, perm) loop
    execute format('grant insert, update on public.%I to authenticated', r.tbl);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_org_permission(organization_id, %L))',
      r.tbl || '_insert', r.tbl, r.perm);
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_org_permission(organization_id, %L)) with check (public.has_org_permission(organization_id, %L))',
      r.tbl || '_update', r.tbl, r.perm, r.perm);
  end loop;
end $$;

-- Tổ chức: thành viên xem; chỉ sửa được các cột cấu hình, không chạm số thứ tự booking.
create policy organizations_read on public.organizations for select to authenticated
  using (public.is_org_member(id));
create policy organizations_update on public.organizations for update to authenticated
  using (public.has_org_permission(id, 'org.manage')) with check (public.has_org_permission(id, 'org.manage'));
grant update (name, default_timezone, default_currency, payload_retention_days) on public.organizations to authenticated;

create policy profiles_read on public.profiles for select to authenticated using (
  id = (select auth.uid()) or exists (
    select 1 from public.memberships mine
    join public.memberships other on other.organization_id = mine.organization_id
    where mine.user_id = (select auth.uid()) and mine.is_active and other.user_id = public.profiles.id
  )
);
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));
grant update (full_name) on public.profiles to authenticated;

create policy memberships_read on public.memberships for select to authenticated using (
  user_id = (select auth.uid()) or public.has_org_permission(organization_id, 'member.manage')
);

create policy roles_read on public.roles for select to authenticated using (true);
create policy permissions_read on public.permissions for select to authenticated using (true);
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);

create policy notifications_read on public.notifications for select to authenticated using (
  (user_id is null or user_id = (select auth.uid()))
  and public.has_org_permission(organization_id, required_permission)
);

create policy saved_filters_own on public.saved_filters for all to authenticated
  using (user_id = (select auth.uid()) and public.is_org_member(organization_id))
  with check (user_id = (select auth.uid()) and public.is_org_member(organization_id));
grant insert, update, delete on public.saved_filters to authenticated;

-- Bộ kích hoạt ghi nhật ký cho bảng danh mục.
do $$
declare t text;
begin
  foreach t in array array['tours', 'tour_options', 'customers', 'suppliers', 'guides', 'vehicles', 'expenses']
  loop
    execute format('create trigger %I after insert or update on public.%I for each row execute function public._audit_row()',
      t || '_audit', t);
  end loop;
end $$;

-- Nhật ký không sửa, không xóa, kể cả bằng service_role qua PostgREST.
create function public._audit_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_logs is append-only' using errcode = '42501';
end $$;
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public._audit_immutable();

-- Cấp EXECUTE: mọi hàm công khai trừ hàm nội bộ (`_`) và hàm của worker/cổng thật.
do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig, p.proname
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname not like '\_%' and f.proname not like 'worker\_%'
       and f.proname not in ('connection_mark_health', 'set_updated_at') then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
  end loop;
end $$;
