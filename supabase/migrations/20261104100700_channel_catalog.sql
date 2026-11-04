-- Đồng bộ danh mục sản phẩm và ảnh chụp lịch từ kênh.
--
-- Nguyên tắc:
--   * Dữ liệu kênh nằm ở bảng riêng. Đường đồng bộ KHÔNG có câu lệnh nào ghi vào tours, tour_options,
--     departures hay inventory_pools. Chỉ khi có người bấm mới thành dữ liệu nội bộ.
--   * Khi nội dung kênh đổi: giữ bản nội bộ, gắn cờ `has_changes`, người có quyền duyệt từng trường.
--   * Số chỗ từ kênh chỉ để đối chiếu. Nguồn số chỗ của hệ thống vẫn là inventory_pools.
--   * Không giả định trường nào ngoài mã sản phẩm có mặt: `post/v2/mappings/catalog` của Viator (Beta) chỉ
--     nêu productCode, productName, productStatus, mappings. Xem docs/CHANNEL_INTEGRATION.md.

alter table public.channel_connections
  add column catalog_sync_enabled boolean not null default false,
  add column catalog_sync_interval_minutes int not null default 360 check (catalog_sync_interval_minutes >= 5),
  add column catalog_last_attempt_at timestamptz,
  add column catalog_last_synced_at timestamptz,
  add column catalog_last_error text,
  -- Chỉ bộ mô phỏng dùng, để biết đang giả lập phiên bản danh mục nào.
  add column mock_catalog_version int not null default 1;

create table public.channel_products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  external_product_code text not null,
  external_option_code text not null default '',
  title text,
  product_status text,
  -- Bản mới nhất từ kênh, và bản người dùng đã chấp nhận lần cuối. Khác nhau nghĩa là có thay đổi cần duyệt.
  latest jsonb not null,
  baseline jsonb,
  content_hash text not null,
  tour_option_id uuid,
  is_ignored boolean not null default false,
  has_changes boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_changed_at timestamptz,
  removed_at timestamptz,
  unique (organization_id, id),
  unique (organization_id, connection_id, external_product_code, external_option_code),
  foreign key (organization_id, connection_id) references public.channel_connections (organization_id, id),
  foreign key (organization_id, tour_option_id) references public.tour_options (organization_id, id)
);
create index channel_products_org_idx on public.channel_products (organization_id, connection_id);

create table public.channel_availability_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  channel_product_id uuid not null,
  local_date date not null,
  local_time time not null default '00:00',
  vacancies int check (vacancies is null or vacancies >= 0),
  status text not null default 'available' check (status in ('available', 'sold_out', 'closed')),
  fetched_at timestamptz not null default now(),
  unique (channel_product_id, local_date, local_time),
  foreign key (organization_id, channel_product_id) references public.channel_products (organization_id, id) on delete cascade
);
create index channel_availability_date_idx on public.channel_availability_snapshots (channel_product_id, local_date);

alter table public.channel_products enable row level security;
alter table public.channel_availability_snapshots enable row level security;
grant select on public.channel_products, public.channel_availability_snapshots to authenticated;
grant all on public.channel_products, public.channel_availability_snapshots to service_role;
create policy channel_products_read on public.channel_products for select to authenticated
  using (public.has_org_permission(organization_id, 'connection.read'));
create policy channel_availability_read on public.channel_availability_snapshots for select to authenticated
  using (public.has_org_permission(organization_id, 'connection.read'));

-- Cấp theo cột vì channel_connections không cho đọc credential_ref.
grant select (catalog_sync_enabled, catalog_sync_interval_minutes, catalog_last_attempt_at, catalog_last_synced_at,
  catalog_last_error, mock_catalog_version) on public.channel_connections to authenticated;

-- Kết nối mô phỏng đã có: khai thêm hai khả năng của bộ mô phỏng.
update public.channel_connections
set capabilities = capabilities || '{"catalog_pull": "supported", "availability_pull": "supported"}'::jsonb
where mode = 'mock' and channel <> 'manual';

-- p_products: [{product_code, option_code, title, status, description, destination, duration_minutes,
--               timezone, language, start_times, traveler_categories}]
-- p_complete: danh sách là TOÀN BỘ danh mục, nên mã vắng mặt được đánh dấu đã gỡ. Trang một phần thì để false.
create function public.channel_catalog_ingest(p_connection uuid, p_products jsonb, p_complete boolean default false)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
  p jsonb;
  v_latest jsonb;
  v_hash text;
  v_old public.channel_products%rowtype;
  v_created int := 0;
  v_changed int := 0;
  v_unchanged int := 0;
  v_invalid int := 0;
  v_removed int := 0;
  v_seen uuid[] := '{}';
  v_id uuid;
begin
  for p in select * from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) loop
    if coalesce(p ->> 'product_code', '') = '' then
      v_invalid := v_invalid + 1;
      continue;
    end if;
    v_latest := public._sanitize_payload(p);
    -- jsonb đã chuẩn hóa thứ tự khóa, nên cùng nội dung ra cùng hash.
    v_hash := encode(sha256(convert_to(v_latest::text, 'UTF8')), 'hex');

    select * into v_old from public.channel_products
    where organization_id = v_c.organization_id and connection_id = v_c.id
      and external_product_code = p ->> 'product_code'
      and external_option_code = coalesce(p ->> 'option_code', '')
    for update;

    if not found then
      insert into public.channel_products
        (organization_id, connection_id, external_product_code, external_option_code, title, product_status, latest, content_hash)
      values (v_c.organization_id, v_c.id, p ->> 'product_code', coalesce(p ->> 'option_code', ''), p ->> 'title', p ->> 'status', v_latest, v_hash)
      returning id into v_id;
      v_created := v_created + 1;
    elsif v_old.content_hash = v_hash then
      update public.channel_products set last_seen_at = now(), removed_at = null where id = v_old.id;
      v_id := v_old.id;
      v_unchanged := v_unchanged + 1;
    else
      update public.channel_products set
        title = p ->> 'title', product_status = p ->> 'status', latest = v_latest, content_hash = v_hash,
        last_seen_at = now(), last_changed_at = now(), removed_at = null,
        -- Chỉ sản phẩm đã ghép mới có gì để duyệt.
        has_changes = tour_option_id is not null
      where id = v_old.id;
      v_id := v_old.id;
      v_changed := v_changed + 1;
    end if;
    v_seen := v_seen || v_id;
  end loop;

  if p_complete then
    update public.channel_products set removed_at = now()
    where organization_id = v_c.organization_id and connection_id = v_c.id
      and removed_at is null and not (id = any (v_seen));
    get diagnostics v_removed = row_count;
  end if;

  update public.channel_connections set
    catalog_last_attempt_at = now(), catalog_last_synced_at = now(), catalog_last_error = null
  where id = v_c.id;
  perform public._touch_connection(v_c);

  insert into public.sync_jobs (organization_id, connection_id, kind, status, detail, finished_at)
  values (v_c.organization_id, v_c.id, 'catalog_sync', 'done', jsonb_build_object(
    'outcome', case when v_c.mode = 'mock' then 'simulated' else 'synced' end,
    'created', v_created, 'changed', v_changed, 'unchanged', v_unchanged, 'removed', v_removed, 'invalid', v_invalid), now());

  if v_created + v_changed + v_removed > 0 then
    insert into public.notifications (organization_id, required_permission, kind, title, body, link)
    values (v_c.organization_id, 'connection.read', 'catalog_changed',
      'Danh mục kênh có thay đổi: ' || v_c.account_name,
      format('%s mới, %s đổi nội dung, %s đã gỡ', v_created, v_changed, v_removed), '/connections?tab=catalog');
  end if;

  return jsonb_build_object('ok', true, 'created', v_created, 'changed', v_changed, 'unchanged', v_unchanged,
    'removed', v_removed, 'invalid', v_invalid);
end $$;

-- Ghép sản phẩm kênh với gói nội bộ. Đi qua mapping_save để các booking đang chờ của mã này được xếp chuyến.
create function public._catalog_link(p_product public.channel_products, p_option uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_res jsonb;
begin
  v_res := public.mapping_save(null, p_product.organization_id, p_product.connection_id, p_product.external_product_code,
    p_product.external_option_code, p_option, p_product.latest ->> 'language',
    (p_product.latest -> 'start_times' ->> 0)::time, null, true);
  if not (v_res ->> 'ok')::boolean then
    return v_res;
  end if;
  update public.channel_products set
    tour_option_id = p_option, baseline = latest, has_changes = false, is_ignored = false
  where id = p_product.id;
  return v_res;
end $$;

create function public.channel_catalog_link(p_product uuid, p_option uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.channel_products%rowtype;
begin
  select * into v_p from public.channel_products where id = p_product for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._require(v_p.organization_id, 'connection.manage');
  if not exists (select 1 from public.tour_options where id = p_option and organization_id = v_p.organization_id and deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'option_not_found');
  end if;
  return public._catalog_link(v_p, p_option);
end $$;

-- Tạo tour và gói từ sản phẩm kênh, hoặc thêm gói vào tour có sẵn khi p_tour khác null.
create function public.channel_catalog_create_internal(p_product uuid, p_tour uuid, p_tour_code text, p_option_code text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.channel_products%rowtype;
  v_org uuid;
  v_tour uuid := p_tour;
  v_option uuid;
  v_tz text;
  v_res jsonb;
begin
  select * into v_p from public.channel_products where id = p_product for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  v_org := v_p.organization_id;
  perform public._require(v_org, 'connection.manage');
  perform public._require(v_org, 'catalog.manage');
  if v_p.tour_option_id is not null then
    return jsonb_build_object('ok', false, 'code', 'already_linked');
  end if;
  if coalesce(trim(p_option_code), '') = '' or (v_tour is null and coalesce(trim(p_tour_code), '') = '') then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  -- Kiểm tra cả hai mã TRƯỚC khi ghi: trả ok=false không rollback, nên kiểm tra sau sẽ để lại tour mồ côi.
  if exists (select 1 from public.tour_options where organization_id = v_org and code = p_option_code) then
    return jsonb_build_object('ok', false, 'code', 'duplicate_code');
  end if;

  if v_tour is null then
    if exists (select 1 from public.tours where organization_id = v_org and code = p_tour_code) then
      return jsonb_build_object('ok', false, 'code', 'duplicate_code');
    end if;
    -- Kênh có thể không gửi múi giờ: dùng múi giờ doanh nghiệp, không đoán.
    select coalesce(v_p.latest ->> 'timezone', o.default_timezone) into v_tz from public.organizations o where o.id = v_org;
    insert into public.tours (organization_id, code, name, description, destination, duration_minutes, default_timezone)
    values (v_org, p_tour_code, coalesce(v_p.title, p_tour_code), v_p.latest ->> 'description', v_p.latest ->> 'destination',
      (v_p.latest ->> 'duration_minutes')::int, v_tz)
    returning id into v_tour;
  elsif not exists (select 1 from public.tours where id = v_tour and organization_id = v_org and deleted_at is null) then
    return jsonb_build_object('ok', false, 'code', 'tour_not_found');
  end if;

  insert into public.tour_options (organization_id, tour_id, code, name, language)
  values (v_org, v_tour, p_option_code, coalesce(v_p.title, p_option_code), coalesce(v_p.latest ->> 'language', 'en'))
  returning id into v_option;

  v_res := public._catalog_link(v_p, v_option);
  return v_res || jsonb_build_object('tour_id', v_tour, 'tour_option_id', v_option);
end $$;

create function public.channel_catalog_ignore(p_product uuid, p_ignored boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from public.channel_products where id = p_product;
  perform public._require(v_org, 'connection.manage');
  update public.channel_products set is_ignored = p_ignored where id = p_product;
  return jsonb_build_object('ok', true);
end $$;

-- Duyệt thay đổi. p_fields là các trường NGƯỜI DÙNG chọn áp dụng; mảng rỗng là giữ nguyên bản nội bộ.
-- Trường kênh không gửi thì không xóa dữ liệu nội bộ.
create function public.channel_catalog_review(p_product uuid, p_fields text[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.channel_products%rowtype;
  v_tour uuid;
begin
  select * into v_p from public.channel_products where id = p_product for update;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._require(v_p.organization_id, 'catalog.manage');
  if v_p.tour_option_id is null then
    return jsonb_build_object('ok', false, 'code', 'product_not_linked');
  end if;
  select tour_id into v_tour from public.tour_options where id = v_p.tour_option_id;

  update public.tours t set
    name = case when 'title' = any (p_fields) then coalesce(v_p.latest ->> 'title', t.name) else t.name end,
    description = case when 'description' = any (p_fields) then coalesce(v_p.latest ->> 'description', t.description) else t.description end,
    destination = case when 'destination' = any (p_fields) then coalesce(v_p.latest ->> 'destination', t.destination) else t.destination end,
    duration_minutes = case when 'duration_minutes' = any (p_fields) then coalesce((v_p.latest ->> 'duration_minutes')::int, t.duration_minutes) else t.duration_minutes end
  where t.id = v_tour;
  update public.tour_options o set
    language = case when 'language' = any (p_fields) then coalesce(v_p.latest ->> 'language', o.language) else o.language end
  where o.id = v_p.tour_option_id;

  update public.channel_products set baseline = latest, has_changes = false where id = p_product;
  perform public._audit(v_p.organization_id, 'catalog_review', 'channel_products', p_product::text, v_p.baseline,
    jsonb_build_object('applied', to_jsonb(coalesce(p_fields, '{}')), 'latest', v_p.latest));
  return jsonb_build_object('ok', true, 'applied', coalesce(cardinality(p_fields), 0));
end $$;

-- p_items: [{product_code, option_code, local_date, local_time, vacancies, status}]
create function public.channel_availability_ingest(p_connection uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
  i jsonb;
  v_product uuid;
  v_saved int := 0;
  v_skipped int := 0;
begin
  for i in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    select id into v_product from public.channel_products
    where organization_id = v_c.organization_id and connection_id = v_c.id
      and external_product_code = i ->> 'product_code' and external_option_code = coalesce(i ->> 'option_code', '');
    if v_product is null or coalesce(i ->> 'local_date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.channel_availability_snapshots
      (organization_id, channel_product_id, local_date, local_time, vacancies, status)
    values (v_c.organization_id, v_product, (i ->> 'local_date')::date, coalesce((i ->> 'local_time')::time, '00:00'),
      (i ->> 'vacancies')::int, coalesce(i ->> 'status', 'available'))
    on conflict (channel_product_id, local_date, local_time) do update
      set vacancies = excluded.vacancies, status = excluded.status, fetched_at = now();
    v_saved := v_saved + 1;
  end loop;
  return jsonb_build_object('ok', true, 'saved', v_saved, 'skipped', v_skipped);
end $$;

-- Đối chiếu số chỗ kênh với số chỗ nội bộ. Chỉ đọc.
create function public.channel_availability_compare(p_product uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_p public.channel_products%rowtype;
  v_tour uuid;
begin
  select * into v_p from public.channel_products where id = p_product;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._require(v_p.organization_id, 'connection.read');
  perform public._require(v_p.organization_id, 'departure.read');
  select tour_id into v_tour from public.tour_options where id = v_p.tour_option_id;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'local_date', s.local_date, 'local_time', s.local_time, 'status', s.status, 'vacancies', s.vacancies, 'fetched_at', s.fetched_at,
      'departure_id', d.id,
      'internal_available', case when d.id is null then null else
        pool.capacity - pool.blocked_seats - public._pool_committed(pool.id) - public._pool_held(pool.id) end
    ) order by s.local_date, s.local_time), '[]'::jsonb)
    from public.channel_availability_snapshots s
    left join lateral (
      select dd.* from public.departures dd
      where dd.tour_id = v_tour and dd.local_date = s.local_date and dd.local_time = s.local_time
        and dd.status = 'scheduled' and (dd.tour_option_id = v_p.tour_option_id or dd.tour_option_id is null)
      order by (dd.tour_option_id is null) limit 1
    ) d on true
    left join public.inventory_pools pool on pool.id = d.inventory_pool_id
    where s.channel_product_id = p_product and s.local_date between p_from and p_to
  );
end $$;

-- Tạo chuyến còn thiếu theo lịch kênh. Sức chứa do người dùng nhập: số chỗ trống của kênh KHÔNG phải sức chứa.
-- Không đụng tới chuyến đã có.
create function public.channel_availability_create_departures(p_product uuid, p_from date, p_to date, p_capacity int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.channel_products%rowtype;
  v_tour uuid;
  v_tz text;
  r record;
  v_res jsonb;
  v_created int := 0;
  v_skipped int := 0;
begin
  select * into v_p from public.channel_products where id = p_product;
  if not found then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._require(v_p.organization_id, 'departure.manage');
  if v_p.tour_option_id is null then
    return jsonb_build_object('ok', false, 'code', 'product_not_linked');
  end if;
  if p_capacity is null or p_capacity < 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_capacity');
  end if;
  select o.tour_id, t.default_timezone into v_tour, v_tz
  from public.tour_options o join public.tours t on t.id = o.tour_id where o.id = v_p.tour_option_id;

  for r in
    select s.local_date, s.local_time from public.channel_availability_snapshots s
    where s.channel_product_id = p_product and s.local_date between p_from and p_to and s.status <> 'closed'
    order by 1, 2
  loop
    v_res := public.create_departure(v_p.organization_id, v_tour, v_p.tour_option_id, r.local_date, r.local_time,
      coalesce(v_p.latest ->> 'timezone', v_tz), p_capacity, null);
    if (v_res ->> 'ok')::boolean then v_created := v_created + 1; else v_skipped := v_skipped + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'created', v_created, 'skipped', v_skipped);
end $$;

-- Bộ mô phỏng: giả lập việc kênh đổi danh mục. Chỉ kết nối mock.
create function public.channel_mock_bump_catalog(p_connection uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
begin
  if v_c.mode <> 'mock' then
    return jsonb_build_object('ok', false, 'code', 'not_mock');
  end if;
  update public.channel_connections set mock_catalog_version = mock_catalog_version + 1 where id = v_c.id;
  return jsonb_build_object('ok', true, 'version', v_c.mock_catalog_version + 1);
end $$;

-- Kết nối đến hạn đồng bộ. Tính theo lần THỬ, để kết nối lỗi không bị gọi lại liên tục.
create function public.worker_catalog_due() returns table (id uuid, channel public.channel_kind, mode public.connection_mode, mock_catalog_version int)
language sql security definer set search_path = '' as $$
  select c.id, c.channel, c.mode, c.mock_catalog_version
  from public.channel_connections c
  where c.catalog_sync_enabled and c.status <> 'disabled'
    and (c.catalog_last_attempt_at is null
      or c.catalog_last_attempt_at < now() - make_interval(mins => c.catalog_sync_interval_minutes));
$$;

-- Ghi nhận lượt không lấy được dữ liệu. Không chạm catalog_last_synced_at: giao diện không được báo đã đồng bộ.
create function public.worker_catalog_failed(p_connection uuid, p_outcome text, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  update public.channel_connections set catalog_last_attempt_at = now(), catalog_last_error = p_error
  where id = p_connection returning organization_id into v_org;
  insert into public.sync_jobs (organization_id, connection_id, kind, status, detail, last_error, finished_at)
  values (v_org, p_connection, 'catalog_sync', 'failed', jsonb_build_object('outcome', p_outcome), p_error, now());
end $$;

-- Bản mới của connection_update: thêm hai trường cấu hình đồng bộ. Vẫn không có đường nào đặt trạng thái kết nối.
create or replace function public.connection_update(p_connection uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections%rowtype;
  v_mode public.connection_mode;
begin
  select * into v_c from public.channel_connections where id = p_connection;
  perform public._require(v_c.organization_id, 'connection.manage');
  v_mode := coalesce((p_patch ->> 'mode')::public.connection_mode, v_c.mode);
  if v_mode = 'production' and coalesce(p_patch ->> 'approval_status', v_c.approval_status) <> 'approved' then
    return jsonb_build_object('ok', false, 'code', 'production_needs_approval');
  end if;
  update public.channel_connections set
    account_name = coalesce(p_patch ->> 'account_name', account_name),
    supplier_account_ref = coalesce(p_patch ->> 'supplier_account_ref', supplier_account_ref),
    mode = v_mode,
    status = case
      when v_mode = v_c.mode then status
      when v_mode = 'mock' then 'simulated'::public.connection_status
      else 'not_configured'::public.connection_status
    end,
    last_success_at = case when v_mode = 'mock' then null else last_success_at end,
    approval_status = coalesce(p_patch ->> 'approval_status', approval_status),
    hold_ttl_seconds = coalesce((p_patch ->> 'hold_ttl_seconds')::int, hold_ttl_seconds),
    credential_ref = coalesce(p_patch ->> 'credential_ref', credential_ref),
    stale_after_minutes = coalesce((p_patch ->> 'stale_after_minutes')::int, stale_after_minutes),
    catalog_sync_enabled = coalesce((p_patch ->> 'catalog_sync_enabled')::boolean, catalog_sync_enabled),
    catalog_sync_interval_minutes = coalesce((p_patch ->> 'catalog_sync_interval_minutes')::int, catalog_sync_interval_minutes)
  where id = p_connection;
  perform public._audit(v_c.organization_id, 'update', 'channel_connections', p_connection::text, to_jsonb(v_c) - 'credential_ref', p_patch - 'credential_ref');
  return jsonb_build_object('ok', true);
end $$;

-- Migration sau rls_grants phải tự thu quyền mặc định và cấp lại.
revoke all on function public.channel_catalog_ingest(uuid, jsonb, boolean), public._catalog_link(public.channel_products, uuid),
  public.channel_catalog_link(uuid, uuid), public.channel_catalog_create_internal(uuid, uuid, text, text),
  public.channel_catalog_ignore(uuid, boolean), public.channel_catalog_review(uuid, text[]),
  public.channel_availability_ingest(uuid, jsonb), public.channel_availability_compare(uuid, date, date),
  public.channel_availability_create_departures(uuid, date, date, int), public.channel_mock_bump_catalog(uuid),
  public.worker_catalog_due(), public.worker_catalog_failed(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.channel_catalog_ingest(uuid, jsonb, boolean), public.channel_catalog_link(uuid, uuid),
  public.channel_catalog_create_internal(uuid, uuid, text, text), public.channel_catalog_ignore(uuid, boolean),
  public.channel_catalog_review(uuid, text[]), public.channel_availability_ingest(uuid, jsonb),
  public.channel_availability_compare(uuid, date, date), public.channel_availability_create_departures(uuid, date, date, int),
  public.channel_mock_bump_catalog(uuid)
  to authenticated;
grant execute on function public.channel_catalog_ingest(uuid, jsonb, boolean), public._catalog_link(public.channel_products, uuid),
  public.channel_catalog_link(uuid, uuid), public.channel_catalog_create_internal(uuid, uuid, text, text),
  public.channel_catalog_ignore(uuid, boolean), public.channel_catalog_review(uuid, text[]),
  public.channel_availability_ingest(uuid, jsonb), public.channel_availability_compare(uuid, date, date),
  public.channel_availability_create_departures(uuid, date, date, int), public.channel_mock_bump_catalog(uuid),
  public.worker_catalog_due(), public.worker_catalog_failed(uuid, text, text)
  to service_role;
