-- Tour, gói, nguồn chỗ, chuyến, giữ chỗ, danh mục tài nguyên.

create table public.tours (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  destination text,
  duration_minutes int check (duration_minutes is null or duration_minutes > 0),
  default_timezone text not null default 'Asia/Ho_Chi_Minh',
  itinerary jsonb not null default '[]',
  inclusions text[] not null default '{}',
  exclusions text[] not null default '{}',
  joining_instructions text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, code)
);

create table public.tour_options (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tour_id uuid not null,
  code text not null,
  name text not null,
  language text not null default 'en',
  has_transfer boolean not null default false,
  is_private boolean not null default false,
  price_rules jsonb not null default '{}',
  capacity_rules jsonb not null default '{}',
  cutoff_minutes int not null default 0 check (cutoff_minutes >= 0),
  ops_policy text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, code),
  -- FK ghép dưới đây (departures) cần cả ba cột để chặn gói của tour khác.
  unique (organization_id, tour_id, id),
  foreign key (organization_id, tour_id) references public.tours (organization_id, id)
);
create index tour_options_tour_idx on public.tour_options (tour_id);

create table public.traveler_categories (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  code text not null,
  name text not null,
  min_age int,
  max_age int,
  -- Em bé ngồi lòng không chiếm chỗ; loại khách lạ trong payload mặc định VẪN chiếm chỗ (an toàn hơn).
  counts_as_seat boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, code),
  unique (organization_id, id)
);

create table public.inventory_pools (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  capacity int not null check (capacity >= 0),
  blocked_seats int not null default 0 check (blocked_seats >= 0),
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.departures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  tour_id uuid not null,
  tour_option_id uuid,
  inventory_pool_id uuid not null,
  local_date date not null,
  local_time time not null,
  timezone text not null,
  -- Luôn được trigger tính từ giờ địa phương + múi giờ, không nhận từ client.
  starts_at timestamptz not null,
  sale_open boolean not null default true,
  cutoff_at timestamptz,
  status public.departure_status not null default 'scheduled',
  note text,
  outcome text,
  supplier_confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, tour_id) references public.tours (organization_id, id),
  foreign key (organization_id, tour_id, tour_option_id)
    references public.tour_options (organization_id, tour_id, id),
  foreign key (organization_id, inventory_pool_id)
    references public.inventory_pools (organization_id, id)
);
-- Tour không phân gói có tour_option_id = null; NULLS NOT DISTINCT để vẫn chống tạo trùng.
create unique index departures_slot_uq on public.departures
  (organization_id, tour_id, tour_option_id, local_date, local_time) nulls not distinct;
create index departures_org_date_idx on public.departures (organization_id, local_date);
create index departures_pool_idx on public.departures (inventory_pool_id);

create function public._departure_compute_times() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_cutoff int;
begin
  -- `at time zone` ném lỗi với múi giờ không tồn tại: đó là chốt kiểm tra múi giờ.
  new.starts_at := (new.local_date + new.local_time) at time zone new.timezone;
  if new.tour_option_id is not null then
    select o.cutoff_minutes into v_cutoff from public.tour_options o where o.id = new.tour_option_id;
    new.cutoff_at := new.starts_at - make_interval(mins => coalesce(v_cutoff, 0));
  else
    new.cutoff_at := new.starts_at;
  end if;
  return new;
end $$;
create trigger departures_times before insert or update of local_date, local_time, timezone, tour_option_id
  on public.departures for each row execute function public._departure_compute_times();

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  full_name text not null,
  email text,
  phone text,
  nationality text,
  service_notes text,
  source text not null default 'manual',
  external_customer_ref text,
  -- Dữ liệu khách OTA không được coi là đã đồng ý nhận marketing.
  marketing_consent boolean not null default false,
  merged_into_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, merged_into_id) references public.customers (organization_id, id)
);
create index customers_org_name_idx on public.customers (organization_id, full_name);
create index customers_email_idx on public.customers (organization_id, lower(email)) where email is not null;
create index customers_phone_idx on public.customers (organization_id, phone) where phone is not null;

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null,
  kind text not null default 'transport',
  contact_name text,
  phone text,
  email text,
  note text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);

create table public.guides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  -- Có tài khoản thì xem được giao diện hướng dẫn viên; chưa có vẫn phân công được.
  profile_id uuid references public.profiles (id) on delete set null,
  full_name text not null,
  phone text,
  languages text[] not null default '{}',
  note text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id)
);
create index guides_profile_idx on public.guides (profile_id) where profile_id is not null;

create table public.vehicles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  supplier_id uuid,
  name text not null,
  plate text,
  seats int not null check (seats > 0),
  driver_name text,
  driver_phone text,
  is_active boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, supplier_id) references public.suppliers (organization_id, id)
);

-- Kết nối kênh: không có cột chứa khóa API. `credential_ref` chỉ là TÊN của bí mật nằm ngoài database.
create table public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  channel public.channel_kind not null,
  account_name text not null,
  supplier_account_ref text,
  mode public.connection_mode not null default 'mock',
  status public.connection_status not null default 'simulated',
  approval_status text not null default 'not_requested'
    check (approval_status in ('not_requested', 'pending', 'approved', 'rejected', 'not_required')),
  capabilities jsonb not null default '{}',
  hold_ttl_seconds int not null default 900 check (hold_ttl_seconds > 0),
  credential_ref text,
  has_credentials boolean generated always as (credential_ref is not null) stored,
  last_success_at timestamptz,
  last_simulated_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  stale_after_minutes int not null default 60 check (stale_after_minutes > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, channel, account_name),
  -- Chốt ở tầng dữ liệu: kết nối mô phỏng không thể mang trạng thái "đã kết nối thật".
  constraint mock_is_never_connected check (
    mode <> 'mock' or (status in ('simulated', 'error', 'disabled') and last_success_at is null)
  ),
  constraint connected_needs_credentials check (
    status <> 'connected'
    or channel = 'manual'
    or (credential_ref is not null and approval_status in ('approved', 'not_required'))
  )
);

create table public.channel_product_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  connection_id uuid not null,
  external_product_code text not null,
  external_option_code text not null default '',
  tour_option_id uuid,
  language text,
  -- Nhóm khách kênh -> mã nội bộ, ví dụ {"ADULT":"adult"}.
  traveler_map jsonb not null default '{}',
  -- Giờ chạy cố định cho mã này nếu payload không mang giờ.
  default_local_time time,
  is_verified boolean not null default false,
  verified_by uuid references public.profiles (id),
  verified_at timestamptz,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  unique (organization_id, connection_id, external_product_code, external_option_code),
  foreign key (organization_id, connection_id) references public.channel_connections (organization_id, id),
  foreign key (organization_id, tour_option_id) references public.tour_options (organization_id, id),
  constraint verified_needs_target check (not is_verified or tour_option_id is not null)
);

create table public.inventory_holds (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  departure_id uuid not null,
  inventory_pool_id uuid not null,
  connection_id uuid,
  -- Mã tham chiếu cũng là idempotency key: giữ lại cùng mã không giữ thêm chỗ.
  reference text not null,
  quantity int not null check (quantity > 0),
  status public.hold_status not null default 'active',
  expires_at timestamptz not null,
  booking_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, id),
  foreign key (organization_id, departure_id) references public.departures (organization_id, id),
  foreign key (organization_id, inventory_pool_id) references public.inventory_pools (organization_id, id),
  foreign key (organization_id, connection_id) references public.channel_connections (organization_id, id)
);
create unique index inventory_holds_ref_uq on public.inventory_holds
  (organization_id, connection_id, reference) nulls not distinct;
create index inventory_holds_active_idx on public.inventory_holds (inventory_pool_id, expires_at)
  where status = 'active';

do $$
declare t text;
begin
  foreach t in array array['tours', 'tour_options', 'inventory_pools', 'departures', 'customers',
    'suppliers', 'guides', 'vehicles', 'channel_connections', 'channel_product_mappings', 'inventory_holds']
  loop
    execute format('create trigger %I before update on public.%I for each row execute function public.set_updated_at()',
      t || '_updated', t);
  end loop;
end $$;
