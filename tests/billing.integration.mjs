import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;
if (!url || !anonKey || !serviceKey) throw new Error("Local Supabase integration environment is missing");

const service = createClient(url, serviceKey, { auth: { persistSession: false } });
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const password = `Spaces-${suffix}-Aa1!`;
const productId = `prod_test_${suffix}`;
const corporateProductId = `prod_corporate_${suffix}`;
const createdUserIds = [];
const eventBase = Date.now();
const eventTime = (offset) => new Date(eventBase + offset).toISOString();

function requireData(result, operation) {
  if (result.error) throw new Error(`${operation}: ${result.error.message}`);
  return result.data;
}

async function createUser(prefix) {
  const result = requireData(await service.auth.admin.createUser({ email: `${prefix}-${suffix}@example.com`, password, email_confirm: true }), `create ${prefix}`);
  createdUserIds.push(result.user.id);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  requireData(await client.auth.signInWithPassword({ email: result.user.email, password }), `sign in ${prefix}`);
  const membership = requireData(await service.from("account_memberships").select("account_id").eq("user_id", result.user.id).eq("role", "owner").single(), `load ${prefix} account`);
  return { client, accountId: membership.account_id, userId: result.user.id };
}

try {
  const owner = await createUser("billing-owner");
  const stranger = await createUser("billing-stranger");
  const golden = requireData(await service.from("plans").update({ creem_test_product_id: productId }).eq("code", "golden").select("id").single(), "configure golden product");
  requireData(await service.from("plans").update({ creem_test_product_id: corporateProductId }).eq("code", "corporate"), "configure corporate product");

  requireData(await service.from("account_memberships").insert({ account_id: owner.accountId, user_id: stranger.userId, role: "member", status: "active" }), "add corporate member");
  const corporateRows = requireData(await owner.client.rpc("prepare_billing_checkout", {
    p_account_id: owner.accountId, p_plan_code: "corporate", p_seats: 1, p_mode: "test",
  }), "prepare corporate checkout");
  assert.equal(corporateRows[0].seats, 2, "corporate checkout must cover every active account member");

  const forbidden = await stranger.client.rpc("prepare_billing_checkout", {
    p_account_id: owner.accountId, p_plan_code: "golden", p_seats: 1, p_mode: "test",
  });
  assert(forbidden.error, "a different account owner must not create the checkout");

  const preparedRows = requireData(await owner.client.rpc("prepare_billing_checkout", {
    p_account_id: owner.accountId, p_plan_code: "golden", p_seats: 12, p_mode: "test",
  }), "prepare checkout");
  const prepared = preparedRows[0];
  assert.equal(prepared.product_id, productId);
  assert.equal(prepared.seats, 1, "account plan must always bill one unit");

  requireData(await service.rpc("complete_billing_checkout", {
    p_checkout_request_id: prepared.checkout_request_id, p_creem_checkout_id: `ch_${suffix}`,
  }), "complete checkout creation");

  const baseEvent = {
    p_mode: "test",
    p_payload_sha256: createHash("sha256").update(suffix).digest("hex"),
    p_event_created_at: eventTime(0),
    p_account_id: owner.accountId,
    p_plan_code: "golden",
    p_product_id: productId,
    p_customer_id: `cust_${suffix}`,
    p_subscription_id: `sub_${suffix}`,
    p_subscription_status: "active",
    p_seats: 1,
    p_period_end: "2026-10-14T00:00:00Z",
    p_trial_ends_at: null,
    p_checkout_request_id: prepared.checkout_request_id,
  };
  const checkoutCompleted = requireData(await service.rpc("apply_creem_webhook", {
    ...baseEvent,
    p_event_id: `evt_checkout_${suffix}`,
    p_event_type: "checkout.completed",
    p_account_id: null,
    p_subscription_status: "trialing",
    p_trial_ends_at: "2026-09-28T00:00:00Z",
  }), "apply checkout event");
  assert.equal(checkoutCompleted, true);

  const paid = requireData(await service.rpc("apply_creem_webhook", {
    ...baseEvent,
    p_event_id: `evt_paid_${suffix}`,
    p_event_type: "subscription.paid",
    p_event_created_at: eventTime(60_000),
    p_account_id: null,
    p_plan_code: null,
    p_checkout_request_id: null,
  }), "apply paid event");
  assert.equal(paid, true);
  const duplicate = requireData(await service.rpc("apply_creem_webhook", {
    ...baseEvent,
    p_event_id: `evt_paid_${suffix}`,
    p_event_type: "subscription.paid",
    p_account_id: null,
    p_plan_code: null,
    p_checkout_request_id: null,
  }), "apply duplicate event");
  assert.equal(duplicate, false);

  let subscription = requireData(await service.from("account_subscriptions").select("*").eq("account_id", owner.accountId).single(), "load active subscription");
  assert.equal(subscription.plan_id, golden.id);
  assert.equal(subscription.status, "active");
  assert.equal(subscription.provider_mode, "test");
  assert.equal(subscription.creem_subscription_id, `sub_${suffix}`);

  const forbiddenPortal = await stranger.client.rpc("prepare_billing_portal", { p_account_id: owner.accountId, p_mode: "test" });
  assert(forbiddenPortal.error, "a different account owner must not open the billing portal");
  const portal = requireData(await owner.client.rpc("prepare_billing_portal", { p_account_id: owner.accountId, p_mode: "test" }), "prepare billing portal");
  assert.equal(portal[0].customer_id, `cust_${suffix}`);

  const stale = requireData(await service.rpc("apply_creem_webhook", {
    ...baseEvent,
    p_event_id: `evt_stale_${suffix}`,
    p_event_type: "subscription.canceled",
    p_event_created_at: eventTime(30_000),
    p_account_id: null,
    p_plan_code: null,
    p_checkout_request_id: null,
  }), "ignore stale event");
  assert.equal(stale, false);
  subscription = requireData(await service.from("account_subscriptions").select("status").eq("account_id", owner.accountId).single(), "load subscription after stale event");
  assert.equal(subscription.status, "active");

  const ignored = requireData(await service.from("billing_webhook_events").select("applied,ignore_reason").eq("external_event_id", `evt_stale_${suffix}`).single(), "load ignored event");
  assert.equal(ignored.applied, false);
  assert.equal(ignored.ignore_reason, "stale_event");

  requireData(await service.rpc("apply_creem_webhook", {
    ...baseEvent,
    p_event_id: `evt_refund_${suffix}`,
    p_event_type: "refund.created",
    p_event_created_at: eventTime(120_000),
    p_account_id: null,
    p_plan_code: null,
    p_product_id: null,
    p_checkout_request_id: null,
  }), "apply refund without product");
  subscription = requireData(await service.from("account_subscriptions").select("status").eq("account_id", owner.accountId).single(), "load paused subscription");
  assert.equal(subscription.status, "paused");

  requireData(await service.rpc("apply_creem_webhook", {
    ...baseEvent,
    p_event_id: `evt_renewed_${suffix}`,
    p_event_type: "subscription.paid",
    p_event_created_at: eventTime(180_000),
    p_account_id: null,
    p_plan_code: null,
    p_checkout_request_id: null,
  }), "apply renewal");

  const gracePeriodEnd = new Date(Date.now() + 3_600_000).toISOString();
  requireData(await service.rpc("apply_creem_webhook", {
    ...baseEvent,
    p_event_id: `evt_expired_${suffix}`,
    p_event_type: "subscription.expired",
    p_event_created_at: eventTime(240_000),
    p_account_id: null,
    p_plan_code: null,
    p_period_end: gracePeriodEnd,
    p_checkout_request_id: null,
  }), "apply expired retry-period event");
  subscription = requireData(await service.from("account_subscriptions").select("status,grace_ends_at").eq("account_id", owner.accountId).single(), "load grace subscription");
  assert.equal(subscription.status, "past_due");
  assert(new Date(subscription.grace_ends_at).getTime() > new Date(gracePeriodEnd).getTime());

  requireData(await service.from("account_subscriptions").update({ grace_ends_at: new Date(Date.now() - 60_000).toISOString() }).eq("account_id", owner.accountId), "expire billing grace");
  const blockedLimit = requireData(await owner.client.rpc("effective_account_limit", { check_account_id: owner.accountId, limit_key: "active_projects" }), "load blocked limit");
  assert.equal(blockedLimit, 0);

  requireData(await service.rpc("apply_creem_webhook", {
    ...baseEvent,
    p_event_id: `evt_canceled_${suffix}`,
    p_event_type: "subscription.canceled",
    p_event_created_at: eventTime(300_000),
  }), "apply canceled event");
  subscription = requireData(await service.from("account_subscriptions").select("status").eq("account_id", owner.accountId).single(), "load canceled subscription");
  assert.equal(subscription.status, "canceled");

  console.log("billing integration passed");
} finally {
  await service.from("plans").update({ creem_test_product_id: null }).in("creem_test_product_id", [productId, corporateProductId]);
  if (createdUserIds.length) await service.from("accounts").delete().in("owner_id", createdUserIds);
  for (const userId of createdUserIds) await service.auth.admin.deleteUser(userId);
}
