-- Lưu tọa độ điểm đón để vẽ bản đồ và đề xuất thứ tự đón. Một điểm đón có thể gồm nhiều booking cùng khách sạn nên
-- nhận nhiều dòng một lúc. Đồng bộ từ kênh không làm mất tọa độ này: đường đồng bộ chỉ ghi khi nguồn có tọa độ.
create function public.set_pickup_coordinates(p_items uuid[], p_lat numeric, p_lng numeric) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
  v_orgs int;
  v_count int;
begin
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    return jsonb_build_object('ok', false, 'code', 'invalid_coordinates');
  end if;
  select min(organization_id::text)::uuid, count(distinct organization_id) into v_org, v_orgs
  from public.booking_items where id = any (p_items);
  if v_org is null then
    return jsonb_build_object('ok', false, 'code', 'item_not_found');
  end if;
  -- Không cho một lời gọi chạm dòng của doanh nghiệp khác.
  if v_orgs > 1 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  perform public._require(v_org, 'ops.manage');
  insert into public.booking_pickups (booking_item_id, organization_id, latitude, longitude)
  select i.id, i.organization_id, round(p_lat, 6), round(p_lng, 6) from public.booking_items i where i.id = any (p_items)
  on conflict (booking_item_id) do update set latitude = excluded.latitude, longitude = excluded.longitude, updated_at = now();
  get diagnostics v_count = row_count;
  perform public._audit(v_org, 'set_coordinates', 'booking_pickups', array_to_string(p_items, ','), null, jsonb_build_object('lat', p_lat, 'lng', p_lng));
  return jsonb_build_object('ok', true, 'updated', v_count);
end $$;

-- Tọa độ đã biết của các khách sạn trong doanh nghiệp, để không phải tìm lại cùng một khách sạn.
create function public.known_pickup_places(p_org uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require(p_org, 'ops.read');
  return (
    select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select distinct on (lower(p.hotel_name)) p.hotel_name, p.latitude, p.longitude
      from public.booking_pickups p
      where p.organization_id = p_org and p.hotel_name is not null and p.latitude is not null and p.longitude is not null
      order by lower(p.hotel_name), p.updated_at desc
    ) x
  );
end $$;

revoke all on function public.set_pickup_coordinates(uuid[], numeric, numeric), public.known_pickup_places(uuid) from public, anon, authenticated;
grant execute on function public.set_pickup_coordinates(uuid[], numeric, numeric), public.known_pickup_places(uuid) to authenticated, service_role;
