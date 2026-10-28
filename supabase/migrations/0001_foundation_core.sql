-- =============================================================================
-- 0001 — Foundation: extensions, enums, identity, tenancy, plans, features
-- Convention: money is stored in integer cents. All tenant rows carry
-- organization_id. Helpers live in schema "private" (not exposed by the API).
-- =============================================================================
create extension if not exists pgcrypto with schema public;
create extension if not exists btree_gist with schema public;
create extension if not exists citext with schema public;

create schema if not exists private;

create type public.org_status as enum ('trial', 'active', 'suspended', 'cancelled');
create type public.org_role as enum ('owner', 'manager', 'barber');
create type public.subscription_status as enum
  ('trialing', 'active', 'past_due', 'canceled', 'incomplete');
create type public.payment_status as enum
  ('pending', 'paid', 'failed', 'refunded', 'canceled');
create type public.feature_override as enum ('none', 'grant', 'block');

create or replace function private.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------- identity ---
-- profiles holds NO privilege data. Roles live in organization_members and
-- platform_admins, neither of which a user can write.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       citext,
  full_name   text,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index profiles_email_key on public.profiles (email);
create trigger profiles_updated before update on public.profiles
  for each row execute function private.set_updated_at();

-- Master administrators: granted only by migration/SQL console/service_role.
create table public.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  granted_at  timestamptz not null default now(),
  granted_by  text
);

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, nullif(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- --------------------------------------------------------- feature catalog ---
create table public.features (
  id                    uuid primary key default gen_random_uuid(),
  key                   text not null unique check (key ~ '^[a-z][a-z0-9_]*$'),
  name                  text not null,
  description           text,
  is_globally_enabled   boolean not null default true,
  sort_order            int not null default 0,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create trigger features_updated before update on public.features
  for each row execute function private.set_updated_at();

-- ------------------------------------------------------------ SaaS plans -----
create table public.saas_plans (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  description   text,
  price_cents   integer not null check (price_cents >= 0),
  billing_interval text not null default 'month' check (billing_interval in ('month','year')),
  trial_days    integer not null default 0 check (trial_days >= 0),
  limits        jsonb not null default '{}'::jsonb,   -- e.g. {"barbers":3,"units":1}
  is_active     boolean not null default true,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create trigger saas_plans_updated before update on public.saas_plans
  for each row execute function private.set_updated_at();

create table public.saas_plan_features (
  plan_id     uuid not null references public.saas_plans (id) on delete cascade,
  feature_id  uuid not null references public.features (id) on delete cascade,
  primary key (plan_id, feature_id)
);

-- ------------------------------------------------------------- tenancy -------
create table public.organizations (
  id              uuid primary key default gen_random_uuid(),
  name            text not null check (length(btrim(name)) between 2 and 120),
  slug            citext not null unique
                  check (slug ~ '^[a-z0-9]([a-z0-9-]{1,48}[a-z0-9])$'),
  status          public.org_status not null default 'trial',
  plan_id         uuid references public.saas_plans (id),
  trial_starts_at timestamptz,
  trial_ends_at   timestamptz,
  limits          jsonb not null default '{}'::jsonb,  -- per-org overrides of plan limits
  suspended_at    timestamptz,
  suspension_reason text,
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index organizations_status_idx on public.organizations (status);
create trigger organizations_updated before update on public.organizations
  for each row execute function private.set_updated_at();

create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            public.org_role not null,
  permissions     jsonb not null default '{}'::jsonb,   -- fine-grained flags for managers
  is_active       boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);
create index organization_members_user_idx on public.organization_members (user_id);
create trigger organization_members_updated before update on public.organization_members
  for each row execute function private.set_updated_at();

create table public.organization_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  description     text,
  logo_path       text,
  primary_color   text not null default '#1c1917' check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  secondary_color text not null default '#b45309' check (secondary_color ~ '^#[0-9a-fA-F]{6}$'),
  address         text,
  phone           text,
  whatsapp        text,
  timezone        text not null default 'America/Sao_Paulo',
  opening_hours   jsonb not null default '{}'::jsonb,
  closed_dates    date[] not null default '{}',
  buffer_minutes  integer not null default 0 check (buffer_minutes between 0 and 120),
  cancellation_policy text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger organization_settings_updated before update on public.organization_settings
  for each row execute function private.set_updated_at();

-- Per-organization module configuration (layer 3). No row = follow the plan.
create table public.organization_features (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  feature_id      uuid not null references public.features (id) on delete cascade,
  enabled         boolean not null default true,
  override        public.feature_override not null default 'none',
  reason          text,
  updated_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now(),
  primary key (organization_id, feature_id)
);
create index organization_features_feature_idx on public.organization_features (feature_id);

-- ------------------------------------------------- SaaS billing (own plan) ---
create table public.saas_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  plan_id         uuid references public.saas_plans (id),
  provider        text not null,
  provider_subscription_id text,
  status          public.subscription_status not null default 'incomplete',
  current_period_end timestamptz,
  canceled_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (provider, provider_subscription_id)
);
create index saas_subscriptions_org_idx on public.saas_subscriptions (organization_id);
create trigger saas_subscriptions_updated before update on public.saas_subscriptions
  for each row execute function private.set_updated_at();

create table public.saas_payments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  subscription_id uuid references public.saas_subscriptions (id) on delete set null,
  provider        text not null,
  provider_payment_id text not null,
  amount_cents    integer not null check (amount_cents >= 0),
  status          public.payment_status not null default 'pending',
  paid_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (provider, provider_payment_id)
);
create index saas_payments_org_idx on public.saas_payments (organization_id);
create trigger saas_payments_updated before update on public.saas_payments
  for each row execute function private.set_updated_at();

-- Idempotent webhook inbox: the unique key makes replays harmless.
create table public.saas_webhook_events (
  provider      text not null,
  event_id      text not null,
  event_type    text not null,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  primary key (provider, event_id)
);

-- ------------------------------------------------------------- audit log -----
create table public.admin_audit_logs (
  id              bigint generated always as identity primary key,
  actor_id        uuid references auth.users (id) on delete set null,
  action          text not null,
  organization_id uuid references public.organizations (id) on delete set null,
  entity          text not null,
  entity_id       text,
  old_value       jsonb,
  new_value       jsonb,
  reason          text,
  created_at      timestamptz not null default now()
);
create index admin_audit_logs_org_idx on public.admin_audit_logs (organization_id, created_at desc);
create index admin_audit_logs_created_idx on public.admin_audit_logs (created_at desc);

create function private.audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'admin_audit_logs is append-only';
end $$;
create trigger admin_audit_logs_immutable before update or delete on public.admin_audit_logs
  for each row execute function private.audit_immutable();
