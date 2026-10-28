-- =============================================================================
-- 0004 — Operations: barbers, agenda, visits & return intervals, commissions,
-- shelf (products) & stock, sales, finance, client subscriptions, monthly report.
-- Money = integer cents. Business-critical writes go through SECURITY DEFINER
-- RPCs that re-check role + module + organization status and are transactional.
-- Commission precedence: barber×service > barber default > service default > 0.
-- =============================================================================
alter table public.organization_settings
  add column default_return_days   int not null default 30  check (default_return_days between 1 and 365),
  add column return_soon_days      int not null default 5   check (return_soon_days between 0 and 60),
  add column inactive_after_days   int not null default 90  check (inactive_after_days between 1 and 1000);
alter table public.services
  add column photo_paths text[] not null default '{}' check (cardinality(photo_paths) <= 10);
alter table public.customers
  add column marketing_consent boolean not null default false,
  add column marketing_consent_at timestamptz;
alter table public.services add unique (id, organization_id);
alter table public.customers add unique (id, organization_id);
alter table public.subscription_plans add unique (id, organization_id);

create type public.appt_status as enum ('scheduled','confirmed','in_progress','completed','cancelled','no_show');

-- ----------------------------------------------------------------- barbers ---
create table public.barbers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null,
  name text not null check (length(btrim(name)) > 0),
  phone text,
  commission_pct numeric(5,2) check (commission_pct between 0 and 100),
  product_commission_pct numeric(5,2) not null default 0 check (product_commission_pct between 0 and 100),
  work_hours jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index barbers_user_per_org on public.barbers (organization_id, user_id) where user_id is not null;
create trigger barbers_updated before update on public.barbers for each row execute function private.set_updated_at();

create table public.barber_services (
  barber_id uuid not null, service_id uuid not null, organization_id uuid not null,
  commission_pct numeric(5,2) check (commission_pct between 0 and 100),
  primary key (barber_id, service_id),
  foreign key (barber_id, organization_id) references public.barbers (id, organization_id) on delete cascade,
  foreign key (service_id, organization_id) references public.services (id, organization_id) on delete cascade
);
create table public.barber_time_off (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, barber_id uuid not null,
  starts_at timestamptz not null, ends_at timestamptz not null, reason text, check (ends_at > starts_at),
  foreign key (barber_id, organization_id) references public.barbers (id, organization_id) on delete cascade
);

-- ------------------------------------------------------------ appointments ---
create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null, barber_id uuid not null,
  starts_at timestamptz not null, ends_at timestamptz not null,
  status public.appt_status not null default 'scheduled',
  total_cents int not null default 0 check (total_cents >= 0),
  notes text, created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  unique (id, organization_id),
  foreign key (customer_id, organization_id) references public.customers (id, organization_id),
  foreign key (barber_id, organization_id) references public.barbers (id, organization_id),
  -- Race-proof: two simultaneous bookings for one barber can never overlap.
  exclude using gist (barber_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
    where (status in ('scheduled','confirmed','in_progress'))
);
create index appointments_org_start on public.appointments (organization_id, starts_at);
create trigger appointments_updated before update on public.appointments for each row execute function private.set_updated_at();

create table public.appointment_items (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  appointment_id uuid not null, service_id uuid not null,
  price_cents int not null check (price_cents >= 0), duration_minutes int not null check (duration_minutes > 0),
  variable_cost_cents int not null default 0,
  foreign key (appointment_id, organization_id) references public.appointments (id, organization_id) on delete cascade,
  foreign key (service_id, organization_id) references public.services (id, organization_id)
);

create table public.visits (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  customer_id uuid not null, barber_id uuid not null,
  appointment_id uuid not null unique, visited_at timestamptz not null,
  total_cents int not null check (total_cents >= 0), created_at timestamptz not null default now(),
  foreign key (customer_id, organization_id) references public.customers (id, organization_id),
  foreign key (appointment_id, organization_id) references public.appointments (id, organization_id)
);
create index visits_customer on public.visits (customer_id, visited_at);

create table public.customer_metrics (
  customer_id uuid primary key, organization_id uuid not null,
  visits_count int not null, first_visit_at timestamptz, last_visit_at timestamptz,
  avg_interval_days numeric(7,2), interval_count int not null default 0,
  next_expected_at timestamptz, is_estimate boolean not null default false, confidence text not null,
  total_spent_cents bigint not null default 0, avg_ticket_cents int not null default 0,
  updated_at timestamptz not null default now(),
  foreign key (customer_id, organization_id) references public.customers (id, organization_id) on delete cascade
);

create table public.customer_contacts (   -- remarketing log
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, customer_id uuid not null,
  channel text not null default 'whatsapp', message text not null, created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  foreign key (customer_id, organization_id) references public.customers (id, organization_id) on delete cascade
);

-- ----------------------------------------------------- shelf, stock, sales ---
create table public.products (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name text not null check (length(btrim(name)) > 0), sku text, image_path text, supplier text,
  cost_cents int not null default 0 check (cost_cents >= 0),
  price_cents int not null check (price_cents >= 0),
  stock_qty int not null default 0 check (stock_qty >= 0),         -- changed only by movements
  min_stock int not null default 0 check (min_stock >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, organization_id)
);
create unique index products_sku on public.products (organization_id, sku) where sku is not null;
create trigger products_updated before update on public.products for each row execute function private.set_updated_at();

create table public.sales (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid, barber_id uuid, total_cents int not null default 0, payment_method text not null default 'cash',
  status text not null default 'paid' check (status in ('paid','refunded')), idempotency_key text,
  created_by uuid references auth.users (id), created_at timestamptz not null default now(),
  unique (id, organization_id), unique (organization_id, idempotency_key)
);
create table public.sale_items (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, sale_id uuid not null, product_id uuid not null,
  qty int not null check (qty > 0), unit_price_cents int not null, unit_cost_cents int not null,
  foreign key (sale_id, organization_id) references public.sales (id, organization_id) on delete cascade,
  foreign key (product_id, organization_id) references public.products (id, organization_id)
);
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, product_id uuid not null,
  kind text not null check (kind in ('entry','sale','loss','adjustment','return')),
  qty int not null check (qty <> 0), unit_cost_cents int, reason text, sale_id uuid,
  created_by uuid references auth.users (id), created_at timestamptz not null default now(),
  check ((kind in ('entry','return') and qty > 0) or (kind in ('sale','loss') and qty < 0) or kind = 'adjustment'),
  foreign key (product_id, organization_id) references public.products (id, organization_id)
);
create function private.apply_movement() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.products set stock_qty = stock_qty + new.qty where id = new.product_id;   -- CHECK blocks negatives
  return new;
end $$;
create trigger inventory_apply after insert on public.inventory_movements for each row execute function private.apply_movement();
create function private.movements_append_only() returns trigger language plpgsql as $$ begin raise exception 'inventory_movements is append-only'; end $$;
create trigger inventory_immutable before update or delete on public.inventory_movements for each row execute function private.movements_append_only();

-- ------------------------------------------------------- finance, commissions
create table public.financial_transactions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations (id) on delete cascade,
  kind text not null check (kind in ('income','expense')), category text not null,
  description text, amount_cents int not null check (amount_cents > 0),
  status text not null default 'paid' check (status in ('paid','pending','canceled')),
  payment_method text, occurred_at timestamptz not null default now(), due_date date, paid_at timestamptz,
  source_type text, source_id uuid, created_by uuid references auth.users (id), created_at timestamptz not null default now()
);
create unique index fin_source_once on public.financial_transactions (organization_id, source_type, source_id) where source_id is not null;
create index fin_org_time on public.financial_transactions (organization_id, occurred_at);

create table public.commissions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations (id) on delete cascade,
  barber_id uuid not null, appointment_id uuid, appointment_item_id uuid unique, sale_id uuid, sale_item_id uuid unique,
  base_cents int not null, pct numeric(5,2) not null, amount_cents int not null, rule text not null,   -- snapshot at the time
  status text not null default 'pending' check (status in ('pending','paid','reversed')), paid_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (barber_id, organization_id) references public.barbers (id, organization_id)
);

-- --------------------------------------------------- client subscriptions ----
create table public.customer_subscriptions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, customer_id uuid not null, plan_id uuid not null,
  status text not null default 'active' check (status in ('active','past_due','canceled')),
  price_cents int not null, current_period_start timestamptz not null, current_period_end timestamptz not null,
  uses_in_period int not null default 0 check (uses_in_period >= 0), created_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (customer_id, organization_id) references public.customers (id, organization_id),
  foreign key (plan_id, organization_id) references public.subscription_plans (id, organization_id)
);
create table public.subscription_usage (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null, subscription_id uuid not null,
  appointment_id uuid not null unique, used_at timestamptz not null default now(),
  foreign key (subscription_id, organization_id) references public.customer_subscriptions (id, organization_id)
);

create table public.pricing_assumptions (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  fixed_costs_cents bigint not null default 0 check (fixed_costs_cents >= 0),
  monthly_capacity int not null default 100 check (monthly_capacity > 0),
  revenue_goal_cents bigint not null default 0 check (revenue_goal_cents >= 0),
  tax_pct numeric(5,2) not null default 0 check (tax_pct between 0 and 100),
  card_fee_pct numeric(5,2) not null default 0 check (card_fee_pct between 0 and 100),
  target_margin_pct numeric(5,2) not null default 20 check (target_margin_pct between 0 and 95),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- helpers ---
create function private.require_write(p_org uuid, p_key text, p_roles public.org_role[]) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.can_write_module(p_org, p_key, p_roles) then
    raise exception 'forbidden' using errcode = '42501'; end if;
end $$;
create function private.require_read(p_org uuid, p_key text, p_roles public.org_role[]) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.feature_enabled(p_org, p_key) or not private.has_org_role(p_org, p_roles) then
    raise exception 'forbidden' using errcode = '42501'; end if;
end $$;
create function private.is_self_barber(p_barber uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.barbers where id = p_barber and user_id = auth.uid());
$$;
-- owner/manager act on anyone; a barber only on their own agenda.
create function private.can_act_on_barber(p_org uuid, p_barber uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_org_role(p_org, array['owner','manager']::public.org_role[])
      or (private.has_org_role(p_org, array['barber']::public.org_role[]) and private.is_self_barber(p_barber));
$$;
create function private.resolve_commission(p_barber uuid, p_service uuid, out pct numeric, out rule text)
language plpgsql stable security definer set search_path = '' as $$
begin
  select commission_pct into pct from public.barber_services where barber_id = p_barber and service_id = p_service;
  if pct is not null then rule := 'barber_service'; return; end if;
  select commission_pct into pct from public.barbers where id = p_barber;
  if pct is not null then rule := 'barber_default'; return; end if;
  select default_commission_pct into pct from public.services where id = p_service;
  if pct is not null then rule := 'service_default'; return; end if;
  pct := 0; rule := 'none';
end $$;

-- Completion is the only way to reach status 'completed'.
create function private.guard_completed() returns trigger language plpgsql as $$
begin
  if new.status = 'completed' and old.status <> 'completed'
     and coalesce(current_setting('app.completing', true), 'off') <> 'on' then
    raise exception 'use complete_appointment()' using errcode = '42501'; end if;
  if old.status = 'completed' and new.status <> 'completed' then
    raise exception 'completed appointments cannot change status' using errcode = '22023'; end if;
  return new;
end $$;
create trigger appointments_guard before update on public.appointments for each row execute function private.guard_completed();

create function private.recalc_customer(p_customer uuid) returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid; v_def int; n int; f timestamptz; l timestamptz; spent bigint; avg_i numeric; ic int;
begin
  select organization_id into v_org from public.customers where id = p_customer;
  if v_org is null then return; end if;
  select coalesce((select default_return_days from public.organization_settings where organization_id = v_org), 30) into v_def;
  select count(*), min(visited_at), max(visited_at), coalesce(sum(total_cents), 0) into n, f, l, spent
    from public.visits where customer_id = p_customer;
  if n = 0 then delete from public.customer_metrics where customer_id = p_customer; return; end if;
  select avg(gap), count(gap) into avg_i, ic from (
    select extract(epoch from visited_at - lag(visited_at) over (order by visited_at)) / 86400 as gap
    from public.visits where customer_id = p_customer) g where gap is not null;
  insert into public.customer_metrics as m (customer_id, organization_id, visits_count, first_visit_at, last_visit_at,
      avg_interval_days, interval_count, next_expected_at, is_estimate, confidence, total_spent_cents, avg_ticket_cents)
  values (p_customer, v_org, n, f, l, round(avg_i, 2), ic,
      l + make_interval(secs => coalesce(avg_i, v_def) * 86400), ic = 0,
      case when ic = 0 then 'estimate' when ic = 1 then 'low' when ic < 4 then 'medium' else 'high' end,
      spent, (spent / n)::int)
  on conflict (customer_id) do update set visits_count = excluded.visits_count, first_visit_at = excluded.first_visit_at,
      last_visit_at = excluded.last_visit_at, avg_interval_days = excluded.avg_interval_days, interval_count = excluded.interval_count,
      next_expected_at = excluded.next_expected_at, is_estimate = excluded.is_estimate, confidence = excluded.confidence,
      total_spent_cents = excluded.total_spent_cents, avg_ticket_cents = excluded.avg_ticket_cents, updated_at = now();
end $$;

-- ------------------------------------------------------------------- RPCs ---
create function public.create_appointment(p_org uuid, p_customer uuid, p_barber uuid, p_starts timestamptz,
  p_service_ids uuid[], p_notes text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_dur int; v_total int; v_id uuid; v_n int;
begin
  perform private.require_write(p_org, 'agenda', array['owner','manager','barber']::public.org_role[]);
  if not private.can_act_on_barber(p_org, p_barber) then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(cardinality(p_service_ids), 0) = 0 then raise exception 'choose at least one service' using errcode = '22023'; end if;
  if not exists (select 1 from public.barbers where id = p_barber and organization_id = p_org and is_active) then
    raise exception 'barber not available' using errcode = '22023'; end if;
  select count(*), sum(s.duration_minutes), sum(s.price_cents) into v_n, v_dur, v_total
    from public.services s join public.barber_services bs on bs.service_id = s.id and bs.barber_id = p_barber
    where s.organization_id = p_org and s.is_active and s.id = any (p_service_ids);
  if v_n <> (select count(distinct x) from unnest(p_service_ids) x) then
    raise exception 'some services are unavailable for this barber' using errcode = '22023'; end if;
  if exists (select 1 from public.barber_time_off t where t.barber_id = p_barber
             and tstzrange(t.starts_at, t.ends_at, '[)') && tstzrange(p_starts, p_starts + make_interval(mins => v_dur), '[)')) then
    raise exception 'barber is off at this time' using errcode = '23P01'; end if;
  insert into public.appointments (organization_id, customer_id, barber_id, starts_at, ends_at, total_cents, notes, created_by)
  values (p_org, p_customer, p_barber, p_starts, p_starts + make_interval(mins => v_dur), v_total, p_notes, auth.uid())
  returning id into v_id;                                  -- overlap => exclusion violation (23P01)
  insert into public.appointment_items (organization_id, appointment_id, service_id, price_cents, duration_minutes, variable_cost_cents)
    select p_org, v_id, s.id, s.price_cents, s.duration_minutes, s.variable_cost_cents from public.services s where s.id = any (p_service_ids);
  return v_id;
end $$;

create function public.set_appointment_status(p_appt uuid, p_status public.appt_status) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.appointments;
begin
  if p_status = 'completed' then raise exception 'use complete_appointment()' using errcode = '22023'; end if;
  select * into a from public.appointments where id = p_appt for update;
  if not found then raise exception 'appointment not found' using errcode = 'P0002'; end if;
  perform private.require_write(a.organization_id, 'agenda', array['owner','manager','barber']::public.org_role[]);
  if not private.can_act_on_barber(a.organization_id, a.barber_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if a.status not in ('scheduled','confirmed','in_progress') then
    raise exception 'appointment is % and cannot change', a.status using errcode = '22023'; end if;
  update public.appointments set status = p_status where id = p_appt;
end $$;

create function public.reschedule_appointment(p_appt uuid, p_new_start timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
declare a public.appointments;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found then raise exception 'appointment not found' using errcode = 'P0002'; end if;
  perform private.require_write(a.organization_id, 'agenda', array['owner','manager','barber']::public.org_role[]);
  if not private.can_act_on_barber(a.organization_id, a.barber_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if a.status not in ('scheduled','confirmed') then raise exception 'appointment cannot be rescheduled' using errcode = '22023'; end if;
  update public.appointments set starts_at = p_new_start, ends_at = p_new_start + (a.ends_at - a.starts_at), status = 'scheduled' where id = p_appt;
end $$;

create function public.complete_appointment(p_appt uuid, p_payment_method text default 'cash', p_use_subscription boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare a public.appointments; v_visit uuid; it record; c record; sub public.customer_subscriptions; v_limit int;
begin
  select * into a from public.appointments where id = p_appt for update;
  if not found then raise exception 'appointment not found' using errcode = 'P0002'; end if;
  perform private.require_write(a.organization_id, 'agenda', array['owner','manager','barber']::public.org_role[]);
  if not private.can_act_on_barber(a.organization_id, a.barber_id) then raise exception 'forbidden' using errcode = '42501'; end if;
  if a.status = 'completed' then return (select id from public.visits where appointment_id = p_appt); end if;   -- idempotent
  if a.status not in ('scheduled','confirmed','in_progress') then
    raise exception 'appointment is % and cannot be completed', a.status using errcode = '22023'; end if;

  perform set_config('app.completing', 'on', true);
  update public.appointments set status = 'completed' where id = p_appt;
  perform set_config('app.completing', 'off', true);

  insert into public.visits (organization_id, customer_id, barber_id, appointment_id, visited_at, total_cents)
  values (a.organization_id, a.customer_id, a.barber_id, a.id, a.starts_at, a.total_cents) returning id into v_visit;

  for it in select * from public.appointment_items where appointment_id = p_appt loop
    select * into c from private.resolve_commission(a.barber_id, it.service_id);
    insert into public.commissions (organization_id, barber_id, appointment_id, appointment_item_id, base_cents, pct, amount_cents, rule)
    values (a.organization_id, a.barber_id, a.id, it.id, it.price_cents, c.pct, round(it.price_cents * c.pct / 100)::int, c.rule);
  end loop;

  if p_use_subscription then
    if not private.feature_enabled(a.organization_id, 'customer_plans') then raise exception 'forbidden' using errcode = '42501'; end if;
    select s.* into sub from public.customer_subscriptions s
      where s.customer_id = a.customer_id and s.organization_id = a.organization_id and s.status = 'active'
        and s.current_period_start <= a.starts_at and a.starts_at < s.current_period_end
      order by s.created_at limit 1 for update;
    if not found then raise exception 'no active subscription covers this appointment' using errcode = '22023'; end if;
    select uses_per_period into v_limit from public.subscription_plans where id = sub.plan_id;
    if sub.uses_in_period >= v_limit then raise exception 'subscription benefit limit reached' using errcode = '23514'; end if;
    insert into public.subscription_usage (organization_id, subscription_id, appointment_id) values (a.organization_id, sub.id, a.id);
    update public.customer_subscriptions set uses_in_period = uses_in_period + 1 where id = sub.id;
  elsif a.total_cents > 0 then
    insert into public.financial_transactions (organization_id, kind, category, description, amount_cents, status, payment_method, occurred_at, paid_at, source_type, source_id, created_by)
    values (a.organization_id, 'income', 'services', 'Atendimento', a.total_cents, 'paid', p_payment_method, a.starts_at, now(), 'appointment', a.id, auth.uid());
  end if;
  perform private.recalc_customer(a.customer_id);
  return v_visit;
end $$;

create function public.register_sale(p_org uuid, p_barber uuid, p_customer uuid, p_items jsonb,
  p_payment_method text default 'cash', p_key text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_sale uuid; v_total int := 0; r record; p public.products; v_pct numeric; v_si uuid;
begin
  perform private.require_write(p_org, 'product_sales', array['owner','manager','barber']::public.org_role[]);
  if not private.feature_enabled(p_org, 'inventory') then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_barber is not null and not private.can_act_on_barber(p_org, p_barber) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key is not null then
    select id into v_sale from public.sales where organization_id = p_org and idempotency_key = p_key;
    if found then return v_sale; end if;
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'sale needs items' using errcode = '22023'; end if;
  insert into public.sales (organization_id, customer_id, barber_id, payment_method, idempotency_key, created_by)
  values (p_org, p_customer, p_barber, p_payment_method, p_key, auth.uid()) returning id into v_sale;
  select coalesce(product_commission_pct, 0) into v_pct from public.barbers where id = p_barber and organization_id = p_org;
  v_pct := coalesce(v_pct, 0);
  for r in select (e ->> 'product_id')::uuid as pid, sum((e ->> 'qty')::int) as qty
           from jsonb_array_elements(p_items) e group by 1 order by 1 loop           -- ordered locks: no deadlocks
    if r.qty <= 0 then raise exception 'invalid quantity' using errcode = '22023'; end if;
    select * into p from public.products where id = r.pid and organization_id = p_org and is_active for update;
    if not found then raise exception 'product unavailable' using errcode = '22023'; end if;
    if p.stock_qty < r.qty then raise exception 'insufficient stock for %', p.name using errcode = '23514'; end if;
    insert into public.sale_items (organization_id, sale_id, product_id, qty, unit_price_cents, unit_cost_cents)
    values (p_org, v_sale, p.id, r.qty, p.price_cents, p.cost_cents) returning id into v_si;   -- price is server-side
    insert into public.inventory_movements (organization_id, product_id, kind, qty, unit_cost_cents, sale_id, created_by)
    values (p_org, p.id, 'sale', -r.qty, p.cost_cents, v_sale, auth.uid());
    v_total := v_total + p.price_cents * r.qty;
    if p_barber is not null and v_pct > 0 then
      insert into public.commissions (organization_id, barber_id, sale_id, sale_item_id, base_cents, pct, amount_cents, rule)
      values (p_org, p_barber, v_sale, v_si, p.price_cents * r.qty, v_pct, round(p.price_cents * r.qty * v_pct / 100)::int, 'product_default');
    end if;
  end loop;
  update public.sales set total_cents = v_total where id = v_sale;
  if v_total > 0 then
    insert into public.financial_transactions (organization_id, kind, category, description, amount_cents, status, payment_method, paid_at, source_type, source_id, created_by)
    values (p_org, 'income', 'products', 'Venda de produtos', v_total, 'paid', p_payment_method, now(), 'sale', v_sale, auth.uid());
  end if;
  return v_sale;
end $$;

create function public.refund_sale(p_sale uuid) returns void language plpgsql security definer set search_path = '' as $$
declare s public.sales; r record;
begin
  select * into s from public.sales where id = p_sale for update;
  if not found then raise exception 'sale not found' using errcode = 'P0002'; end if;
  perform private.require_write(s.organization_id, 'product_sales', array['owner','manager']::public.org_role[]);
  if s.status = 'refunded' then return; end if;                                    -- idempotent
  update public.sales set status = 'refunded' where id = p_sale;
  for r in select * from public.sale_items where sale_id = p_sale loop
    insert into public.inventory_movements (organization_id, product_id, kind, qty, unit_cost_cents, sale_id, reason, created_by)
    values (s.organization_id, r.product_id, 'return', r.qty, r.unit_cost_cents, p_sale, 'refund', auth.uid());
  end loop;
  update public.commissions set status = 'reversed' where sale_id = p_sale and status = 'pending';
  update public.financial_transactions set status = 'canceled' where organization_id = s.organization_id and source_type = 'sale' and source_id = p_sale;
end $$;

create function public.pay_commissions(p_org uuid, p_barber uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_sum int;
begin
  perform private.require_write(p_org, 'commissions', array['owner','manager']::public.org_role[]);
  perform 1 from public.commissions where organization_id = p_org and barber_id = p_barber and status = 'pending' for update;
  select coalesce(sum(amount_cents), 0) into v_sum from public.commissions
    where organization_id = p_org and barber_id = p_barber and status = 'pending';
  if v_sum = 0 then return 0; end if;
  update public.commissions set status = 'paid', paid_at = now() where organization_id = p_org and barber_id = p_barber and status = 'pending';
  insert into public.financial_transactions (organization_id, kind, category, description, amount_cents, status, paid_at, source_type, source_id, created_by)
  values (p_org, 'expense', 'commissions', 'Pagamento de comissões', v_sum, 'paid', now(), 'commission_payment', gen_random_uuid(), auth.uid());
  return v_sum;
end $$;

create function public.subscribe_customer(p_org uuid, p_customer uuid, p_plan uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare pl public.subscription_plans; v_id uuid;
begin
  perform private.require_write(p_org, 'customer_plans', array['owner','manager']::public.org_role[]);
  select * into pl from public.subscription_plans where id = p_plan and organization_id = p_org and is_active;
  if not found then raise exception 'plan unavailable' using errcode = '22023'; end if;
  insert into public.customer_subscriptions (organization_id, customer_id, plan_id, price_cents, current_period_start, current_period_end)
  values (p_org, p_customer, p_plan, pl.price_cents, now(), now() + make_interval(days => pl.period_days)) returning id into v_id;
  insert into public.financial_transactions (organization_id, kind, category, description, amount_cents, status, source_type, source_id, created_by)
  values (p_org, 'income', 'subscriptions', 'Assinatura de cliente', pl.price_cents, 'pending', 'subscription_charge', v_id, auth.uid());
  return v_id;
end $$;

-- Manual reconciliation of a pending receipt (no card data is ever stored).
create function public.confirm_receipt(p_tx uuid) returns void language plpgsql security definer set search_path = '' as $$
declare t public.financial_transactions;
begin
  select * into t from public.financial_transactions where id = p_tx for update;
  if not found then raise exception 'transaction not found' using errcode = 'P0002'; end if;
  perform private.require_write(t.organization_id, 'finance', array['owner','manager']::public.org_role[]);
  if t.status = 'pending' then update public.financial_transactions set status = 'paid', paid_at = now() where id = p_tx; end if;
end $$;

create function public.customer_return_status(p_org uuid)
returns table (customer_id uuid, name text, phone text, marketing_consent boolean, visits_count int, last_visit_at timestamptz,
               avg_interval_days numeric, next_expected_at timestamptz, is_estimate boolean, confidence text, status text)
language plpgsql stable security definer set search_path = '' as $$
declare v_soon int; v_inactive int;
begin
  perform private.require_read(p_org, 'customers', array['owner','manager','barber']::public.org_role[]);
  select return_soon_days, inactive_after_days into v_soon, v_inactive from public.organization_settings where organization_id = p_org;
  return query select c.id, c.name, c.phone, c.marketing_consent, coalesce(m.visits_count, 0), m.last_visit_at, m.avg_interval_days,
    m.next_expected_at, coalesce(m.is_estimate, false), coalesce(m.confidence, 'none'),
    case when m.last_visit_at is null then 'sem_visitas'
         when now() - m.last_visit_at > make_interval(days => v_inactive) then 'inativo'
         when now() > m.next_expected_at then 'atrasado'
         when now() >= m.next_expected_at - make_interval(days => v_soon) then 'proximo'
         else 'em_dia' end
  from public.customers c left join public.customer_metrics m on m.customer_id = c.id where c.organization_id = p_org;
end $$;

create function public.record_contact(p_org uuid, p_customer uuid, p_message text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform private.require_write(p_org, 'customers', array['owner','manager','barber']::public.org_role[]);
  if not exists (select 1 from public.customers where id = p_customer and organization_id = p_org and marketing_consent) then
    raise exception 'customer has not consented to marketing contact' using errcode = '22023'; end if;
  insert into public.customer_contacts (organization_id, customer_id, message, created_by) values (p_org, p_customer, p_message, auth.uid()) returning id into v_id;
  return v_id;
end $$;

-- Monthly managerial report. Cash view (received/paid) is kept apart from accrual (sold).
create function public.report_month(p_org uuid, p_month date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare tz text; t0 timestamptz; t1 timestamptz; j jsonb; v_rev bigint; v_var bigint; v_com bigint;
begin
  perform private.require_read(p_org, 'finance', array['owner','manager']::public.org_role[]);
  select coalesce((select timezone from public.organization_settings where organization_id = p_org), 'America/Sao_Paulo') into tz;
  t0 := (date_trunc('month', p_month)::timestamp) at time zone tz; t1 := t0 + interval '1 month';
  select coalesce(sum(amount_cents), 0) into v_rev from public.financial_transactions
    where organization_id = p_org and kind = 'income' and status <> 'canceled' and occurred_at >= t0 and occurred_at < t1;
  select coalesce(sum(ai.variable_cost_cents), 0) + coalesce((
      select sum(si.unit_cost_cents * si.qty) from public.sale_items si join public.sales s on s.id = si.sale_id
      where si.organization_id = p_org and s.status = 'paid' and s.created_at >= t0 and s.created_at < t1), 0)
    into v_var from public.appointment_items ai join public.visits v on v.appointment_id = ai.appointment_id
    where ai.organization_id = p_org and v.visited_at >= t0 and v.visited_at < t1;
  -- attribute each commission to the month of the service/sale it came from, not to when it was booked
  select coalesce(sum(c.amount_cents), 0) into v_com from public.commissions c
    left join public.visits v on v.appointment_id = c.appointment_id
    left join public.sales s on s.id = c.sale_id
    where c.organization_id = p_org and c.status <> 'reversed'
      and coalesce(v.visited_at, s.created_at) >= t0 and coalesce(v.visited_at, s.created_at) < t1;
  j := jsonb_build_object(
    'month', to_char(t0 at time zone tz, 'YYYY-MM'),
    'gross_revenue_cents', v_rev,
    'received_cents', (select coalesce(sum(amount_cents), 0) from public.financial_transactions where organization_id = p_org and kind = 'income' and status = 'paid' and paid_at >= t0 and paid_at < t1),
    'pending_income_cents', (select coalesce(sum(amount_cents), 0) from public.financial_transactions where organization_id = p_org and kind = 'income' and status = 'pending' and occurred_at >= t0 and occurred_at < t1),
    'expenses_paid_cents', (select coalesce(sum(amount_cents), 0) from public.financial_transactions where organization_id = p_org and kind = 'expense' and status = 'paid' and paid_at >= t0 and paid_at < t1),
    'variable_costs_cents', v_var, 'commissions_generated_cents', v_com,
    'contribution_margin_cents', v_rev - v_var - v_com,
    'revenue_by_category', coalesce((select jsonb_object_agg(category, s) from (select category, sum(amount_cents) s from public.financial_transactions where organization_id = p_org and kind = 'income' and status <> 'canceled' and occurred_at >= t0 and occurred_at < t1 group by 1) x), '{}'),
    'expenses_by_category', coalesce((select jsonb_object_agg(category, s) from (select category, sum(amount_cents) s from public.financial_transactions where organization_id = p_org and kind = 'expense' and status = 'paid' and paid_at >= t0 and paid_at < t1 group by 1) x), '{}'),
    'appointments', jsonb_build_object(
      'completed', (select count(*) from public.visits where organization_id = p_org and visited_at >= t0 and visited_at < t1),
      'cancelled', (select count(*) from public.appointments where organization_id = p_org and status = 'cancelled' and starts_at >= t0 and starts_at < t1),
      'no_show', (select count(*) from public.appointments where organization_id = p_org and status = 'no_show' and starts_at >= t0 and starts_at < t1)),
    'avg_ticket_cents', coalesce((select (sum(total_cents) / nullif(count(*), 0))::int from public.visits where organization_id = p_org and visited_at >= t0 and visited_at < t1), 0),
    'new_customers', (select count(*) from public.customer_metrics where organization_id = p_org and first_visit_at >= t0 and first_visit_at < t1),
    'returning_customers', (select count(distinct v.customer_id) from public.visits v join public.customer_metrics m on m.customer_id = v.customer_id where v.organization_id = p_org and v.visited_at >= t0 and v.visited_at < t1 and m.first_visit_at < t0),
    'by_barber', coalesce((select jsonb_agg(jsonb_build_object('barber', b.name, 'visits', x.n, 'revenue_cents', x.s) order by x.s desc) from (select barber_id, count(*) n, sum(total_cents) s from public.visits where organization_id = p_org and visited_at >= t0 and visited_at < t1 group by 1) x join public.barbers b on b.id = x.barber_id), '[]'),
    'by_service', coalesce((select jsonb_agg(jsonb_build_object('service', s.name, 'count', x.n, 'revenue_cents', x.r) order by x.r desc) from (select ai.service_id, count(*) n, sum(ai.price_cents) r from public.appointment_items ai join public.visits v on v.appointment_id = ai.appointment_id where ai.organization_id = p_org and v.visited_at >= t0 and v.visited_at < t1 group by 1) x join public.services s on s.id = x.service_id), '[]'),
    'top_products', coalesce((select jsonb_agg(jsonb_build_object('product', p.name, 'qty', x.q, 'revenue_cents', x.r) order by x.r desc) from (select si.product_id, sum(si.qty) q, sum(si.qty * si.unit_price_cents) r from public.sale_items si join public.sales s on s.id = si.sale_id where si.organization_id = p_org and s.status = 'paid' and s.created_at >= t0 and s.created_at < t1 group by 1) x join public.products p on p.id = x.product_id), '[]'));
  return j || jsonb_build_object('managerial_result_cents', (j ->> 'received_cents')::bigint - (j ->> 'expenses_paid_cents')::bigint);
end $$;

-- ------------------------------------------------------------- RLS policies --
-- helper: tenant table with module gate. read roles can SELECT; write roles can write (if write_roles given).
create procedure private.module_policies(p_table text, p_key text, p_read public.org_role[], p_write public.org_role[])
language plpgsql as $$
begin
  execute format('alter table public.%I enable row level security', p_table);
  execute format('create policy %I on public.%I for select to authenticated using (private.feature_enabled(organization_id, %L) and (private.has_org_role(organization_id, %L::public.org_role[]) or private.is_platform_admin()))',
                 p_table || '_sel', p_table, p_key, p_read);
  if p_write is not null then
    execute format('create policy %I on public.%I for all to authenticated using (private.can_write_module(organization_id, %L, %L::public.org_role[])) with check (private.can_write_module(organization_id, %L, %L::public.org_role[]))',
                   p_table || '_wr', p_table, p_key, p_write, p_key, p_write);
  end if;
end $$;
do $$ declare ALL_ public.org_role[] := array['owner','manager','barber']; OM public.org_role[] := array['owner','manager'];
begin
  call private.module_policies('barbers', 'barbers', ALL_, OM);
  call private.module_policies('barber_services', 'barbers', ALL_, OM);
  call private.module_policies('barber_time_off', 'agenda', ALL_, OM);
  call private.module_policies('appointment_items', 'agenda', OM, null);
  call private.module_policies('visits', 'customers', OM, null);
  call private.module_policies('customer_metrics', 'customers', ALL_, null);
  call private.module_policies('customer_contacts', 'customers', ALL_, null);
  call private.module_policies('products', 'inventory', ALL_, OM);
  call private.module_policies('inventory_movements', 'inventory', OM, null);
  call private.module_policies('sales', 'product_sales', OM, null);
  call private.module_policies('sale_items', 'product_sales', OM, null);
  call private.module_policies('financial_transactions', 'finance', OM, null);
  call private.module_policies('customer_subscriptions', 'customer_plans', OM, null);
  call private.module_policies('subscription_usage', 'customer_plans', OM, null);
  call private.module_policies('pricing_assumptions', 'pricing_calculator', OM, OM);
end $$;
-- barbers see only their own appointments and commissions; owner/manager see all.
alter table public.appointments enable row level security;
create policy appointments_sel on public.appointments for select to authenticated using (
  private.feature_enabled(organization_id, 'agenda') and (
    private.has_org_role(organization_id, array['owner','manager']::public.org_role[]) or private.is_self_barber(barber_id) or private.is_platform_admin()));
alter table public.commissions enable row level security;
create policy commissions_sel on public.commissions for select to authenticated using (
  private.feature_enabled(organization_id, 'commissions') and (
    private.has_org_role(organization_id, array['owner','manager']::public.org_role[]) or private.is_self_barber(barber_id) or private.is_platform_admin()));
-- manual finance entries only; system-generated rows (source_type not null) are immutable by users.
create policy finance_manual_ins on public.financial_transactions for insert to authenticated
  with check (source_type is null and private.can_write_module(organization_id, 'finance', array['owner','manager']::public.org_role[]));
create policy finance_manual_upd on public.financial_transactions for update to authenticated
  using (source_type is null and private.can_write_module(organization_id, 'finance', array['owner','manager']::public.org_role[]))
  with check (source_type is null);
create policy finance_manual_del on public.financial_transactions for delete to authenticated
  using (source_type is null and private.can_write_module(organization_id, 'finance', array['owner','manager']::public.org_role[]));
-- stock entries/losses/adjustments by owner/manager; sales movements only via register_sale.
create policy movements_ins on public.inventory_movements for insert to authenticated
  with check (kind in ('entry','loss','adjustment') and created_by = auth.uid()
              and private.can_write_module(organization_id, 'inventory', array['owner','manager']::public.org_role[]));
create policy subs_cancel on public.customer_subscriptions for update to authenticated
  using (private.can_write_module(organization_id, 'customer_plans', array['owner','manager']::public.org_role[]))
  with check (private.can_write_module(organization_id, 'customer_plans', array['owner','manager']::public.org_role[]));
create policy contacts_ins_none on public.customer_contacts for insert to authenticated with check (false);

-- ------------------------------------------------------ storage (Supabase) ---
-- Service photos & product images: bucket "shop-media", path "<organization_id>/<anything>".
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('shop-media', 'shop-media', true, 2097152, array['image/png','image/jpeg','image/webp']) on conflict (id) do nothing;
    execute $p$create policy shop_media_write on storage.objects for all to authenticated
      using (bucket_id = 'shop-media' and private.has_org_role(((storage.foldername(name))[1])::uuid, array['owner','manager']::public.org_role[]))
      with check (bucket_id = 'shop-media' and private.has_org_role(((storage.foldername(name))[1])::uuid, array['owner','manager']::public.org_role[]))$p$;
  end if;
end $$;

-- ----------------------------------------------------------------- grants ----
-- Supabase grants ALL on every new table to anon/authenticated by default, which would make
-- column-level restrictions meaningless. Reset to default-deny, then re-grant explicitly.
-- (Every future migration that adds tables must end with the same revoke/grant discipline.)
revoke all on all tables in schema public from anon, authenticated;
grant select on public.profiles, public.platform_admins, public.features, public.saas_plans, public.saas_plan_features,
  public.organizations, public.organization_members, public.organization_settings, public.organization_features,
  public.saas_subscriptions, public.saas_payments, public.admin_audit_logs to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
grant update (name, slug) on public.organizations to authenticated;
grant insert, delete on public.organization_members to authenticated;
grant update (role, permissions, is_active) on public.organization_members to authenticated;
grant update (description, logo_path, primary_color, secondary_color, address, phone, whatsapp, timezone, opening_hours,
  closed_dates, buffer_minutes, cancellation_policy, default_return_days, return_soon_days, inactive_after_days)
  on public.organization_settings to authenticated;
grant select, insert, update, delete on public.services, public.customers, public.subscription_plans to authenticated;
grant select on public.barbers, public.barber_services, public.barber_time_off, public.appointments, public.appointment_items,
  public.visits, public.customer_metrics, public.customer_contacts, public.products, public.inventory_movements, public.sales,
  public.sale_items, public.financial_transactions, public.commissions, public.customer_subscriptions, public.subscription_usage,
  public.pricing_assumptions to authenticated;
grant insert, update, delete on public.barbers, public.barber_services, public.barber_time_off, public.pricing_assumptions to authenticated;
grant insert (organization_id, name, sku, image_path, supplier, cost_cents, price_cents, min_stock, is_active) on public.products to authenticated;
grant update (name, sku, image_path, supplier, cost_cents, price_cents, min_stock, is_active) on public.products to authenticated;
grant delete on public.products to authenticated;
grant insert (organization_id, product_id, kind, qty, unit_cost_cents, reason, created_by) on public.inventory_movements to authenticated;
grant insert, update, delete on public.financial_transactions to authenticated;
grant update (status) on public.customer_subscriptions to authenticated;

revoke execute on all functions in schema public from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
grant execute on function public.get_public_shop(text) to anon, authenticated;
grant execute on function public.create_organization(text, text), public.my_enabled_features(uuid),
  public.admin_create_organization(text, text, uuid, text, int), public.admin_set_org_status(uuid, public.org_status, text),
  public.admin_set_org_plan(uuid, uuid, text), public.admin_set_org_trial(uuid, timestamptz, timestamptz, text),
  public.admin_set_org_limits(uuid, jsonb, text), public.admin_set_org_feature(uuid, text, boolean, public.feature_override, text),
  public.admin_set_feature_global(text, boolean, text), public.admin_save_plan(uuid, text, text, int, text, int, jsonb, boolean),
  public.admin_set_plan_features(uuid, text[]), public.admin_org_feature_matrix(uuid),
  public.create_appointment(uuid, uuid, uuid, timestamptz, uuid[], text), public.set_appointment_status(uuid, public.appt_status),
  public.reschedule_appointment(uuid, timestamptz), public.complete_appointment(uuid, text, boolean),
  public.register_sale(uuid, uuid, uuid, jsonb, text, text), public.refund_sale(uuid), public.pay_commissions(uuid, uuid),
  public.subscribe_customer(uuid, uuid, uuid), public.confirm_receipt(uuid), public.customer_return_status(uuid),
  public.record_contact(uuid, uuid, text), public.report_month(uuid, date)
  to authenticated;
