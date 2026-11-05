-- Theo dõi chuyến ghép: mỗi chuyến cho biết có bao nhiêu booking, từ kênh nào và có phải tour riêng không.
-- Chỉ tính booking đang giữ chỗ trên chuyến, nên booking đã hủy hoặc đã chuyển đi không làm lệch số.

-- Viết thẳng phép tính thay vì gọi hàm nội bộ, cùng lý do với số chỗ ở dưới. Cột mới chỉ được thêm vào cuối view.
create or replace view public.v_departure_availability with (security_barrier = true) as
select
  d.id, d.organization_id, d.tour_id, d.tour_option_id, d.inventory_pool_id,
  d.local_date, d.local_time, d.timezone, d.starts_at, d.cutoff_at, d.sale_open, d.status, d.note,
  d.outcome, d.supplier_confirmed_at,
  t.code as tour_code, t.name as tour_name, o.name as option_name, o.code as option_code,
  p.name as pool_name, p.capacity, p.blocked_seats,
  c.seats as committed_seats,
  h.seats as held_seats,
  p.capacity - p.blocked_seats - c.seats - h.seats as available_seats,
  (select coalesce(sum(i.committed_seats), 0)::int from public.booking_items i where i.departure_id = d.id) as departure_seats,
  (select count(*)::int from public.guide_assignments g where g.departure_id = d.id) as guide_count,
  (select count(*)::int from public.vehicle_assignments v where v.departure_id = d.id) as vehicle_count,
  -- Chuyến "Mọi gói" có thể chứa booking gói riêng, nên phải xét cả gói của booking.
  coalesce(o.is_private, false) or m.has_private as is_private,
  m.bookings as booking_count,
  mix.channels as channel_mix
from public.departures d
join public.tours t on t.id = d.tour_id
left join public.tour_options o on o.id = d.tour_option_id
join public.inventory_pools p on p.id = d.inventory_pool_id
cross join lateral (
  select coalesce(sum(i.committed_seats), 0)::int as seats
  from public.booking_items i join public.departures d2 on d2.id = i.departure_id
  where d2.inventory_pool_id = p.id and i.committed_seats > 0
) c
cross join lateral (
  select coalesce(sum(x.quantity), 0)::int as seats
  from public.inventory_holds x
  where x.inventory_pool_id = p.id and x.status = 'active' and x.expires_at > now()
) h
cross join lateral (
  select count(distinct i.booking_id)::int as bookings, coalesce(bool_or(op.is_private), false) as has_private
  from public.booking_items i
  left join public.tour_options op on op.id = i.tour_option_id
  where i.departure_id = d.id and i.committed_seats > 0
) m
cross join lateral (
  select coalesce(jsonb_agg(jsonb_build_object('channel', z.channel, 'bookings', z.bookings, 'seats', z.seats) order by z.channel), '[]'::jsonb) as channels
  from (
    select coalesce(cc.channel::text, 'manual') as channel, count(distinct i.booking_id)::int as bookings, sum(i.committed_seats)::int as seats
    from public.booking_items i
    join public.bookings b on b.id = i.booking_id
    left join public.channel_connections cc on cc.id = b.connection_id
    where i.departure_id = d.id and i.committed_seats > 0
    group by 1
  ) z
) mix
where public.has_org_permission(d.organization_id, 'departure.read');

create or replace function public.ops_board(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require(p_org, 'ops.read');
  return (
    select coalesce(jsonb_agg(row_to_json(x) order by x.starts_at), '[]'::jsonb) from (
      select
        d.id, d.starts_at, d.local_date, d.local_time, d.timezone, d.status, d.supplier_confirmed_at,
        t.name as tour_name, o.name as option_name,
        coalesce(s.seats, 0) as seats, coalesce(s.bookings, 0) as bookings,
        coalesce(g.n, 0) as guides, coalesce(v.n, 0) as vehicles, coalesce(v.seats, 0) as vehicle_seats,
        coalesce(s.seats, 0) > 0 and coalesce(g.n, 0) = 0 as missing_guide,
        coalesce(s.seats, 0) > 0 and coalesce(v.n, 0) = 0 as missing_vehicle,
        coalesce(s.seats, 0) > coalesce(v.seats, 0) and coalesce(v.n, 0) > 0 as vehicle_over,
        coalesce(s.missing_pickup, 0) as missing_pickup,
        coalesce(s.changed, 0) as changed_after_assignment,
        coalesce(s.needs_action, 0) as needs_contact,
        coalesce(s.unallocated, 0) as unallocated,
        d.supplier_confirmed_at is null and coalesce(v.n, 0) > 0 as supplier_unconfirmed,
        coalesce(o.is_private, false) or coalesce(s.has_private, false) as is_private,
        mix.channels as channel_mix
      from public.departures d
      join public.tours t on t.id = d.tour_id
      left join public.tour_options o on o.id = d.tour_option_id
      left join lateral (
        select sum(i.committed_seats)::int as seats, count(distinct i.booking_id)::int as bookings,
          count(*) filter (where op.has_transfer and coalesce(pk.hotel_name, pk.address, '') = '')::int as missing_pickup,
          count(distinct b.id) filter (where b.changed_after_assignment)::int as changed,
          count(distinct b.id) filter (where b.needs_action)::int as needs_action,
          count(*) filter (where not exists (select 1 from public.passenger_allocations a where a.booking_item_id = i.id and a.is_active))::int as unallocated,
          bool_or(op.is_private) as has_private
        from public.booking_items i
        join public.bookings b on b.id = i.booking_id
        left join public.tour_options op on op.id = i.tour_option_id
        left join public.booking_pickups pk on pk.booking_item_id = i.id
        where i.departure_id = d.id and i.committed_seats > 0
      ) s on true
      left join lateral (select count(*)::int as n from public.guide_assignments ga where ga.departure_id = d.id) g on true
      left join lateral (
        select count(*)::int as n, sum(ve.seats)::int as seats
        from public.vehicle_assignments va join public.vehicles ve on ve.id = va.vehicle_id
        where va.departure_id = d.id
      ) v on true
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object('channel', z.channel, 'bookings', z.bookings, 'seats', z.seats) order by z.channel), '[]'::jsonb) as channels
        from (
          select coalesce(cc.channel::text, 'manual') as channel, count(distinct i.booking_id)::int as bookings, sum(i.committed_seats)::int as seats
          from public.booking_items i
          join public.bookings b on b.id = i.booking_id
          left join public.channel_connections cc on cc.id = b.connection_id
          where i.departure_id = d.id and i.committed_seats > 0
          group by 1
        ) z
      ) mix
      where d.organization_id = p_org and d.local_date between p_from and p_to
    ) x
  );
end $$;

-- Thêm nguồn bán cho điều hành đối chiếu voucher. Không thêm vào _manifest_rows vì hàm đó cũng phục vụ
-- guide_manifest, và hướng dẫn viên không cần biết booking đến từ tài khoản kênh nào.
create or replace function public.departure_manifest(p_departure uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := public._departure_org(p_departure);
begin
  if not (public.has_org_permission(v_org, 'ops.read') or public.has_org_permission(v_org, 'departure.read')) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return (
    select coalesce(jsonb_agg(r.value || jsonb_build_object('channel', cc.channel, 'account_name', cc.account_name, 'external_ref', b.external_ref) order by r.ordinality), '[]'::jsonb)
    from jsonb_array_elements(public._manifest_rows(p_departure)) with ordinality r
    join public.bookings b on b.id = (r.value ->> 'booking_id')::uuid
    left join public.channel_connections cc on cc.id = b.connection_id
  );
end $$;
