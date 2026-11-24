-- Khu "Website" trong trang quản trị, tách khỏi khu "Điều hành".
--
-- Quyền mới web.manage: sửa phần hiển thị trên trang đặt tour (nội dung, ảnh, công khai của tour; tên cho khách,
-- giá web của gói; nội dung trang; email thông báo). Vai trò mới web_editor = catalog.read + web.manage.
-- Người chỉ có web.manage không sửa được cột vận hành (mã, thời lượng, sức chứa, múi giờ, hạn nhận khách...):
-- trigger chặn. Người có catalog.manage / org.manage sửa được tất cả như trước.
-- Tắt tính năng "storefront" thì web.manage cũng mất (như các quyền của tính năng khác).

insert into public.permissions (key, description) values
  ('web.manage', 'Quản lý website đặt tour: nội dung và ảnh tour, giá web, nội dung trang, email thông báo')
on conflict (key) do nothing;
insert into public.roles (key, name, description) values
  ('web_editor', 'Biên tập web', 'Chỉ khu Website: nội dung tour, ảnh, giá web, nội dung trang, email thông báo')
on conflict (key) do nothing;
insert into public.role_permissions (role_key, permission_key) values
  ('owner', 'web.manage'), ('admin', 'web.manage'), ('web_editor', 'web.manage'), ('web_editor', 'catalog.read')
on conflict do nothing;

create or replace function public._feature_of(p_permission text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_permission like 'ops.%' or p_permission like 'resource.%' or p_permission = 'guide.portal' then 'operations'
    when p_permission like 'finance.%' then 'finance'
    when p_permission like 'connection.%' then 'channels'
    when p_permission = 'import.manage' then 'imports'
    when p_permission = 'report.read' then 'reports'
    when p_permission = 'web.manage' then 'storefront'
  end
$$;

-- Người sửa là người dùng đăng nhập chỉ có web.manage: chỉ cho đổi các cột hiển thị trên web.
-- Lời gọi không có người dùng (service_role, script quản trị) không bị giới hạn.
create function public._web_only_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_full text := tg_argv[0];
  v_allowed text[] := string_to_array(tg_argv[1], ',');
begin
  if (select auth.uid()) is null or public.has_org_permission(new.organization_id, v_full) then
    return new;
  end if;
  if (to_jsonb(new) - v_allowed - 'updated_at') is distinct from (to_jsonb(old) - v_allowed - 'updated_at') then
    raise exception 'web_only_columns' using errcode = '42501',
      hint = 'Quyền Website chỉ sửa được nội dung hiển thị trên trang đặt tour';
  end if;
  return new;
end $$;

create trigger tours_web_only before update on public.tours for each row execute function public._web_only_guard(
  'catalog.manage', 'name,description,highlights,itinerary,inclusions,exclusions,joining_instructions,what_to_bring,good_to_know,gallery,image_url,content_vi,is_published,duration_label');
create trigger tour_options_web_only before update on public.tour_options for each row execute function public._web_only_guard(
  'catalog.manage', 'public_name,price_adult,price_child,price_currency,group_prices,child_note,content_vi,is_published');

-- organizations: cột id thay cho organization_id, nên dùng trigger riêng.
create function public._org_web_only_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or public.has_org_permission(new.id, 'org.manage') then
    return new;
  end if;
  if (to_jsonb(new) - array['storefront_settings', 'email_settings', 'updated_at']) is distinct from
     (to_jsonb(old) - array['storefront_settings', 'email_settings', 'updated_at']) then
    raise exception 'web_only_columns' using errcode = '42501',
      hint = 'Quyền Website chỉ sửa được nội dung trang và email thông báo';
  end if;
  return new;
end $$;
create trigger organizations_web_only before update on public.organizations for each row execute function public._org_web_only_guard();

create policy tours_web_update on public.tours for update to authenticated
  using (public.has_org_permission(organization_id, 'web.manage')) with check (public.has_org_permission(organization_id, 'web.manage'));
create policy tour_options_web_update on public.tour_options for update to authenticated
  using (public.has_org_permission(organization_id, 'web.manage')) with check (public.has_org_permission(organization_id, 'web.manage'));
create policy organizations_web_update on public.organizations for update to authenticated
  using (public.has_org_permission(id, 'web.manage')) with check (public.has_org_permission(id, 'web.manage'));

-- Email: người có web.manage cũng gửi thử và xem nhật ký.
create or replace function public.email_send_test(p_org uuid, p_to text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_to text := lower(btrim(coalesce(p_to, '')));
begin
  if not (public.has_org_permission(p_org, 'org.manage') or public.has_org_permission(p_org, 'web.manage')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_to !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_to) > 200 then
    return jsonb_build_object('ok', false, 'code', 'invalid_email');
  end if;
  insert into public.outbox_events (organization_id, topic, payload) values (p_org, 'email.test', jsonb_build_object('to', v_to));
  return jsonb_build_object('ok', true);
end $$;
drop policy email_log_read on public.email_log;
create policy email_log_read on public.email_log for select to authenticated
  using (public.has_org_permission(organization_id, 'org.manage') or public.has_org_permission(organization_id, 'web.manage'));

revoke all on function public._web_only_guard(), public._org_web_only_guard() from public, anon, authenticated;

-- Ảnh tour: người có web.manage cũng tải lên, đổi, xóa (chỉ khi có dịch vụ lưu file).
do $outer$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;
  execute $p$drop policy if exists tour_images_insert on storage.objects$p$;
  execute $p$drop policy if exists tour_images_update on storage.objects$p$;
  execute $p$drop policy if exists tour_images_delete on storage.objects$p$;
  execute $p$create policy tour_images_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'tour-images' and (public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'catalog.manage')
      or public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'web.manage')))$p$;
  execute $p$create policy tour_images_update on storage.objects for update to authenticated
    using (bucket_id = 'tour-images' and (public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'catalog.manage')
      or public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'web.manage')))$p$;
  execute $p$create policy tour_images_delete on storage.objects for delete to authenticated
    using (bucket_id = 'tour-images' and (public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'catalog.manage')
      or public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'web.manage')))$p$;
end
$outer$;
