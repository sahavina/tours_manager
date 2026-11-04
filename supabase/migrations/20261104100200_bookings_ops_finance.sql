-- Booking, điều hành, tài chính, nhập file, tích hợp.

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  code text not null,
  connection_id uuid,
  external_ref text,
  source text not null default 'manual' check (source in ('manual', 'channel', 'import')),
  customer_id uuid,
  lead_name text,
  lead_email text,
  lead_phone text,
  special_requests text,
  -- Sáu trạng thái tách biệt theo đặc tả §7.3.
  channel_status text,
  status public.booking_status not null default 'confirmed',
  ops_status public.ops_status not null default 'new',
  payment_status public.payment_status not null default 'unknown',
  reconciliation_status public.reconciliation_status not null default 'unreconciled',
  sync_status public.sync_status not null default 'manual',
  -- null nghĩa là nguồn chưa cung cấp, không phải 0.
  gross_amount numeric(18, 4),
  currency char(3),
  policy_snapshot jsonb,
  booked_at timestamptz not null default now(),
  owner_id uuid references public.profiles (id) on delete set null,
  needs_action boolean not null default false,
  action_reason text,
  changed_after_assignment boolean not null default false,
  -- Mốc sự kiện mới nhất đã áp dụng, để sự kiện cũ đến muộn không ghi đè.
  last_source_at timestamptz,
  last_source_version bigint,
  import_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, code),
  foreign key (organization_id, connection_id) references public.channel_connections (organization_id, id),
  foreign key (organization_id, customer_id) references public.customers (organization_id, id),
  constraint amount_has_currency check (gross_amount is null or currency is not null)
);
-- Khóa nhận diện booking ngoài theo đặc tả §9.1: doanh nghiệp + tài khoản + mã ngoài.
create unique index bookings_external_uq on public.bookings (organization_id, connection_id, external_ref)
  where external_ref is not null;
create index bookings_org_booked_idx on public.bookings (organization_id, booked_at desc);
create index bookings_org_status_idx on public.bookings (organization_id, status, ops_status);
create index bookings_customer_idx on public.bookings (customer_id) where customer_id is not null;

alter table public.inventory_holds
  add foreign key (organization_id, booking_id) references public.bookings (organization_id, id);

create table public.booking_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  booking_id uuid not null,
  -- Mã dòng trong payload nguồn; booking một dòng dùng 'main'.
  item_ref text not null default 'main',
  external_product_code text,
  external_option_code text,
  tour_option_id uuid,
  tour_id uuid,
  departure_id uuid,
  local_date date,
  local_time time,
  timezone text,
  language text,
  pax jsonb not null default '{}',
  pax_total int not null default 0 check (pax_total >= 0),
  seats int not null default 0 check (seats >= 0),
  -- Số chỗ THỰC SỰ đang chiếm trong nguồn chỗ. Hủy đặt về 0, nên hủy lặp không trả chỗ lần hai.
  committed_seats int not null default 0 check (committed_seats >= 0),
  amount numeric(18, 4),
  currency char(3),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (booking_id, item_ref),
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) on delete cascade,
  foreign key (organization_id, tour_option_id) references public.tour_options (organization_id, id),
  foreign key (organization_id, tour_id) references public.tours (organization_id, id),
  foreign key (organization_id, departure_id) references public.departures (organization_id, id),
  constraint committed_needs_departure check (committed_seats = 0 or departure_id is not null)
);
create index booking_items_departure_idx on public.booking_items (departure_id);
create index booking_items_committed_idx on public.booking_items (departure_id) where committed_seats > 0;
create index booking_items_booking_idx on public.booking_items (booking_id);

create table public.booking_participants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  booking_id uuid not null,
  booking_item_id uuid,
  full_name text,
  category_code text,
  is_lead boolean not null default false,
  note text,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) on delete cascade,
  foreign key (organization_id, booking_item_id) references public.booking_items (organization_id, id) on delete cascade
);
create index booking_participants_booking_idx on public.booking_participants (booking_id);

create table public.booking_pickups (
  booking_item_id uuid primary key,
  organization_id uuid not null,
  hotel_name text,
  address text,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  -- Ba cột dưới thuộc điều hành: đồng bộ từ kênh KHÔNG được ghi đè.
  pickup_local_time time,
  sort_order int,
  ops_note text,
  updated_at timestamptz not null default now(),
  foreign key (organization_id, booking_item_id) references public.booking_items (organization_id, id) on delete cascade
);

-- Ghi chú nội bộ ở bảng riêng: đường đồng bộ không có câu lệnh nào chạm vào bảng này.
create table public.booking_notes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  booking_id uuid not null,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now(),
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) on delete cascade
);
create index booking_notes_booking_idx on public.booking_notes (booking_id, created_at desc);

create table public.booking_status_history (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  booking_id uuid not null,
  field text not null,
  from_value text,
  to_value text,
  source text not null,
  actor_id uuid,
  event_id uuid,
  created_at timestamptz not null default now(),
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) on delete cascade
);
create index booking_status_history_idx on public.booking_status_history (booking_id, created_at desc);

create table public.booking_changes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  booking_id uuid not null,
  change_type text not null,
  summary text not null,
  before_data jsonb,
  after_data jsonb,
  source text not null,
  actor_id uuid,
  event_id uuid,
  -- Sửa nội bộ / yêu cầu trên kênh / kênh xác nhận là ba việc khác nhau (đặc tả §11).
  channel_request_status public.channel_request_status not null default 'not_applicable',
  created_at timestamptz not null default now(),
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) on delete cascade
);
create index booking_changes_idx on public.booking_changes (booking_id, created_at desc);

-- Tách khỏi bookings để `booking.read` không kéo theo dữ liệu nguồn (đặc tả §7.3).
create table public.booking_source_snapshots (
  booking_id uuid primary key,
  organization_id uuid not null,
  payload jsonb not null,
  captured_at timestamptz not null default now(),
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) on delete cascade
);

-- Mọi cột tiền đều nullable: null = "chưa có dữ liệu", không bao giờ coi là 0.
create table public.booking_financials (
  booking_id uuid primary key,
  organization_id uuid not null,
  currency char(3),
  discount_amount numeric(18, 4),
  channel_fee numeric(18, 4),
  refund_amount numeric(18, 4),
  expected_payout numeric(18, 4),
  actual_payout numeric(18, 4),
  source text not null default 'unknown',
  updated_at timestamptz not null default now(),
  -- PostgREST chỉ coi quan hệ là 1-1 khi đúng các cột FK này là unique; thiếu thì nhúng trả về MẢNG và
  -- giao diện đọc `.expected_payout` ra undefined, tức hiện "Chưa có dữ liệu" dù đã có số.
  unique (organization_id, booking_id),
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id) on delete cascade
);

create table public.guide_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  departure_id uuid not null,
  guide_id uuid not null,
  role text not null default 'lead',
  notified_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (departure_id, guide_id),
  unique (organization_id, id),
  foreign key (organization_id, departure_id) references public.departures (organization_id, id) on delete cascade,
  foreign key (organization_id, guide_id) references public.guides (organization_id, id)
);
create index guide_assignments_guide_idx on public.guide_assignments (guide_id);

create table public.vehicle_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  departure_id uuid not null,
  vehicle_id uuid not null,
  driver_name text,
  driver_phone text,
  notified_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (departure_id, vehicle_id),
  unique (organization_id, id),
  -- Để passenger_allocations buộc xe và khách cùng một chuyến bằng FK.
  unique (id, departure_id),
  foreign key (organization_id, departure_id) references public.departures (organization_id, id) on delete cascade,
  foreign key (organization_id, vehicle_id) references public.vehicles (organization_id, id)
);

create table public.passenger_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  departure_id uuid not null,
  vehicle_assignment_id uuid not null,
  booking_item_id uuid not null,
  seats int not null check (seats > 0),
  -- Đổi chuyến hoặc hủy thì tắt, không xóa, để giữ lịch sử.
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (vehicle_assignment_id, departure_id) references public.vehicle_assignments (id, departure_id) on delete cascade,
  foreign key (organization_id, booking_item_id) references public.booking_items (organization_id, id) on delete cascade
);
create unique index passenger_allocations_active_uq on public.passenger_allocations (booking_item_id) where is_active;
create index passenger_allocations_vehicle_idx on public.passenger_allocations (vehicle_assignment_id) where is_active;

-- Khóa theo (chuyến, dòng): đổi chuyến sinh bản ghi mới, bản ghi cũ ở chuyến cũ vẫn còn.
create table public.attendance_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  departure_id uuid not null,
  booking_item_id uuid not null,
  status public.attendance_status not null default 'pending',
  note text,
  recorded_by uuid references public.profiles (id) on delete set null,
  recorded_at timestamptz not null default now(),
  unique (departure_id, booking_item_id),
  foreign key (organization_id, departure_id) references public.departures (organization_id, id) on delete cascade,
  foreign key (organization_id, booking_item_id) references public.booking_items (organization_id, id) on delete cascade
);

create table public.departure_incidents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  departure_id uuid not null,
  severity text not null default 'normal' check (severity in ('low', 'normal', 'high')),
  body text not null check (length(body) between 1 and 5000),
  reported_by uuid references public.profiles (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (organization_id, departure_id) references public.departures (organization_id, id) on delete cascade
);
create index departure_incidents_dep_idx on public.departure_incidents (departure_id);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  departure_id uuid,
  booking_id uuid,
  supplier_id uuid,
  category text not null default 'other',
  description text,
  amount numeric(18, 4) not null check (amount >= 0),
  currency char(3) not null,
  incurred_on date not null default current_date,
  is_final boolean not null default false,
  deleted_at timestamptz,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, departure_id) references public.departures (organization_id, id),
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id),
  foreign key (organization_id, supplier_id) references public.suppliers (organization_id, id)
);
create index expenses_departure_idx on public.expenses (departure_id) where deleted_at is null;

create table public.settlement_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null,
  filename text,
  file_hash text not null,
  status text not null default 'previewed' check (status in ('previewed', 'confirmed')),
  column_map jsonb not null default '{}',
  created_by uuid references public.profiles (id) on delete set null,
  confirmed_by uuid references public.profiles (id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, connection_id, file_hash),
  foreign key (organization_id, connection_id) references public.channel_connections (organization_id, id)
);

create table public.settlement_lines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  batch_id uuid not null,
  row_no int not null,
  external_ref text,
  currency char(3),
  gross_amount numeric(18, 4),
  fee_amount numeric(18, 4),
  net_amount numeric(18, 4),
  line_hash text not null,
  match_status text not null default 'unmatched'
    check (match_status in ('matched', 'mismatch', 'unmatched', 'duplicate', 'invalid')),
  booking_id uuid,
  difference numeric(18, 4),
  note text,
  raw jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, batch_id) references public.settlement_batches (organization_id, id) on delete cascade,
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id)
);
create index settlement_lines_batch_idx on public.settlement_lines (batch_id, row_no);
create index settlement_lines_hash_idx on public.settlement_lines (organization_id, line_hash);

create table public.reconciliation_matches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  settlement_line_id uuid not null,
  booking_id uuid not null,
  amount numeric(18, 4),
  currency char(3),
  action text not null check (action in ('auto', 'manual', 'adjusted')),
  note text,
  actor_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (organization_id, settlement_line_id) references public.settlement_lines (organization_id, id) on delete cascade,
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id)
);
create index reconciliation_matches_booking_idx on public.reconciliation_matches (booking_id);

create table public.import_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null default 'booking' check (kind in ('booking')),
  connection_id uuid not null,
  filename text not null,
  file_hash text not null,
  file_size int not null check (file_size between 0 and 10485760),
  column_map jsonb not null default '{}',
  status text not null default 'previewed' check (status in ('previewed', 'committed')),
  counts jsonb not null default '{}',
  created_by uuid references public.profiles (id) on delete set null,
  committed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, connection_id) references public.channel_connections (organization_id, id)
);
create index import_jobs_org_idx on public.import_jobs (organization_id, created_at desc);

create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  job_id uuid not null,
  row_no int not null,
  raw jsonb not null default '{}',
  normalized jsonb,
  row_hash text,
  classification public.import_classification not null,
  errors text[] not null default '{}',
  booking_id uuid,
  unique (job_id, row_no),
  foreign key (organization_id, job_id) references public.import_jobs (organization_id, id) on delete cascade,
  foreign key (organization_id, booking_id) references public.bookings (organization_id, id)
);

create table public.integration_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  connection_id uuid not null,
  -- Mã sự kiện của nguồn; thiếu thì là hash nội dung. Khóa chống nhận trùng.
  event_key text not null,
  event_type text not null,
  external_ref text,
  source_at timestamptz,
  source_version bigint,
  payload jsonb not null,
  status public.event_status not null default 'received',
  attempts int not null default 0,
  next_attempt_at timestamptz,
  last_error text,
  result jsonb,
  duplicate_count int not null default 0,
  ordering_verified boolean not null default true,
  is_simulated boolean not null default false,
  correlation_id text not null default gen_random_uuid()::text,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (organization_id, connection_id, event_key),
  foreign key (organization_id, connection_id) references public.channel_connections (organization_id, id)
);
create index integration_events_retry_idx on public.integration_events (next_attempt_at)
  where status = 'failed';
create index integration_events_org_idx on public.integration_events (organization_id, received_at desc);
create index integration_events_ref_idx on public.integration_events (connection_id, external_ref);

create table public.sync_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid,
  connection_id uuid,
  kind text not null,
  status public.job_status not null default 'pending',
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  detail jsonb not null default '{}',
  last_error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (organization_id) references public.organizations (id) on delete cascade
);
create index sync_jobs_due_idx on public.sync_jobs (run_after) where status in ('pending', 'failed');
create index sync_jobs_org_idx on public.sync_jobs (organization_id, created_at desc);

create table public.outbox_events (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  topic text not null,
  aggregate_id text,
  dedupe_key text,
  payload jsonb not null default '{}',
  status public.job_status not null default 'pending',
  attempts int not null default 0,
  run_after timestamptz not null default now(),
  last_error text,
  correlation_id text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index outbox_due_idx on public.outbox_events (run_after) where status in ('pending', 'failed');
create unique index outbox_dedupe_uq on public.outbox_events (organization_id, dedupe_key)
  where dedupe_key is not null;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- null: gửi cho mọi người có `required_permission`.
  user_id uuid references public.profiles (id) on delete cascade,
  required_permission text not null default 'booking.read',
  kind text not null,
  title text not null,
  body text,
  link text,
  dedupe_key text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_org_idx on public.notifications (organization_id, created_at desc);
create unique index notifications_dedupe_uq on public.notifications (organization_id, dedupe_key)
  where dedupe_key is not null;

create table public.saved_filters (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  scope text not null default 'bookings',
  name text not null,
  filters jsonb not null,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id, scope, name)
);

do $$
declare t text;
begin
  foreach t in array array['bookings', 'booking_items', 'booking_financials', 'expenses']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_updated', t);
  end loop;
end $$;
