-- Màn "Kết nối API": lưu địa chỉ cổng công khai của từng kết nối và tạo kết nối API (không phải mô phỏng).
-- Không lưu khóa hay mật khẩu: credential_ref vẫn chỉ là TÊN bí mật.

alter table public.channel_connections
  add column endpoint_url text
    check (endpoint_url is null or (endpoint_url ~ '^https://[^[:space:]]+$' and length(endpoint_url) <= 300));
-- Kết nối API khác tài khoản nhập file: tài khoản nhập file cũng có thể ở chế độ Production (dữ liệu thật),
-- nhưng kênh không gọi vào nó và không được báo chỗ thay nó. Cổng và worker chỉ làm việc với is_api.
alter table public.channel_connections add column is_api boolean not null default false;
-- channel_connections cấp quyền đọc theo cột (credential_ref không đọc được), nên cột mới phải cấp riêng.
grant select (endpoint_url, is_api) on public.channel_connections to authenticated;

create or replace function public._gyg_connection(p_connection uuid) returns public.channel_connections
language plpgsql stable security definer set search_path = '' as $$
declare
  v_c public.channel_connections := public._require_channel_caller(p_connection);
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501', detail = 'service_role';
  end if;
  if v_c.channel <> 'getyourguide' or not v_c.is_api then
    raise exception 'forbidden' using errcode = '42501', detail = 'not_getyourguide_api';
  end if;
  return v_c;
end $$;

create or replace function public.worker_gyg_availability(p_departure uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'connection_id', c.id, 'product_id', m.external_product_code,
    'items', (
      select coalesce(jsonb_agg(jsonb_build_object('local_date', x.local_date, 'local_time', x.local_time,
        'starts_at', x.starts_at, 'vacancies', x.vacancies)), '[]'::jsonb)
      from (
        select g.local_date, g.local_time, min(g.starts_at) as starts_at, max(g.available) as vacancies
        from public._gyg_departures(m.tour_option_id, d.starts_at, d.starts_at) g
        group by g.local_date, g.local_time
      ) x
    ))), '[]'::jsonb)
  from public.departures d
  join public.channel_connections c on c.organization_id = d.organization_id
    and c.channel = 'getyourguide' and c.is_api and c.mode <> 'mock' and c.status <> 'disabled'
  join public.channel_product_mappings m on m.connection_id = c.id and m.external_option_code = '' and m.is_verified
  join public.tour_options o on o.id = m.tour_option_id and o.tour_id = d.tour_id
    and (d.tour_option_id is null or d.tour_option_id = o.id)
  where d.id = p_departure
$$;
revoke all on function public._gyg_connection(uuid), public.worker_gyg_availability(uuid) from public, anon, authenticated;

-- Bản mới nhất của connection_update (20261104100700) cộng thêm endpoint_url. Gửi chuỗi rỗng để xóa.
create or replace function public.connection_update(p_connection uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_c public.channel_connections%rowtype;
  v_mode public.connection_mode;
  v_url text;
begin
  select * into v_c from public.channel_connections where id = p_connection;
  perform public._require(v_c.organization_id, 'connection.manage');
  v_mode := coalesce((p_patch ->> 'mode')::public.connection_mode, v_c.mode);
  if v_mode = 'production' and coalesce(p_patch ->> 'approval_status', v_c.approval_status) <> 'approved' then
    return jsonb_build_object('ok', false, 'code', 'production_needs_approval');
  end if;
  v_url := case when p_patch ? 'endpoint_url' then nullif(btrim(p_patch ->> 'endpoint_url'), '') else v_c.endpoint_url end;
  if v_url is not null and (v_url !~ '^https://[^[:space:]]+$' or length(v_url) > 300) then
    return jsonb_build_object('ok', false, 'code', 'invalid_endpoint_url');
  end if;
  update public.channel_connections set
    account_name = coalesce(p_patch ->> 'account_name', account_name),
    supplier_account_ref = case when p_patch ? 'supplier_account_ref'
      then nullif(btrim(p_patch ->> 'supplier_account_ref'), '') else supplier_account_ref end,
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
    catalog_sync_interval_minutes = coalesce((p_patch ->> 'catalog_sync_interval_minutes')::int, catalog_sync_interval_minutes),
    endpoint_url = v_url
  where id = p_connection;
  perform public._audit(v_c.organization_id, 'update', 'channel_connections', p_connection::text, to_jsonb(v_c) - 'credential_ref', p_patch - 'credential_ref');
  return jsonb_build_object('ok', true);
end $$;

-- Kết nối API thật bắt đầu ở Sandbox, "Chưa cấu hình", "Chưa đăng ký". Không có đường nào từ giao diện
-- đặt "Đã kết nối": chỉ cổng thật (service_role) báo được qua connection_mark_health.
create function public.api_connection_create(p_org uuid, p_channel public.channel_kind, p_account text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  perform public._require(p_org, 'connection.manage');
  if p_channel not in ('viator', 'getyourguide') then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  if coalesce(btrim(p_account), '') = '' then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;
  insert into public.channel_connections
    (organization_id, channel, account_name, mode, status, approval_status, capabilities, hold_ttl_seconds, is_api)
  values (p_org, p_channel, btrim(p_account), 'sandbox', 'not_configured', 'not_requested', '{}',
    -- GetYourGuide mong giữ chỗ 60 phút; Viator: 15 phút là mức tối thiểu tài liệu nêu.
    case when p_channel = 'getyourguide' then 3600 else 900 end, true)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    return jsonb_build_object('ok', false, 'code', 'duplicate_connection');
  end if;
  perform public._audit(p_org, 'create', 'channel_connections', v_id::text);
  return jsonb_build_object('ok', true, 'connection_id', v_id);
end $$;

revoke all on function public.connection_update(uuid, jsonb), public.api_connection_create(uuid, public.channel_kind, text)
  from public, anon, authenticated;
grant execute on function public.connection_update(uuid, jsonb), public.api_connection_create(uuid, public.channel_kind, text)
  to authenticated, service_role;
