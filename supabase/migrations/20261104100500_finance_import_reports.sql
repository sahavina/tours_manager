-- Nhập file, đối soát, báo cáo.

-- Phân loại phía server; client chỉ gửi dữ liệu đã chuẩn hóa. Cùng file nhập lại cho ra toàn `duplicate`.
-- p_rows: [{row_no, raw, normalized, errors[]}]
create function public.import_preview(
  p_org uuid, p_connection uuid, p_filename text, p_file_hash text, p_file_size int,
  p_column_map jsonb, p_rows jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_job uuid;
  r jsonb;
  v_norm jsonb;
  v_errors text[];
  v_hash text;
  v_ref text;
  v_b public.bookings%rowtype;
  v_class public.import_classification;
  v_seen text[] := '{}';
begin
  perform public._require(p_org, 'import.manage');
  if not exists (select 1 from public.channel_connections where id = p_connection and organization_id = p_org) then
    return jsonb_build_object('ok', false, 'code', 'connection_not_found');
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    return jsonb_build_object('ok', false, 'code', 'too_many_rows');
  end if;

  insert into public.import_jobs (organization_id, connection_id, filename, file_hash, file_size, column_map, created_by)
  values (p_org, p_connection, p_filename, p_file_hash, p_file_size, coalesce(p_column_map, '{}'), (select auth.uid()))
  returning id into v_job;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_norm := r -> 'normalized';
    v_errors := array(select jsonb_array_elements_text(coalesce(r -> 'errors', '[]'::jsonb)));
    if v_norm is not null and jsonb_typeof(v_norm) = 'object' then
      v_errors := v_errors || public._validate_booking_data(v_norm);
    elsif cardinality(v_errors) = 0 then
      v_errors := array['Dòng trống'];
    end if;

    v_hash := null;
    if cardinality(v_errors) > 0 then
      v_class := 'error';
    else
      v_ref := v_norm ->> 'external_ref';
      v_hash := encode(sha256(convert_to(v_norm::text, 'UTF8')), 'hex');
      select * into v_b from public.bookings
      where organization_id = p_org and connection_id = p_connection and external_ref = v_ref;

      if v_ref = any (v_seen) then
        v_class := 'duplicate';
        v_errors := v_errors || 'Trùng mã booking trong cùng file'::text;
      elsif found and v_b.import_hash = v_hash then
        v_class := 'duplicate';
      elsif found and v_b.last_source_at is not null then
        -- Booking đã đồng bộ trực tiếp từ kênh: file không được ghi đè dữ liệu mới hơn.
        v_class := 'duplicate';
        v_errors := v_errors || 'Booking đang đồng bộ từ kênh, bỏ qua dòng này'::text;
      elsif found then
        v_class := 'update';
      else
        v_class := 'create';
      end if;
      v_seen := v_seen || v_ref;
    end if;

    insert into public.import_rows (organization_id, job_id, row_no, raw, normalized, row_hash, classification, errors)
    values (p_org, v_job, (r ->> 'row_no')::int, coalesce(r -> 'raw', '{}'), v_norm, v_hash, v_class, v_errors);
  end loop;

  update public.import_jobs j set counts = (
    select jsonb_object_agg(c, n) from (
      select classification::text as c, count(*) as n from public.import_rows where job_id = v_job group by 1
    ) s
  ) where j.id = v_job;

  return jsonb_build_object('ok', true, 'job_id', v_job,
    'counts', (select counts from public.import_jobs where id = v_job));
end $$;

-- Xác nhận nhập. Chạy lại job đã commit trả kết quả cũ.
create function public.import_commit(p_job uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_j public.import_jobs%rowtype;
  v_c public.channel_connections%rowtype;
  r public.import_rows%rowtype;
  v_res jsonb;
  v_created int := 0;
  v_updated int := 0;
  v_queued int := 0;
begin
  select * into v_j from public.import_jobs where id = p_job for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'job_not_found');
  end if;
  perform public._require(v_j.organization_id, 'import.manage');
  if v_j.status = 'committed' then
    return jsonb_build_object('ok', true, 'code', 'already_committed', 'counts', v_j.counts);
  end if;
  select * into v_c from public.channel_connections where id = v_j.connection_id;

  for r in select * from public.import_rows where job_id = p_job and classification in ('create', 'update') order by row_no loop
    v_res := public._apply_booking_data(v_c, r.normalized || jsonb_build_object('_import_hash', r.row_hash), 'import');
    update public.import_rows set booking_id = (v_res ->> 'booking_id')::uuid where id = r.id;
    if (v_res ->> 'created')::boolean then v_created := v_created + 1; else v_updated := v_updated + 1; end if;
    if (v_res ->> 'queued')::boolean then v_queued := v_queued + 1; end if;
  end loop;

  update public.import_jobs set status = 'committed', committed_at = now(),
    counts = counts || jsonb_build_object('created', v_created, 'updated', v_updated, 'queued', v_queued)
  where id = p_job;
  perform public._audit(v_j.organization_id, 'import_commit', 'import_jobs', p_job::text, null,
    jsonb_build_object('created', v_created, 'updated', v_updated, 'filename', v_j.filename));
  return jsonb_build_object('ok', true, 'created', v_created, 'updated', v_updated, 'queued', v_queued);
end $$;

-- ---------------------------- Đối soát ----------------------------

create function public._match_settlement_line(p_line uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_l public.settlement_lines%rowtype;
  v_b public.bookings%rowtype;
  v_f public.booking_financials%rowtype;
  v_conn uuid;
begin
  select * into v_l from public.settlement_lines where id = p_line;
  select connection_id into v_conn from public.settlement_batches where id = v_l.batch_id;
  select * into v_b from public.bookings
  where organization_id = v_l.organization_id and connection_id = v_conn and external_ref = v_l.external_ref;
  if not found then
    update public.settlement_lines set match_status = 'unmatched', booking_id = null, difference = null,
      note = 'Không tìm thấy booking' where id = p_line;
    return;
  end if;
  select * into v_f from public.booking_financials where booking_id = v_b.id;
  if coalesce(v_f.currency, v_b.currency) is distinct from v_l.currency then
    update public.settlement_lines set match_status = 'mismatch', booking_id = v_b.id, difference = null,
      note = format('Khác tiền tệ: booking %s, bảng thanh toán %s', coalesce(v_f.currency, v_b.currency), v_l.currency)
    where id = p_line;
  elsif v_f.expected_payout is null then
    -- Không có số dự kiến thì không thể nói là lệch hay khớp số tiền, chỉ khớp được mã.
    update public.settlement_lines set match_status = 'matched', booking_id = v_b.id, difference = null,
      note = 'Khớp mã, chưa có số dự kiến để so' where id = p_line;
  elsif abs(v_l.net_amount - v_f.expected_payout) < 0.005 then
    update public.settlement_lines set match_status = 'matched', booking_id = v_b.id, difference = 0, note = null where id = p_line;
  else
    update public.settlement_lines set match_status = 'mismatch', booking_id = v_b.id,
      difference = v_l.net_amount - v_f.expected_payout, note = 'Lệch so với số dự kiến' where id = p_line;
  end if;
end $$;

-- p_rows: [{row_no, external_ref, currency, gross, fee, net, raw}]
create function public.settlement_preview(
  p_org uuid, p_connection uuid, p_filename text, p_file_hash text, p_column_map jsonb, p_rows jsonb
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_batch uuid;
  r jsonb;
  v_line uuid;
  v_hash text;
  v_status text;
  v_net numeric;
begin
  perform public._require(p_org, 'finance.manage');
  if not exists (select 1 from public.channel_connections where id = p_connection and organization_id = p_org) then
    return jsonb_build_object('ok', false, 'code', 'connection_not_found');
  end if;

  select id into v_batch from public.settlement_batches
  where organization_id = p_org and connection_id = p_connection and file_hash = p_file_hash;
  if v_batch is not null then
    return jsonb_build_object('ok', true, 'code', 'already_imported', 'batch_id', v_batch);
  end if;

  insert into public.settlement_batches (organization_id, connection_id, filename, file_hash, column_map, created_by)
  values (p_org, p_connection, p_filename, p_file_hash, coalesce(p_column_map, '{}'), (select auth.uid()))
  returning id into v_batch;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_net := case when (r ->> 'net') ~ '^-?[0-9]+(\.[0-9]+)?$' then (r ->> 'net')::numeric end;
    -- Khóa trùng chỉ gồm mã booking, tiền tệ, số thực nhận đã chuẩn hóa. Không đưa giá trị bán và phí vào:
    -- hai kênh xuất cùng khoản tiền, một bản có cột phí một bản không, sẽ không bị coi là trùng và số thực
    -- nhận bị cộng đôi khi xác nhận. Hai khoản bằng nhau thật sự thì gán tay kèm lý do.
    v_hash := encode(sha256(convert_to(concat_ws('|', p_connection, r ->> 'external_ref', r ->> 'currency',
      coalesce(trim_scale(v_net)::text, r ->> 'net')), 'UTF8')), 'hex');

    v_status := 'unmatched';
    if coalesce(r ->> 'external_ref', '') = '' or v_net is null or coalesce(r ->> 'currency', '') !~ '^[A-Z]{3}$' then
      v_status := 'invalid';
    elsif exists (select 1 from public.settlement_lines l where l.organization_id = p_org and l.line_hash = v_hash) then
      v_status := 'duplicate';
    end if;

    insert into public.settlement_lines
      (organization_id, batch_id, row_no, external_ref, currency, gross_amount, fee_amount, net_amount, line_hash, match_status, raw, note)
    values (p_org, v_batch, (r ->> 'row_no')::int, r ->> 'external_ref',
      case when coalesce(r ->> 'currency', '') ~ '^[A-Z]{3}$' then r ->> 'currency' end,
      case when (r ->> 'gross') ~ '^-?[0-9]+(\.[0-9]+)?$' then (r ->> 'gross')::numeric end,
      case when (r ->> 'fee') ~ '^-?[0-9]+(\.[0-9]+)?$' then (r ->> 'fee')::numeric end,
      v_net, v_hash, v_status, coalesce(r -> 'raw', '{}'),
      case v_status when 'invalid' then 'Thiếu mã booking, tiền tệ hoặc số thực nhận'
                    when 'duplicate' then 'Dòng đã có trong bảng thanh toán trước' end)
    returning id into v_line;

    if v_status = 'unmatched' then
      perform public._match_settlement_line(v_line);
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'batch_id', v_batch);
end $$;

-- Ghi số thực nhận của một booking bằng tổng các dòng đã xác nhận, nên chạy lại không cộng dồn.
create function public._apply_settlement_to_booking(p_booking uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
  v_total numeric;
  v_has_mismatch boolean;
begin
  select * into v_b from public.bookings where id = p_booking for update;
  -- Số thực nhận chỉ cộng dòng cùng tiền tệ; dòng khác tiền tệ vẫn làm booking thành "lệch".
  select sum(l.net_amount) filter (where l.currency = coalesce(f.currency, v_b.currency)),
         coalesce(bool_or(l.match_status = 'mismatch'), false)
  into v_total, v_has_mismatch
  from public.settlement_lines l
  join public.settlement_batches s on s.id = l.batch_id
  left join public.booking_financials f on f.booking_id = p_booking
  where l.booking_id = p_booking and s.status = 'confirmed' and l.match_status in ('matched', 'mismatch');

  insert into public.booking_financials (booking_id, organization_id, currency, actual_payout, source)
  values (p_booking, v_b.organization_id, v_b.currency, v_total, 'settlement')
  on conflict (booking_id) do update set actual_payout = excluded.actual_payout, updated_at = now();

  update public.bookings set reconciliation_status = case
    when reconciliation_status = 'adjusted' then 'adjusted'::public.reconciliation_status
    when v_has_mismatch then 'mismatch'::public.reconciliation_status
    when v_total is not null then 'matched'::public.reconciliation_status
    else reconciliation_status end
  where id = p_booking;
end $$;

create function public.settlement_confirm(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_s public.settlement_batches%rowtype;
  r public.settlement_lines%rowtype;
  v_applied int := 0;
begin
  select * into v_s from public.settlement_batches where id = p_batch for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'batch_not_found');
  end if;
  perform public._require(v_s.organization_id, 'finance.manage');
  if v_s.status = 'confirmed' then
    return jsonb_build_object('ok', true, 'code', 'already_confirmed');
  end if;
  update public.settlement_batches set status = 'confirmed', confirmed_by = (select auth.uid()), confirmed_at = now() where id = p_batch;

  for r in select * from public.settlement_lines
    where batch_id = p_batch and match_status in ('matched', 'mismatch') and booking_id is not null
  loop
    insert into public.reconciliation_matches (organization_id, settlement_line_id, booking_id, amount, currency, action, actor_id)
    values (v_s.organization_id, r.id, r.booking_id, r.net_amount, r.currency, 'auto', (select auth.uid()));
    perform public._apply_settlement_to_booking(r.booking_id);
    v_applied := v_applied + 1;
  end loop;
  perform public._audit(v_s.organization_id, 'confirm', 'settlement_batches', p_batch::text, null, jsonb_build_object('applied', v_applied));
  return jsonb_build_object('ok', true, 'applied', v_applied);
end $$;

-- Gán tay dòng chưa ghép vào booking.
create function public.settlement_match_line(p_line uuid, p_booking uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_l public.settlement_lines%rowtype;
  v_b public.bookings%rowtype;
  v_s public.settlement_batches%rowtype;
  v_cur text;
begin
  select * into v_l from public.settlement_lines where id = p_line;
  perform public._require(v_l.organization_id, 'finance.manage');
  select * into v_b from public.bookings where id = p_booking and organization_id = v_l.organization_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'booking_not_found');
  end if;
  select coalesce(f.currency, v_b.currency) into v_cur from public.booking_financials f where f.booking_id = p_booking;
  if coalesce(v_cur, v_b.currency) is distinct from v_l.currency then
    return jsonb_build_object('ok', false, 'code', 'currency_mismatch');
  end if;
  update public.settlement_lines set booking_id = p_booking, match_status = 'matched', note = p_note where id = p_line;
  select * into v_s from public.settlement_batches where id = v_l.batch_id;
  insert into public.reconciliation_matches (organization_id, settlement_line_id, booking_id, amount, currency, action, note, actor_id)
  values (v_l.organization_id, p_line, p_booking, v_l.net_amount, v_l.currency, 'manual', p_note, (select auth.uid()));
  if v_s.status = 'confirmed' then
    perform public._apply_settlement_to_booking(p_booking);
  end if;
  perform public._audit(v_l.organization_id, 'manual_match', 'settlement_lines', p_line::text, null, jsonb_build_object('booking_id', p_booking, 'note', p_note));
  return jsonb_build_object('ok', true);
end $$;

-- Đánh dấu đã xử lý khoản lệch, kèm lý do và lưu lịch sử.
create function public.settlement_adjust(p_booking uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
begin
  select * into v_b from public.bookings where id = p_booking;
  perform public._require(v_b.organization_id, 'finance.manage');
  if coalesce(p_note, '') = '' then
    return jsonb_build_object('ok', false, 'code', 'note_required');
  end if;
  update public.bookings set reconciliation_status = 'adjusted' where id = p_booking;
  insert into public.booking_status_history (organization_id, booking_id, field, from_value, to_value, source, actor_id)
  values (v_b.organization_id, p_booking, 'reconciliation_status', v_b.reconciliation_status::text, 'adjusted', 'finance', (select auth.uid()));
  perform public._audit(v_b.organization_id, 'adjust', 'bookings', p_booking::text, null, jsonb_build_object('note', p_note));
  return jsonb_build_object('ok', true);
end $$;

-- Sửa số tài chính của booking. Chuỗi rỗng/null nghĩa là "chưa có dữ liệu", không ép về 0.
create function public.update_booking_financials(p_booking uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_b public.bookings%rowtype;
  v_before jsonb;
begin
  select * into v_b from public.bookings where id = p_booking;
  perform public._require(v_b.organization_id, 'finance.manage');
  select to_jsonb(f) into v_before from public.booking_financials f where f.booking_id = p_booking;
  insert into public.booking_financials (booking_id, organization_id, currency, source)
  values (p_booking, v_b.organization_id, v_b.currency, 'manual') on conflict (booking_id) do nothing;
  update public.booking_financials set
    discount_amount = case when p_patch ? 'discount_amount' then nullif(p_patch ->> 'discount_amount', '')::numeric else discount_amount end,
    channel_fee = case when p_patch ? 'channel_fee' then nullif(p_patch ->> 'channel_fee', '')::numeric else channel_fee end,
    refund_amount = case when p_patch ? 'refund_amount' then nullif(p_patch ->> 'refund_amount', '')::numeric else refund_amount end,
    expected_payout = case when p_patch ? 'expected_payout' then nullif(p_patch ->> 'expected_payout', '')::numeric else expected_payout end,
    source = 'manual', updated_at = now()
  where booking_id = p_booking;
  perform public._audit(v_b.organization_id, 'update_financials', 'bookings', p_booking::text, v_before, p_patch);
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------- Báo cáo ----------------------------

-- Không có phép cộng nào băng qua tiền tệ: mọi tổng tiền đều GROUP BY currency.
create function public.dashboard_summary(p_org uuid, p_from date, p_to date, p_connection uuid default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tz text;
  v_today date;
  v_finance boolean := public.has_org_permission(p_org, 'finance.read');
begin
  perform public._require(p_org, 'booking.read');
  select default_timezone into v_tz from public.organizations where id = p_org;
  v_today := (now() at time zone v_tz)::date;

  return jsonb_build_object(
    'today', v_today,
    'new_bookings', (select count(*) from public.bookings b where b.organization_id = p_org
      and (b.booked_at at time zone v_tz)::date between p_from and p_to
      and (p_connection is null or b.connection_id = p_connection)),
    'cancelled_bookings', (select count(*) from public.bookings b where b.organization_id = p_org and b.status = 'cancelled'
      and (b.updated_at at time zone v_tz)::date between p_from and p_to
      and (p_connection is null or b.connection_id = p_connection)),
    'pax_today', (select coalesce(sum(i.pax_total), 0) from public.booking_items i
      join public.departures d on d.id = i.departure_id
      where d.organization_id = p_org and d.local_date = v_today and i.committed_seats > 0),
    'departures_today', (select count(*) from public.departures d where d.organization_id = p_org and d.local_date = v_today and d.status = 'scheduled'),
    'departures_tomorrow', (select count(*) from public.departures d where d.organization_id = p_org and d.local_date = v_today + 1 and d.status = 'scheduled'),
    'departures_missing_resources', (select count(*) from public.departures d
      where d.organization_id = p_org and d.local_date between v_today and v_today + 7 and d.status = 'scheduled'
        and exists (select 1 from public.booking_items i where i.departure_id = d.id and i.committed_seats > 0)
        and (not exists (select 1 from public.guide_assignments g where g.departure_id = d.id)
          or not exists (select 1 from public.vehicle_assignments v where v.departure_id = d.id))),
    'bookings_missing_info', (select count(*) from public.bookings b where b.organization_id = p_org
      and b.ops_status in ('needs_mapping', 'needs_departure', 'needs_info')
      and (p_connection is null or b.connection_id = p_connection)),
    'tasks', (select jsonb_build_object(
        'needs_mapping', count(*) filter (where b.ops_status = 'needs_mapping'),
        'needs_departure', count(*) filter (where b.ops_status = 'needs_departure'),
        'needs_info', count(*) filter (where b.ops_status = 'needs_info'),
        'changed_after_assignment', count(*) filter (where b.changed_after_assignment and b.status <> 'cancelled'),
        'needs_action', count(*) filter (where b.needs_action and b.status <> 'cancelled'))
      from public.bookings b where b.organization_id = p_org
        and (p_connection is null or b.connection_id = p_connection)),
    'values_by_currency', (select coalesce(jsonb_agg(x order by x.currency), '[]'::jsonb) from (
      select b.currency, sum(b.gross_amount) as gross,
        case when v_finance then sum(f.expected_payout) end as expected,
        case when v_finance then sum(f.actual_payout) end as actual,
        case when v_finance then count(*) filter (where f.expected_payout is null) end as expected_missing,
        case when v_finance then count(*) filter (where f.actual_payout is null) end as actual_missing,
        count(*) as bookings
      from public.bookings b
      left join public.booking_financials f on f.booking_id = b.id
      where b.organization_id = p_org and b.currency is not null and b.status <> 'cancelled'
        and (b.booked_at at time zone v_tz)::date between p_from and p_to
        and (p_connection is null or b.connection_id = p_connection)
      group by b.currency
    ) x),
    'bookings_by_day', (select coalesce(jsonb_agg(x order by x.day, x.channel), '[]'::jsonb) from (
      select (b.booked_at at time zone v_tz)::date as day, coalesce(c.channel::text, 'manual') as channel, count(*) as bookings
      from public.bookings b left join public.channel_connections c on c.id = b.connection_id
      where b.organization_id = p_org and (b.booked_at at time zone v_tz)::date between p_from and p_to
        and (p_connection is null or b.connection_id = p_connection)
      group by 1, 2
    ) x),
    'failed_events', case when public.has_org_permission(p_org, 'connection.read') then (
      select count(*) from public.integration_events e where e.organization_id = p_org and e.status in ('failed', 'dead')) end
  );
end $$;

-- Lợi nhuận theo tour và tiền tệ, kèm mức độ hoàn thiện dữ liệu.
create function public.report_profit(p_org uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform public._require(p_org, 'finance.read');
  return (
    with items as (
      select distinct on (i.booking_id) i.booking_id, i.tour_id, i.local_date
      from public.booking_items i
      where i.organization_id = p_org and i.local_date between p_from and p_to
      order by i.booking_id, i.local_date
    ), rev as (
      select i.tour_id, b.currency,
        count(*)::int as bookings,
        sum(b.gross_amount) as gross,
        sum(f.channel_fee) as channel_fee,
        sum(f.refund_amount) as refund,
        sum(f.expected_payout) as expected_payout,
        sum(f.actual_payout) as actual_payout,
        count(*) filter (where b.gross_amount is null)::int as missing_gross,
        count(*) filter (where f.channel_fee is null)::int as missing_fee,
        count(*) filter (where f.actual_payout is null)::int as missing_actual
      from items i
      join public.bookings b on b.id = i.booking_id
      left join public.booking_financials f on f.booking_id = b.id
      where b.status <> 'cancelled' and b.currency is not null
      group by i.tour_id, b.currency
    ), cost as (
      select d.tour_id, e.currency, sum(e.amount) as costs,
        count(*) filter (where not e.is_final)::int as estimated_cost_lines
      from public.expenses e
      join public.departures d on d.id = e.departure_id
      where e.organization_id = p_org and e.deleted_at is null and d.local_date between p_from and p_to
      group by d.tour_id, e.currency
    ), deps as (
      select d.tour_id,
        count(*) filter (where exists (select 1 from public.booking_items i where i.departure_id = d.id and i.committed_seats > 0))::int as departures_run,
        count(*) filter (where exists (select 1 from public.booking_items i where i.departure_id = d.id and i.committed_seats > 0)
          and not exists (select 1 from public.expenses e where e.departure_id = d.id and e.deleted_at is null))::int as departures_without_cost
      from public.departures d
      where d.organization_id = p_org and d.local_date between p_from and p_to
      group by d.tour_id
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'tour_id', coalesce(r.tour_id, c.tour_id),
      'tour_name', coalesce(t.name, 'Chưa ghép tour'),
      'currency', coalesce(r.currency, c.currency),
      'bookings', coalesce(r.bookings, 0),
      'gross', r.gross, 'channel_fee', r.channel_fee, 'refund', r.refund,
      'expected_payout', r.expected_payout, 'actual_payout', r.actual_payout,
      'costs', c.costs,
      'missing_gross', coalesce(r.missing_gross, 0),
      'missing_fee', coalesce(r.missing_fee, 0),
      'missing_actual', coalesce(r.missing_actual, 0),
      'estimated_cost_lines', coalesce(c.estimated_cost_lines, 0),
      'departures_run', coalesce(dp.departures_run, 0),
      'departures_without_cost', coalesce(dp.departures_without_cost, 0),
      -- Lợi nhuận chỉ tính khi dữ liệu đủ; thiếu thì null để giao diện nói "chưa đủ dữ liệu", không ra số sai.
      'profit', case
        when r.gross is null or coalesce(r.missing_gross, 0) > 0 or coalesce(r.missing_fee, 0) > 0
          or coalesce(dp.departures_without_cost, 0) > 0 or c.costs is null then null
        else r.gross - coalesce(r.refund, 0) - r.channel_fee - c.costs end
    ) order by t.name, coalesce(r.currency, c.currency)), '[]'::jsonb)
    from rev r
    full join cost c on c.tour_id = r.tour_id and c.currency = r.currency
    left join public.tours t on t.id = coalesce(r.tour_id, c.tour_id)
    left join deps dp on dp.tour_id = coalesce(r.tour_id, c.tour_id)
  );
end $$;

create function public.quick_search(p_org uuid, p_query text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q text := '%' || replace(replace(lower(coalesce(p_query, '')), '%', '\%'), '_', '\_') || '%';
begin
  if length(trim(coalesce(p_query, ''))) < 2 then
    return jsonb_build_object('bookings', '[]'::jsonb, 'customers', '[]'::jsonb, 'tours', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'bookings', case when public.has_org_permission(p_org, 'booking.read') then (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select b.id, b.code, b.external_ref, b.lead_name, b.status from public.bookings b
        where b.organization_id = p_org and (lower(b.code) like v_q or lower(coalesce(b.external_ref, '')) like v_q or lower(coalesce(b.lead_name, '')) like v_q)
        order by b.booked_at desc limit 8) x) else '[]'::jsonb end,
    'customers', case when public.has_org_permission(p_org, 'customer.read') then (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select c.id, c.full_name, c.email from public.customers c
        where c.organization_id = p_org and c.merged_into_id is null and (lower(c.full_name) like v_q or lower(coalesce(c.email, '')) like v_q or coalesce(c.phone, '') like v_q)
        order by c.created_at desc limit 5) x) else '[]'::jsonb end,
    'tours', case when public.has_org_permission(p_org, 'catalog.read') then (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select t.id, t.code, t.name from public.tours t
        where t.organization_id = p_org and t.deleted_at is null and (lower(t.name) like v_q or lower(t.code) like v_q)
        order by t.name limit 5) x) else '[]'::jsonb end
  );
end $$;

-- Xuất CSV cần quyền riêng và được ghi nhật ký. Dữ liệu đã lọc ở server, tối đa 10.000 dòng.
create function public.export_bookings(p_org uuid, p_filters jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_rows jsonb;
begin
  perform public._require(p_org, 'booking.export');
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_rows from (
    select b.code, b.external_ref, b.channel, b.account_name, b.lead_name, b.tour_name, b.option_name,
      b.local_date, b.local_time, b.timezone, b.pax_total, b.pickup_hotel, b.status, b.ops_status,
      b.gross_amount, b.currency, b.owner_name, b.sync_status, b.booked_at
    from public.v_booking_list b
    where b.organization_id = p_org
      and (p_filters ->> 'status' is null or b.status::text = p_filters ->> 'status')
      and (p_filters ->> 'ops_status' is null or b.ops_status::text = p_filters ->> 'ops_status')
      and (p_filters ->> 'connection_id' is null or b.connection_id = (p_filters ->> 'connection_id')::uuid)
      and (p_filters ->> 'travel_from' is null or b.local_date >= (p_filters ->> 'travel_from')::date)
      and (p_filters ->> 'travel_to' is null or b.local_date <= (p_filters ->> 'travel_to')::date)
      and (p_filters ->> 'q' is null or b.search_text like '%' || lower(p_filters ->> 'q') || '%')
    order by b.booked_at desc
    limit 10000
  ) x;
  perform public._audit(p_org, 'export', 'bookings', null, null,
    p_filters || jsonb_build_object('rows', jsonb_array_length(v_rows)));
  return v_rows;
end $$;
