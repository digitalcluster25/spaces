alter table public.plans
  add column if not exists creem_test_product_id text,
  add column if not exists creem_live_product_id text;

create unique index if not exists plans_creem_test_product_unique
  on public.plans (creem_test_product_id) where creem_test_product_id is not null;
create unique index if not exists plans_creem_live_product_unique
  on public.plans (creem_live_product_id) where creem_live_product_id is not null;

create table if not exists public.billing_checkout_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  plan_id uuid not null references public.plans(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  mode text not null check (mode in ('test', 'live')),
  seats integer not null check (seats > 0),
  status text not null default 'prepared' check (status in ('prepared', 'created', 'completed', 'failed')),
  creem_checkout_id text unique,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists billing_checkout_requests_account_created_idx
  on public.billing_checkout_requests (account_id, created_at desc);

create table if not exists public.billing_webhook_events (
  external_event_id text primary key,
  mode text not null check (mode in ('test', 'live')),
  event_type text not null,
  payload_sha256 text not null check (length(payload_sha256) = 64),
  account_id uuid references public.accounts(id) on delete set null,
  processed_at timestamptz not null default now()
);

alter table public.billing_checkout_requests enable row level security;
alter table public.billing_webhook_events enable row level security;

create policy "Account owners can read billing checkouts"
  on public.billing_checkout_requests for select
  using (public.is_account_owner(account_id));

create policy "Superadmin can read billing webhooks"
  on public.billing_webhook_events for select
  using (public.is_superadmin());

create or replace function public.prepare_billing_checkout(
  p_account_id uuid,
  p_plan_code text,
  p_seats integer,
  p_mode text
)
returns table (
  checkout_request_id uuid,
  product_id text,
  account_name text,
  user_email text,
  seats integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_plan public.plans;
  target_account public.accounts;
  requested_seats integer;
  result_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_mode not in ('test', 'live') then raise exception 'Invalid billing mode'; end if;
  if not public.is_account_owner(p_account_id) then raise exception 'Account owner access required'; end if;

  select * into target_account from public.accounts where id = p_account_id and status = 'active';
  if target_account.id is null then raise exception 'Active account not found'; end if;

  select * into target_plan
  from public.plans
  where code = p_plan_code and is_active and is_public and code in ('golden', 'corporate');
  if target_plan.id is null then raise exception 'Billable plan not found'; end if;

  requested_seats := case when target_plan.billing_mode = 'seat' then greatest(p_seats, 1) else 1 end;
  if (p_mode = 'test' and target_plan.creem_test_product_id is null)
    or (p_mode = 'live' and target_plan.creem_live_product_id is null) then
    raise exception 'Creem product is not configured for this plan';
  end if;

  insert into public.billing_checkout_requests (account_id, plan_id, user_id, mode, seats)
  values (p_account_id, target_plan.id, auth.uid(), p_mode, requested_seats)
  returning id into result_id;

  insert into public.audit_events (account_id, actor_id, action, target_type, target_id, metadata)
  values (p_account_id, auth.uid(), 'billing.checkout.prepared', 'billing_checkout', result_id::text,
    jsonb_build_object('plan', target_plan.code, 'mode', p_mode, 'seats', requested_seats));

  return query select result_id,
    case when p_mode = 'test' then target_plan.creem_test_product_id else target_plan.creem_live_product_id end,
    target_account.name,
    (select email from public.profiles where id = auth.uid()),
    requested_seats;
end;
$$;

create or replace function public.complete_billing_checkout(
  p_checkout_request_id uuid,
  p_creem_checkout_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.billing_checkout_requests
  set status = 'created', creem_checkout_id = p_creem_checkout_id, error_code = null, updated_at = now()
  where id = p_checkout_request_id and status = 'prepared';
  if not found then raise exception 'Prepared checkout not found'; end if;
end;
$$;

create or replace function public.fail_billing_checkout(
  p_checkout_request_id uuid,
  p_error_code text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  update public.billing_checkout_requests
  set status = 'failed', error_code = left(coalesce(p_error_code, 'provider_error'), 120), updated_at = now()
  where id = p_checkout_request_id and status = 'prepared';
end;
$$;

create or replace function public.apply_creem_webhook(
  p_event_id text,
  p_mode text,
  p_event_type text,
  p_payload_sha256 text,
  p_account_id uuid,
  p_plan_code text,
  p_product_id text,
  p_customer_id text,
  p_subscription_id text,
  p_subscription_status text,
  p_seats integer,
  p_period_end timestamptz,
  p_trial_ends_at timestamptz,
  p_checkout_request_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  target_account_id uuid := p_account_id;
  target_plan public.plans;
  target_status text;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_mode not in ('test', 'live') then raise exception 'Invalid billing mode'; end if;
  if coalesce(p_event_id, '') = '' or coalesce(p_payload_sha256, '') = '' then raise exception 'Invalid webhook event'; end if;

  if exists (select 1 from public.billing_webhook_events where external_event_id = p_event_id) then
    return false;
  end if;

  if target_account_id is null and p_subscription_id is not null then
    select account_id into target_account_id
    from public.account_subscriptions where creem_subscription_id = p_subscription_id;
  end if;
  if target_account_id is null then raise exception 'Webhook account is missing'; end if;

  select * into target_plan from public.plans
  where (p_plan_code is null or code = p_plan_code)
    and ((p_mode = 'test' and creem_test_product_id = p_product_id)
      or (p_mode = 'live' and creem_live_product_id = p_product_id));
  if target_plan.id is null then raise exception 'Webhook plan or product mismatch'; end if;

  if p_checkout_request_id is not null then
    update public.billing_checkout_requests
    set status = case when p_event_type = 'checkout.completed' then 'completed' else status end,
        updated_at = now()
    where id = p_checkout_request_id
      and account_id = target_account_id
      and plan_id = target_plan.id
      and mode = p_mode;
    if not found then raise exception 'Checkout request mismatch'; end if;
  end if;

  target_status := case p_event_type
    when 'subscription.trialing' then 'trialing'
    when 'subscription.active' then 'active'
    when 'subscription.paid' then 'active'
    when 'subscription.update' then case p_subscription_status
      when 'trialing' then 'trialing' when 'active' then 'active' when 'scheduled_cancel' then 'active'
      when 'past_due' then 'past_due' when 'unpaid' then 'past_due' when 'paused' then 'paused'
      when 'canceled' then 'canceled' when 'expired' then 'expired' else null end
    when 'subscription.scheduled_cancel' then 'active'
    when 'subscription.past_due' then 'past_due'
    when 'subscription.unpaid' then 'past_due'
    when 'subscription.paused' then 'paused'
    when 'refund.created' then 'paused'
    when 'dispute.created' then 'paused'
    when 'subscription.canceled' then 'canceled'
    when 'subscription.expired' then 'expired'
    when 'checkout.completed' then case p_subscription_status
      when 'trialing' then 'trialing' when 'active' then 'active' else null end
    else null
  end;

  if target_status is not null then
    insert into public.account_subscriptions (
      account_id, plan_id, status, seats, creem_customer_id, creem_subscription_id,
      current_period_end, trial_ends_at
    ) values (
      target_account_id, target_plan.id, target_status, greatest(coalesce(p_seats, 1), 1),
      p_customer_id, p_subscription_id, p_period_end, p_trial_ends_at
    ) on conflict (account_id) do update set
      plan_id = excluded.plan_id,
      status = excluded.status,
      seats = excluded.seats,
      creem_customer_id = coalesce(excluded.creem_customer_id, account_subscriptions.creem_customer_id),
      creem_subscription_id = coalesce(excluded.creem_subscription_id, account_subscriptions.creem_subscription_id),
      current_period_end = coalesce(excluded.current_period_end, account_subscriptions.current_period_end),
      trial_ends_at = coalesce(excluded.trial_ends_at, account_subscriptions.trial_ends_at),
      updated_at = now();
  end if;

  insert into public.billing_webhook_events (external_event_id, mode, event_type, payload_sha256, account_id)
  values (p_event_id, p_mode, p_event_type, p_payload_sha256, target_account_id);
  insert into public.audit_events (account_id, action, target_type, target_id, metadata)
  values (target_account_id, 'billing.webhook.processed', 'billing_event', p_event_id,
    jsonb_build_object('event_type', p_event_type, 'mode', p_mode, 'plan', target_plan.code));
  return true;
end;
$$;

create or replace function public.admin_update_plan_billing(
  p_plan_code text,
  p_creem_test_product_id text,
  p_creem_live_product_id text
)
returns public.plans
language plpgsql
security definer
set search_path = public
as $$
declare
  result public.plans;
begin
  if not public.is_superadmin() then raise exception 'Superadmin AAL2 access required'; end if;
  update public.plans set
    creem_test_product_id = nullif(trim(p_creem_test_product_id), ''),
    creem_live_product_id = nullif(trim(p_creem_live_product_id), ''),
    updated_at = now()
  where code = p_plan_code and code in ('golden', 'corporate')
  returning * into result;
  if result.id is null then raise exception 'Billable plan not found'; end if;
  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), 'plan.billing.updated', 'plan', result.id::text,
    jsonb_build_object('plan', result.code, 'test_configured', result.creem_test_product_id is not null, 'live_configured', result.creem_live_product_id is not null));
  return result;
end;
$$;

revoke all on public.billing_checkout_requests from public, anon, authenticated;
revoke all on public.billing_webhook_events from public, anon, authenticated;
grant select on public.billing_checkout_requests to authenticated;
grant select on public.billing_webhook_events to authenticated;

revoke execute on function public.prepare_billing_checkout(uuid, text, integer, text) from public, anon;
revoke execute on function public.complete_billing_checkout(uuid, text) from public, anon, authenticated;
revoke execute on function public.fail_billing_checkout(uuid, text) from public, anon, authenticated;
revoke execute on function public.apply_creem_webhook(text, text, text, text, uuid, text, text, text, text, text, integer, timestamptz, timestamptz, uuid) from public, anon, authenticated;
revoke execute on function public.admin_update_plan_billing(text, text, text) from public, anon;

grant execute on function public.prepare_billing_checkout(uuid, text, integer, text) to authenticated;
grant execute on function public.complete_billing_checkout(uuid, text) to service_role;
grant execute on function public.fail_billing_checkout(uuid, text) to service_role;
grant execute on function public.apply_creem_webhook(text, text, text, text, uuid, text, text, text, text, text, integer, timestamptz, timestamptz, uuid) to service_role;
grant execute on function public.admin_update_plan_billing(text, text, text) to authenticated;
