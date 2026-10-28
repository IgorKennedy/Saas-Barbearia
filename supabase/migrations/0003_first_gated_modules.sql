-- =============================================================================
-- 0003 — First tenant-scoped modules (services, customers, client plans) and
-- the public shop endpoint. They establish the pattern every later module
-- follows: RLS = membership + role + module enabled + organization operational.
-- =============================================================================
create table public.services (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (length(btrim(name)) > 0),
  description     text,
  price_cents     integer not null check (price_cents >= 0),
  duration_minutes integer not null check (duration_minutes between 5 and 600),
  variable_cost_cents integer not null default 0 check (variable_cost_cents >= 0),
  default_commission_pct numeric(5,2) not null default 0 check (default_commission_pct between 0 and 100),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index services_org_idx on public.services (organization_id);
create trigger services_updated before update on public.services
  for each row execute function private.set_updated_at();

create table public.customers (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (length(btrim(name)) > 0),
  phone           text not null,
  phone_normalized text not null check (phone_normalized ~ '^[0-9]{10,15}$'),
  email           citext,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, phone_normalized)
);
create trigger customers_updated before update on public.customers
  for each row execute function private.set_updated_at();

-- Plans a barbershop sells to ITS customers (distinct from saas_plans).
create table public.subscription_plans (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (length(btrim(name)) > 0),
  description     text,
  price_cents     integer not null check (price_cents >= 0),
  uses_per_period integer not null check (uses_per_period > 0),
  period_days     integer not null default 30 check (period_days > 0),
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index subscription_plans_org_idx on public.subscription_plans (organization_id);
create trigger subscription_plans_updated before update on public.subscription_plans
  for each row execute function private.set_updated_at();

alter table public.services enable row level security;
alter table public.customers enable row level security;
alter table public.subscription_plans enable row level security;

-- services: everyone in the org reads; owner/manager write.
create policy services_select on public.services for select to authenticated
  using (private.can_read_module(organization_id, 'services'));
create policy services_write on public.services for all to authenticated
  using (private.can_write_module(organization_id, 'services', array['owner','manager']::public.org_role[]))
  with check (private.can_write_module(organization_id, 'services', array['owner','manager']::public.org_role[]));

-- customers: all roles read and register (front-desk work); only owner/manager delete.
create policy customers_select on public.customers for select to authenticated
  using (private.can_read_module(organization_id, 'customers'));
create policy customers_insert on public.customers for insert to authenticated
  with check (private.can_write_module(organization_id, 'customers', array['owner','manager','barber']::public.org_role[]));
create policy customers_update on public.customers for update to authenticated
  using (private.can_write_module(organization_id, 'customers', array['owner','manager','barber']::public.org_role[]))
  with check (private.can_write_module(organization_id, 'customers', array['owner','manager','barber']::public.org_role[]));
create policy customers_delete on public.customers for delete to authenticated
  using (private.can_write_module(organization_id, 'customers', array['owner','manager']::public.org_role[]));

create policy client_plans_select on public.subscription_plans for select to authenticated
  using (private.can_read_module(organization_id, 'customer_plans'));
create policy client_plans_write on public.subscription_plans for all to authenticated
  using (private.can_write_module(organization_id, 'customer_plans', array['owner','manager']::public.org_role[]))
  with check (private.can_write_module(organization_id, 'customer_plans', array['owner','manager']::public.org_role[]));

grant select, insert, update, delete on public.services, public.customers,
  public.subscription_plans to authenticated;

-- Public shop page data. Only exposes what the module switches allow, and
-- nothing at all for suspended/cancelled organizations.
create function public.get_public_shop(p_slug text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare o public.organizations; s public.organization_settings;
begin
  select * into o from public.organizations where slug = lower(p_slug)::public.citext;
  if not found or not private.org_is_operational(o.id) then return null; end if;
  select * into s from public.organization_settings where organization_id = o.id;
  return jsonb_build_object(
    'name', o.name, 'slug', o.slug,
    'description', s.description, 'primary_color', s.primary_color,
    'secondary_color', s.secondary_color, 'address', s.address,
    'phone', s.phone, 'whatsapp', s.whatsapp, 'timezone', s.timezone,
    'services', case when private.feature_enabled(o.id, 'services') then coalesce((
        select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'description', v.description,
               'price_cents', v.price_cents, 'duration_minutes', v.duration_minutes) order by v.name)
        from public.services v where v.organization_id = o.id and v.is_active), '[]') else '[]'::jsonb end,
    'plans', case when private.feature_enabled(o.id, 'customer_plans') then coalesce((
        select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'description', p.description,
               'price_cents', p.price_cents, 'uses_per_period', p.uses_per_period) order by p.price_cents)
        from public.subscription_plans p where p.organization_id = o.id and p.is_active), '[]') else '[]'::jsonb end);
end $$;
revoke execute on function public.get_public_shop(text) from public;
grant execute on function public.get_public_shop(text) to anon, authenticated;

-- Re-assert default-deny for anon on tables created in this migration.
revoke all on all tables in schema public from anon;
