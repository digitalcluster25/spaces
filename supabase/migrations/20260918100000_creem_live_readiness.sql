alter table public.account_subscriptions
  add column if not exists provider_mode text check (provider_mode in ('test', 'live')),
  add column if not exists grace_ends_at timestamptz,
  add column if not exists last_billing_event_at timestamptz;

alter table public.billing_webhook_events
  add column if not exists provider_created_at timestamptz,
  add column if not exists applied boolean not null default false,
  add column if not exists ignore_reason text;

with latest_event as (
  select distinct on (account_id)
    account_id,
    mode,
    coalesce(provider_created_at, processed_at) as created_at
  from public.billing_webhook_events
  where account_id is not null
  order by account_id, processed_at desc
)
update public.account_subscriptions subscription
set provider_mode = latest_event.mode,
    last_billing_event_at = latest_event.created_at
from latest_event
where subscription.account_id = latest_event.account_id
  and subscription.provider_mode is null;

insert into public.plan_limits (plan_id, key, value, unit, status, description)
select id, 'billing_grace_days', 7, 'days', 'active', 'Льготный период после сбоя оплаты'
from public.plans
where code in ('golden', 'corporate')
on conflict (plan_id, key) do nothing;

create or replace function public.account_has_billing_access(check_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.account_subscriptions subscription
    join public.plans plan on plan.id = subscription.plan_id
    where subscription.account_id = check_account_id
      and (
        plan.billing_mode = 'internal'
        or subscription.status = 'active'
        or (subscription.status = 'trialing' and subscription.trial_ends_at > now())
        or (subscription.status = 'canceled' and subscription.current_period_end > now())
        or (subscription.status in ('past_due', 'expired') and subscription.grace_ends_at > now())
      )
  );
$$;

create or replace function public.effective_account_limit(check_account_id uuid, limit_key text)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select case
    when limit_key <> 'archive_retention_days' and not public.account_has_billing_access(check_account_id) then 0
    else coalesce(
      (select value from public.account_limit_overrides where account_id = check_account_id and key = limit_key),
      (
        select plan_limit.value
        from public.account_subscriptions subscription
        join public.plan_limits plan_limit on plan_limit.plan_id = subscription.plan_id
        where subscription.account_id = check_account_id
          and plan_limit.key = limit_key
          and plan_limit.status = 'active'
      )
    )
  end;
$$;

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
  active_members integer;
  result_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_mode not in ('test', 'live') then raise exception 'Invalid billing mode'; end if;
  if p_seats is null or p_seats < 1 or p_seats > 1000 then raise exception 'Seats must be from 1 to 1000'; end if;
  if not public.is_account_owner(p_account_id) then raise exception 'Account owner access required'; end if;

  select * into target_account from public.accounts where id = p_account_id and status = 'active';
  if target_account.id is null then raise exception 'Active account not found'; end if;

  select * into target_plan
  from public.plans
  where code = p_plan_code and is_active and is_public and code in ('golden', 'corporate');
  if target_plan.id is null then raise exception 'Billable plan not found'; end if;

  select count(*) into active_members
  from public.account_memberships
  where account_id = p_account_id and status = 'active';
  requested_seats := case when target_plan.billing_mode = 'seat' then greatest(p_seats, active_members, 1) else 1 end;

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

create or replace function public.prepare_billing_portal(p_account_id uuid, p_mode text)
returns table (customer_id text)
language plpgsql
security definer
set search_path = public
as $$
declare
  subscription public.account_subscriptions;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_mode not in ('test', 'live') then raise exception 'Invalid billing mode'; end if;
  if not public.is_account_owner(p_account_id) then raise exception 'Account owner access required'; end if;

  select * into subscription
  from public.account_subscriptions
  where account_id = p_account_id;
  if subscription.creem_customer_id is null then raise exception 'Creem customer is not connected'; end if;
  if subscription.provider_mode is distinct from p_mode then raise exception 'Subscription belongs to another billing mode'; end if;

  insert into public.audit_events (account_id, actor_id, action, target_type, target_id, metadata)
  values (p_account_id, auth.uid(), 'billing.portal.prepared', 'subscription', p_account_id::text,
    jsonb_build_object('mode', p_mode));

  return query select subscription.creem_customer_id;
end;
$$;

drop function if exists public.apply_creem_webhook(text, text, text, text, uuid, text, text, text, text, text, integer, timestamptz, timestamptz, uuid);

create or replace function public.apply_creem_webhook(
  p_event_id text,
  p_mode text,
  p_event_type text,
  p_payload_sha256 text,
  p_event_created_at timestamptz,
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
  current_subscription public.account_subscriptions;
  target_status text;
  grace_days bigint := 7;
  target_grace_ends_at timestamptz;
  inserted_event boolean;
begin
  if auth.role() <> 'service_role' then raise exception 'Service role required'; end if;
  if p_mode not in ('test', 'live') then raise exception 'Invalid billing mode'; end if;
  if coalesce(p_event_id, '') = '' or coalesce(p_payload_sha256, '') = '' or p_event_created_at is null then
    raise exception 'Invalid webhook event';
  end if;

  if target_account_id is null and p_subscription_id is not null then
    select account_id into target_account_id
    from public.account_subscriptions
    where creem_subscription_id = p_subscription_id;
  end if;
  if target_account_id is null and p_checkout_request_id is not null then
    select account_id into target_account_id
    from public.billing_checkout_requests
    where id = p_checkout_request_id and mode = p_mode;
  end if;
  if target_account_id is null then raise exception 'Webhook account is missing'; end if;

  select * into current_subscription
  from public.account_subscriptions
  where account_id = target_account_id
  for update;

  if p_product_id is not null then
    select * into target_plan from public.plans
    where (p_plan_code is null or code = p_plan_code)
      and ((p_mode = 'test' and creem_test_product_id = p_product_id)
        or (p_mode = 'live' and creem_live_product_id = p_product_id));
  elsif current_subscription.account_id is not null then
    select * into target_plan from public.plans where id = current_subscription.plan_id;
  end if;
  if target_plan.id is null then raise exception 'Webhook plan or product mismatch'; end if;

  insert into public.billing_webhook_events (
    external_event_id, mode, event_type, payload_sha256, account_id, provider_created_at
  ) values (
    p_event_id, p_mode, p_event_type, p_payload_sha256, target_account_id, p_event_created_at
  ) on conflict (external_event_id) do nothing
  returning true into inserted_event;
  if coalesce(inserted_event, false) is false then return false; end if;

  if current_subscription.last_billing_event_at is not null
    and p_event_created_at < current_subscription.last_billing_event_at then
    update public.billing_webhook_events
    set ignore_reason = 'stale_event'
    where external_event_id = p_event_id;
    insert into public.audit_events (account_id, action, target_type, target_id, metadata)
    values (target_account_id, 'billing.webhook.ignored', 'billing_event', p_event_id,
      jsonb_build_object('event_type', p_event_type, 'mode', p_mode, 'reason', 'stale_event'));
    return false;
  end if;

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
      when 'canceled' then 'canceled' when 'expired' then 'past_due' else null end
    when 'subscription.scheduled_cancel' then 'active'
    when 'subscription.past_due' then 'past_due'
    when 'subscription.unpaid' then 'past_due'
    when 'subscription.expired' then 'past_due'
    when 'subscription.paused' then 'paused'
    when 'refund.created' then 'paused'
    when 'dispute.created' then 'paused'
    when 'subscription.canceled' then 'canceled'
    when 'checkout.completed' then case p_subscription_status
      when 'trialing' then 'trialing' when 'active' then 'active' else null end
    else null
  end;

  select coalesce(value, 7) into grace_days
  from public.plan_limits
  where plan_id = target_plan.id and key = 'billing_grace_days';
  if target_status = 'past_due' then
    target_grace_ends_at := coalesce(p_period_end, now()) + make_interval(days => greatest(coalesce(grace_days, 7), 0)::integer);
  end if;

  if target_status is not null then
    insert into public.account_subscriptions (
      account_id, plan_id, status, seats, creem_customer_id, creem_subscription_id,
      current_period_end, trial_ends_at, provider_mode, grace_ends_at, last_billing_event_at
    ) values (
      target_account_id, target_plan.id, target_status, greatest(coalesce(p_seats, 1), 1),
      p_customer_id, p_subscription_id, p_period_end, p_trial_ends_at, p_mode,
      target_grace_ends_at, p_event_created_at
    ) on conflict (account_id) do update set
      plan_id = excluded.plan_id,
      status = excluded.status,
      seats = excluded.seats,
      creem_customer_id = coalesce(excluded.creem_customer_id, account_subscriptions.creem_customer_id),
      creem_subscription_id = coalesce(excluded.creem_subscription_id, account_subscriptions.creem_subscription_id),
      current_period_end = coalesce(excluded.current_period_end, account_subscriptions.current_period_end),
      trial_ends_at = case when excluded.status = 'trialing' then excluded.trial_ends_at else null end,
      provider_mode = excluded.provider_mode,
      grace_ends_at = excluded.grace_ends_at,
      last_billing_event_at = excluded.last_billing_event_at,
      updated_at = now();
  end if;

  update public.billing_webhook_events
  set applied = target_status is not null,
      ignore_reason = case when target_status is null then 'no_subscription_change' else null end
  where external_event_id = p_event_id;
  insert into public.audit_events (account_id, action, target_type, target_id, metadata)
  values (target_account_id, 'billing.webhook.processed', 'billing_event', p_event_id,
    jsonb_build_object('event_type', p_event_type, 'mode', p_mode, 'plan', target_plan.code, 'applied', target_status is not null));
  return target_status is not null;
end;
$$;

revoke execute on function public.account_has_billing_access(uuid) from public, anon, authenticated;
revoke execute on function public.prepare_billing_portal(uuid, text) from public, anon;
revoke execute on function public.apply_creem_webhook(text, text, text, text, timestamptz, uuid, text, text, text, text, text, integer, timestamptz, timestamptz, uuid) from public, anon, authenticated;

grant execute on function public.prepare_billing_portal(uuid, text) to authenticated;
grant execute on function public.apply_creem_webhook(text, text, text, text, timestamptz, uuid, text, text, text, text, text, integer, timestamptz, timestamptz, uuid) to service_role;
