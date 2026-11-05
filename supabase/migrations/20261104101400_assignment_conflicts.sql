-- Cảnh báo HDV hoặc xe bị xếp vào hai chuyến chồng giờ. Chỉ cảnh báo, không chặn: người điều hành có thể
-- có lý do riêng, như một xe chạy nối chuyến.

-- Một tour có thể có gói 2 tiếng và 4 tiếng, nên thời lượng theo gói được ưu tiên hơn thời lượng của tour.
alter table public.tour_options
  add column duration_minutes int check (duration_minutes is null or duration_minutes > 0);

-- Mức 'overlap': chắc chắn chồng giờ. Mức 'possible': cùng ngày nhưng thiếu thời lượng nên không kết luận được,
-- phải báo vì coi thiếu dữ liệu là không trùng sẽ cho cảm giác an toàn sai.
-- Không tính thêm thời gian di chuyển giữa hai chuyến.
create function public._assignment_clashes(p_departure uuid)
returns table (kind text, resource_id uuid, resource_name text, level text, departure_id uuid, local_date date, local_time time, tour_name text, option_name text)
language sql stable security definer set search_path = '' as $$
  with me as (
    select d.id, d.organization_id, d.starts_at, d.local_date, coalesce(o.duration_minutes, t.duration_minutes) as dur
    from public.departures d
    join public.tours t on t.id = d.tour_id
    left join public.tour_options o on o.id = d.tour_option_id
    where d.id = p_departure and d.status = 'scheduled'
  ), taken as (
    select 'guide'::text as kind, ga.guide_id as resource_id, g.full_name as resource_name, ga.departure_id
    from public.guide_assignments ga join public.guides g on g.id = ga.guide_id
    where ga.organization_id = (select organization_id from me)
    union all
    select 'vehicle', va.vehicle_id, ve.name, va.departure_id
    from public.vehicle_assignments va join public.vehicles ve on ve.id = va.vehicle_id
    where va.organization_id = (select organization_id from me)
  )
  select x.kind, x.resource_id, x.resource_name,
    case when od.starts_at = me.starts_at
           or (me.dur is not null and od.dur is not null
               and od.starts_at < me.starts_at + make_interval(mins => me.dur)
               and me.starts_at < od.starts_at + make_interval(mins => od.dur))
         then 'overlap' else 'possible' end,
    od.id, od.local_date, od.local_time, od.tour_name, od.option_name
  from me
  join taken x on x.departure_id <> me.id
  join lateral (
    select d.id, d.starts_at, d.local_date, d.local_time, d.status, t.name as tour_name, o.name as option_name,
      coalesce(o.duration_minutes, t.duration_minutes) as dur
    from public.departures d
    join public.tours t on t.id = d.tour_id
    left join public.tour_options o on o.id = d.tour_option_id
    where d.id = x.departure_id
  ) od on od.status = 'scheduled'
  where od.starts_at = me.starts_at
     or (me.dur is not null and od.dur is not null
         and od.starts_at < me.starts_at + make_interval(mins => me.dur)
         and me.starts_at < od.starts_at + make_interval(mins => od.dur))
     or ((me.dur is null or od.dur is null) and od.local_date = me.local_date);
$$;

-- Trả xung đột của mọi HDV và xe so với chuyến này, kể cả người chưa được gán, để màn phân công báo trước khi chọn.
create function public.assignment_conflicts(p_departure uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require(public._departure_org(p_departure), 'ops.read');
  return (
    select coalesce(jsonb_agg(row_to_json(c) order by c.level, c.local_date, c.local_time), '[]'::jsonb)
    from public._assignment_clashes(p_departure) c
  );
end $$;

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
        mix.channels as channel_mix,
        cl.guide_clash, cl.vehicle_clash, cl.possible_clash
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
      -- Chỉ tính HDV và xe đã gán vào chính chuyến này; danh sách đầy đủ để dành cho màn phân công.
      cross join lateral (
        select
          count(*) filter (where c.kind = 'guide' and c.level = 'overlap')::int as guide_clash,
          count(*) filter (where c.kind = 'vehicle' and c.level = 'overlap')::int as vehicle_clash,
          count(*) filter (where c.level = 'possible')::int as possible_clash
        from public._assignment_clashes(d.id) c
        where (c.kind = 'guide' and exists (select 1 from public.guide_assignments ga where ga.departure_id = d.id and ga.guide_id = c.resource_id))
           or (c.kind = 'vehicle' and exists (select 1 from public.vehicle_assignments va where va.departure_id = d.id and va.vehicle_id = c.resource_id))
      ) cl
      where d.organization_id = p_org and d.local_date between p_from and p_to
    ) x
  );
end $$;

revoke all on function public._assignment_clashes(uuid), public.assignment_conflicts(uuid) from public, anon, authenticated;
grant execute on function public.assignment_conflicts(uuid) to authenticated, service_role;
grant execute on function public._assignment_clashes(uuid) to service_role;
