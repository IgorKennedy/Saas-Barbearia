-- =============================================================================
-- 0002 — Authorization helpers, RLS, Master RPCs (audited), seeds
-- All privileged mutations happen in SECURITY DEFINER functions that re-check
-- the caller in the database. The browser never needs service_role.
-- =============================================================================

-- ---------------------------------------------------------------- helpers ---
create function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid());
$$;

create function private.is_org_member(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = auth.uid() and m.is_active);
$$;

create function private.has_org_role(p_org uuid, p_roles public.org_role[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org and m.user_id = auth.uid()
      and m.is_active and m.role = any (p_roles));
$$;

create function private.shares_org_with(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members a
    join public.organization_members b on b.organization_id = a.organization_id
    where a.user_id = auth.uid() and a.is_active and b.user_id = p_user and b.is_active);
$$;

-- Operational = allowed to run the business (writes). Suspended/cancelled
-- organizations keep read access (export, reactivation) but cannot write.
create function private.org_is_operational(p_org uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organizations o
    where o.id = p_org
      and (o.status = 'active'
           or (o.status = 'trial' and (o.trial_ends_at is null or o.trial_ends_at > now()))));
$$;

-- Three layers: (1) global kill-switch, (2) plan allows, (3) organization switch.
-- Explicit Master override: 'grant' bypasses the plan, 'block' always denies.
-- The global switch can never be bypassed. Cancelled organizations get nothing.
create function private.feature_enabled(p_org uuid, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select f.is_globally_enabled
       and o.status <> 'cancelled'
       and case coalesce(ofe.override, 'none')
             when 'block' then false
             when 'grant' then true
             else coalesce(ofe.enabled, true) and exists (
               select 1 from public.saas_plan_features pf
               where pf.plan_id = o.plan_id and pf.feature_id = f.id)
           end
    from public.features f
    join public.organizations o on o.id = p_org
    left join public.organization_features ofe
      on ofe.organization_id = o.id and ofe.feature_id = f.id
    where f.key = p_key), false);
$$;

-- Read gate: member (or Master) AND module enabled.
create function private.can_read_module(p_org uuid, p_key text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.feature_enabled(p_org, p_key)
     and (private.is_org_member(p_org) or private.is_platform_admin());
$$;

-- Write gate: role allowed AND module enabled AND organization operational.
create function private.can_write_module(p_org uuid, p_key text, p_roles public.org_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select private.feature_enabled(p_org, p_key)
     and private.org_is_operational(p_org)
     and private.has_org_role(p_org, p_roles);
$$;

create function private.log_admin_action(
  p_action text, p_org uuid, p_entity text, p_entity_id text,
  p_old jsonb, p_new jsonb, p_reason text) returns void
language sql security definer set search_path = '' as $$
  insert into public.admin_audit_logs
    (actor_id, action, organization_id, entity, entity_id, old_value, new_value, reason)
  values (auth.uid(), p_action, p_org, p_entity, p_entity_id, p_old, p_new, p_reason);
$$;

create function private.require_master() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not private.is_platform_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

-- Never remove the last active owner of an organization.
create function private.protect_last_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'owner' and old.is_active
     and (tg_op = 'DELETE' or new.role <> 'owner' or not new.is_active)
     and exists (select 1 from public.organizations where id = old.organization_id)
     and not exists (
       select 1 from public.organization_members m
       where m.organization_id = old.organization_id and m.user_id <> old.user_id
         and m.role = 'owner' and m.is_active)
  then
    raise exception 'organization must keep at least one active owner' using errcode = '23514';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $$;
create trigger organization_members_last_owner
  before update or delete on public.organization_members
  for each row execute function private.protect_last_owner();

-- ------------------------------------------------------------------- RLS ----
alter table public.profiles              enable row level security;
alter table public.platform_admins       enable row level security;
alter table public.features              enable row level security;
alter table public.saas_plans            enable row level security;
alter table public.saas_plan_features    enable row level security;
alter table public.organizations         enable row level security;
alter table public.organization_members  enable row level security;
alter table public.organization_settings enable row level security;
alter table public.organization_features enable row level security;
alter table public.saas_subscriptions    enable row level security;
alter table public.saas_payments         enable row level security;
alter table public.saas_webhook_events   enable row level security;
alter table public.admin_audit_logs      enable row level security;

create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or private.is_platform_admin() or private.shares_org_with(id));
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy platform_admins_self on public.platform_admins for select to authenticated
  using (user_id = auth.uid());

create policy features_read on public.features for select to authenticated using (true);
create policy plans_read on public.saas_plans for select to authenticated
  using (is_active or private.is_platform_admin());
create policy plan_features_read on public.saas_plan_features for select to authenticated using (true);

create policy orgs_select on public.organizations for select to authenticated
  using (private.is_org_member(id) or private.is_platform_admin());
create policy orgs_update_owner on public.organizations for update to authenticated
  using (private.has_org_role(id, array['owner']::public.org_role[]))
  with check (private.has_org_role(id, array['owner']::public.org_role[]));

create policy members_select on public.organization_members for select to authenticated
  using (private.is_org_member(organization_id) or private.is_platform_admin());
create policy members_insert_owner on public.organization_members for insert to authenticated
  with check (private.has_org_role(organization_id, array['owner']::public.org_role[])
              and private.org_is_operational(organization_id));
create policy members_update_owner on public.organization_members for update to authenticated
  using (private.has_org_role(organization_id, array['owner']::public.org_role[]))
  with check (private.has_org_role(organization_id, array['owner']::public.org_role[]));
create policy members_delete_owner on public.organization_members for delete to authenticated
  using (private.has_org_role(organization_id, array['owner']::public.org_role[]));

create policy settings_select on public.organization_settings for select to authenticated
  using (private.is_org_member(organization_id) or private.is_platform_admin());
create policy settings_update on public.organization_settings for update to authenticated
  using (private.has_org_role(organization_id, array['owner','manager']::public.org_role[])
         and private.org_is_operational(organization_id))
  with check (private.has_org_role(organization_id, array['owner','manager']::public.org_role[]));

create policy org_features_select on public.organization_features for select to authenticated
  using (private.is_org_member(organization_id) or private.is_platform_admin());

create policy subscriptions_select on public.saas_subscriptions for select to authenticated
  using (private.has_org_role(organization_id, array['owner']::public.org_role[])
         or private.is_platform_admin());
create policy payments_select on public.saas_payments for select to authenticated
  using (private.has_org_role(organization_id, array['owner']::public.org_role[])
         or private.is_platform_admin());

create policy audit_select_master on public.admin_audit_logs for select to authenticated
  using (private.is_platform_admin());
-- saas_webhook_events: RLS on, no policy => only service_role (bypasses RLS).

-- ----------------------------------------------------- self-service signup ---
create function public.create_organization(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_plan public.saas_plans;
  v_org uuid;
begin
  if v_uid is null then raise exception 'unauthenticated' using errcode = '28000'; end if;
  if (select count(*) from public.organizations where created_by = v_uid) >= 3 then
    raise exception 'organization limit reached for this user' using errcode = '53400';
  end if;
  select * into v_plan from public.saas_plans where is_active order by sort_order, price_cents limit 1;
  insert into public.organizations (name, slug, status, plan_id, trial_starts_at, trial_ends_at, created_by)
  values (btrim(p_name), lower(btrim(p_slug)), 'trial', v_plan.id, now(),
          now() + make_interval(days => coalesce(v_plan.trial_days, 0)), v_uid)
  returning id into v_org;
  insert into public.organization_members (organization_id, user_id, role) values (v_org, v_uid, 'owner');
  insert into public.organization_settings (organization_id) values (v_org);
  return v_org;
end $$;

-- ------------------------------------------------------------ Master RPCs ----
create function public.admin_create_organization(
  p_name text, p_slug text, p_plan_id uuid, p_owner_email text, p_trial_days int default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid; v_org uuid; v_days int;
begin
  perform private.require_master();
  select id into v_owner from public.profiles where email = p_owner_email::public.citext;
  if v_owner is null then
    raise exception 'owner must sign up first: no user with that e-mail' using errcode = 'P0002';
  end if;
  v_days := coalesce(p_trial_days, (select trial_days from public.saas_plans where id = p_plan_id), 0);
  insert into public.organizations (name, slug, status, plan_id, trial_starts_at, trial_ends_at, created_by)
  values (btrim(p_name), lower(btrim(p_slug)), (case when v_days > 0 then 'trial' else 'active' end)::public.org_status,
          p_plan_id, now(), case when v_days > 0 then now() + make_interval(days => v_days) end, auth.uid())
  returning id into v_org;
  insert into public.organization_members (organization_id, user_id, role) values (v_org, v_owner, 'owner');
  insert into public.organization_settings (organization_id) values (v_org);
  perform private.log_admin_action('organization.create', v_org, 'organization', v_org::text,
    null, jsonb_build_object('name', p_name, 'slug', p_slug, 'plan_id', p_plan_id, 'owner', v_owner), null);
  return v_org;
end $$;

create function public.admin_set_org_status(p_org uuid, p_status public.org_status, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old public.organizations;
begin
  perform private.require_master();
  select * into v_old from public.organizations where id = p_org for update;
  if not found then raise exception 'organization not found' using errcode = 'P0002'; end if;
  if p_status = 'suspended' and nullif(btrim(p_reason), '') is null then
    raise exception 'a reason is required to suspend an account' using errcode = '22023';
  end if;
  update public.organizations set
    status = p_status,
    suspended_at = case when p_status = 'suspended' then now() else null end,
    suspension_reason = case when p_status = 'suspended' then p_reason else null end
  where id = p_org;
  perform private.log_admin_action('organization.status', p_org, 'organization', p_org::text,
    jsonb_build_object('status', v_old.status), jsonb_build_object('status', p_status), p_reason);
end $$;

create function public.admin_set_org_plan(p_org uuid, p_plan_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old uuid;
begin
  perform private.require_master();
  if not exists (select 1 from public.saas_plans where id = p_plan_id) then
    raise exception 'plan not found' using errcode = 'P0002';
  end if;
  select plan_id into v_old from public.organizations where id = p_org for update;
  update public.organizations set plan_id = p_plan_id where id = p_org;
  perform private.log_admin_action('organization.plan', p_org, 'organization', p_org::text,
    jsonb_build_object('plan_id', v_old), jsonb_build_object('plan_id', p_plan_id), p_reason);
end $$;

create function public.admin_set_org_trial(p_org uuid, p_starts timestamptz, p_ends timestamptz, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old public.organizations;
begin
  perform private.require_master();
  if p_ends is not null and p_starts is not null and p_ends < p_starts then
    raise exception 'trial end must be after start' using errcode = '22023';
  end if;
  select * into v_old from public.organizations where id = p_org for update;
  update public.organizations set trial_starts_at = p_starts, trial_ends_at = p_ends where id = p_org;
  perform private.log_admin_action('organization.trial', p_org, 'organization', p_org::text,
    jsonb_build_object('starts', v_old.trial_starts_at, 'ends', v_old.trial_ends_at),
    jsonb_build_object('starts', p_starts, 'ends', p_ends), p_reason);
end $$;

create function public.admin_set_org_limits(p_org uuid, p_limits jsonb, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old jsonb;
begin
  perform private.require_master();
  if jsonb_typeof(p_limits) <> 'object' then raise exception 'limits must be an object' using errcode = '22023'; end if;
  select limits into v_old from public.organizations where id = p_org for update;
  update public.organizations set limits = p_limits where id = p_org;
  perform private.log_admin_action('organization.limits', p_org, 'organization', p_org::text,
    v_old, p_limits, p_reason);
end $$;

create function public.admin_set_org_feature(
  p_org uuid, p_feature_key text, p_enabled boolean,
  p_override public.feature_override default 'none', p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_feature uuid; v_old jsonb; v_before boolean; v_after boolean;
begin
  perform private.require_master();
  select id into v_feature from public.features where key = p_feature_key;
  if v_feature is null then raise exception 'unknown feature %', p_feature_key using errcode = 'P0002'; end if;
  perform 1 from public.organizations where id = p_org for update;
  if not found then raise exception 'organization not found' using errcode = 'P0002'; end if;

  v_before := private.feature_enabled(p_org, p_feature_key);
  select to_jsonb(x) - 'organization_id' - 'feature_id' into v_old
    from (select enabled, override, reason from public.organization_features
          where organization_id = p_org and feature_id = v_feature) x;

  insert into public.organization_features (organization_id, feature_id, enabled, override, reason, updated_by)
  values (p_org, v_feature, p_enabled, p_override, p_reason, auth.uid())
  on conflict (organization_id, feature_id) do update
    set enabled = excluded.enabled, override = excluded.override,
        reason = excluded.reason, updated_by = excluded.updated_by, updated_at = now();

  v_after := private.feature_enabled(p_org, p_feature_key);
  perform private.log_admin_action('organization.feature', p_org, 'feature', p_feature_key,
    coalesce(v_old, '{}'::jsonb) || jsonb_build_object('effective', v_before),
    jsonb_build_object('enabled', p_enabled, 'override', p_override, 'effective', v_after), p_reason);
end $$;

create function public.admin_set_feature_global(p_key text, p_enabled boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_old boolean;
begin
  perform private.require_master();
  select is_globally_enabled into v_old from public.features where key = p_key for update;
  if not found then raise exception 'unknown feature %', p_key using errcode = 'P0002'; end if;
  update public.features set is_globally_enabled = p_enabled where key = p_key;
  perform private.log_admin_action('feature.global', null, 'feature', p_key,
    jsonb_build_object('enabled', v_old), jsonb_build_object('enabled', p_enabled), p_reason);
end $$;

create function public.admin_save_plan(
  p_id uuid, p_name text, p_description text, p_price_cents int,
  p_interval text, p_trial_days int, p_limits jsonb, p_is_active boolean)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_old jsonb;
begin
  perform private.require_master();
  if p_id is null then
    insert into public.saas_plans (name, description, price_cents, billing_interval, trial_days, limits, is_active)
    values (p_name, p_description, p_price_cents, p_interval, p_trial_days, coalesce(p_limits, '{}'), p_is_active)
    returning id into v_id;
    perform private.log_admin_action('plan.create', null, 'plan', v_id::text, null,
      jsonb_build_object('name', p_name, 'price_cents', p_price_cents), null);
  else
    select to_jsonb(p) into v_old from public.saas_plans p where id = p_id for update;
    if v_old is null then raise exception 'plan not found' using errcode = 'P0002'; end if;
    update public.saas_plans set name = p_name, description = p_description, price_cents = p_price_cents,
      billing_interval = p_interval, trial_days = p_trial_days, limits = coalesce(p_limits, '{}'),
      is_active = p_is_active where id = p_id;
    v_id := p_id;
    perform private.log_admin_action('plan.update', null, 'plan', v_id::text, v_old,
      jsonb_build_object('name', p_name, 'price_cents', p_price_cents, 'is_active', p_is_active), null);
  end if;
  return v_id;
end $$;

create function public.admin_set_plan_features(p_plan uuid, p_keys text[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_old text[]; v_unknown text[];
begin
  perform private.require_master();
  select array_agg(k) into v_unknown from unnest(p_keys) k
    where not exists (select 1 from public.features where key = k);
  if v_unknown is not null then raise exception 'unknown features: %', v_unknown using errcode = 'P0002'; end if;
  select coalesce(array_agg(f.key order by f.key), '{}') into v_old
    from public.saas_plan_features pf join public.features f on f.id = pf.feature_id where pf.plan_id = p_plan;
  delete from public.saas_plan_features where plan_id = p_plan;
  insert into public.saas_plan_features (plan_id, feature_id)
    select p_plan, id from public.features where key = any (p_keys);
  perform private.log_admin_action('plan.features', null, 'plan', p_plan::text,
    to_jsonb(v_old), to_jsonb((select array_agg(k order by k) from unnest(p_keys) k)), null);
end $$;

-- Per-layer breakdown for the Master "modules" screen.
create function public.admin_org_feature_matrix(p_org uuid)
returns table (feature_key text, name text, globally_enabled boolean, plan_allows boolean,
               org_enabled boolean, override public.feature_override, reason text, effective boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.require_master();
  return query
  select f.key, f.name, f.is_globally_enabled,
         exists (select 1 from public.saas_plan_features pf where pf.plan_id = o.plan_id and pf.feature_id = f.id),
         coalesce(ofe.enabled, true), coalesce(ofe.override, 'none'), ofe.reason,
         private.feature_enabled(o.id, f.key)
  from public.features f
  join public.organizations o on o.id = p_org
  left join public.organization_features ofe on ofe.organization_id = o.id and ofe.feature_id = f.id
  order by f.sort_order, f.key;
end $$;

-- Menu source for members: keys of modules effectively enabled.
create function public.my_enabled_features(p_org uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(f.key order by f.sort_order), '{}')
  from public.features f
  where (private.is_org_member(p_org) or private.is_platform_admin())
    and private.feature_enabled(p_org, f.key);
$$;

-- ------------------------------------------------------------------ seeds ---
-- Catalog data (not demo business data). Prices are illustrative and editable.
insert into public.features (key, name, description, sort_order) values
 ('agenda','Agenda','Agenda e agendamentos',10),
 ('customers','Clientes','Cadastro e relacionamento com clientes',20),
 ('barbers','Barbeiros','Profissionais e horários',30),
 ('services','Serviços','Catálogo de serviços e preços',40),
 ('pricing_calculator','Calculadora de precificação','Custos, margem e preço sugerido',50),
 ('finance','Financeiro','Receitas, despesas e contas',60),
 ('commissions','Comissões','Regras e pagamento de comissões',70),
 ('inventory','Estoque','Produtos e movimentações',80),
 ('product_sales','Vendas de produtos','Venda de produtos com baixa de estoque',90),
 ('customer_plans','Planos de assinatura para clientes','Planos recorrentes oferecidos aos clientes da barbearia',100),
 ('upsell','Upsell','Sugestões de serviços complementares no agendamento',110),
 ('advanced_reports','Relatórios avançados','Relatórios gerenciais detalhados',120),
 ('automations','Automações','Lembretes e campanhas',130),
 ('extra_units','Unidades adicionais','Mais de uma unidade por empresa',140);

with p as (
  insert into public.saas_plans (name, description, price_cents, trial_days, limits, sort_order) values
   ('Essencial','Operação básica da barbearia',4990,14,'{"barbers":3,"units":1}',10),
   ('Profissional','Financeiro, estoque e comissões',9990,14,'{"barbers":10,"units":1}',20),
   ('Premium','Todos os módulos',16990,14,'{"barbers":50,"units":5}',30)
  returning id, name)
insert into public.saas_plan_features (plan_id, feature_id)
select p.id, f.id from p join public.features f on
  (p.name = 'Essencial'    and f.key in ('agenda','customers','barbers','services','pricing_calculator'))
  or (p.name = 'Profissional' and f.key in ('agenda','customers','barbers','services','pricing_calculator',
        'finance','commissions','inventory','product_sales','upsell'))
  or (p.name = 'Premium');

-- ----------------------------------------------------------------- grants ---
revoke all on all tables in schema public from anon, authenticated;
grant usage on schema public, private to authenticated;
grant usage on schema public to anon;
grant select on public.profiles, public.platform_admins, public.features, public.saas_plans,
  public.saas_plan_features, public.organizations, public.organization_members,
  public.organization_settings, public.organization_features, public.saas_subscriptions,
  public.saas_payments, public.admin_audit_logs to authenticated;
grant update (full_name, phone) on public.profiles to authenticated;
grant update (name, slug) on public.organizations to authenticated;
grant insert, delete on public.organization_members to authenticated;
grant update (role, permissions, is_active) on public.organization_members to authenticated;
grant update (description, logo_path, primary_color, secondary_color, address, phone, whatsapp,
  timezone, opening_hours, closed_dates, buffer_minutes, cancellation_policy)
  on public.organization_settings to authenticated;

revoke execute on all functions in schema public from public, anon;
revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;
grant execute on function public.create_organization(text, text),
  public.my_enabled_features(uuid),
  public.admin_create_organization(text, text, uuid, text, int),
  public.admin_set_org_status(uuid, public.org_status, text),
  public.admin_set_org_plan(uuid, uuid, text),
  public.admin_set_org_trial(uuid, timestamptz, timestamptz, text),
  public.admin_set_org_limits(uuid, jsonb, text),
  public.admin_set_org_feature(uuid, text, boolean, public.feature_override, text),
  public.admin_set_feature_global(text, boolean, text),
  public.admin_save_plan(uuid, text, text, int, text, int, jsonb, boolean),
  public.admin_set_plan_features(uuid, text[]),
  public.admin_org_feature_matrix(uuid)
  to authenticated;
