-- Sản phẩm đã gỡ khỏi kênh vẫn giữ ảnh chụp lịch làm lịch sử, nhưng lịch đó đã cũ: không được dùng để tạo chuyến.
-- Giữ lại thay vì xóa để còn đối chiếu được khi cần, và vì sản phẩm có thể xuất hiện lại trên kênh.
create or replace function public.channel_availability_create_departures(p_product uuid, p_from date, p_to date, p_capacity int) returns jsonb
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
  if v_p.removed_at is not null then
    return jsonb_build_object('ok', false, 'code', 'product_removed');
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
