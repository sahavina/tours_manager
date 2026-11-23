-- Kho ảnh tour: bucket công khai "tour-images", mỗi doanh nghiệp một thư mục <organization_id>/...
-- Ai có quyền catalog.manage của doanh nghiệp đó mới tải lên, đổi, xóa được; ai cũng xem được ảnh (bucket công khai).
-- Chỉ chạy khi có dịch vụ lưu file (schema storage); database dev và database test không có thì bỏ qua.

create or replace function public._uuid_or_null(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;
grant execute on function public._uuid_or_null(text) to authenticated, service_role;

do $outer$
begin
  if to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null then
    raise notice 'Không có schema storage, bỏ qua kho ảnh tour';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('tour-images', 'tour-images', true, 10485760, array['image/webp', 'image/jpeg', 'image/png'])
  on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

  execute $p$drop policy if exists tour_images_read on storage.objects$p$;
  execute $p$drop policy if exists tour_images_insert on storage.objects$p$;
  execute $p$drop policy if exists tour_images_update on storage.objects$p$;
  execute $p$drop policy if exists tour_images_delete on storage.objects$p$;
  execute $p$create policy tour_images_read on storage.objects for select to authenticated
    using (bucket_id = 'tour-images' and public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'catalog.read'))$p$;
  execute $p$create policy tour_images_insert on storage.objects for insert to authenticated
    with check (bucket_id = 'tour-images' and public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'catalog.manage'))$p$;
  execute $p$create policy tour_images_update on storage.objects for update to authenticated
    using (bucket_id = 'tour-images' and public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'catalog.manage'))$p$;
  execute $p$create policy tour_images_delete on storage.objects for delete to authenticated
    using (bucket_id = 'tour-images' and public.has_org_permission(public._uuid_or_null((storage.foldername(name))[1]), 'catalog.manage'))$p$;
end
$outer$;
