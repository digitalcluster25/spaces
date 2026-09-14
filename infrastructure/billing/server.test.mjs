import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { normalizeCreemEvent, validCreemSignature } from "./server.js";

test("verifies the exact raw Creem payload", () => {
  const secret = "webhook-secret";
  const payload = Buffer.from('{"id":"evt_1"}');
  const signature = createHmac("sha256", secret).update(payload).digest("hex");
  assert.equal(validCreemSignature(payload, signature, secret), true);
  assert.equal(validCreemSignature(Buffer.from('{"id":"evt_2"}'), signature, secret), false);
  assert.equal(validCreemSignature(payload, "invalid", secret), false);
});

test("normalizes a subscription event without retaining customer PII", () => {
  const result = normalizeCreemEvent({
    id: "evt_paid",
    eventType: "subscription.paid",
    object: {
      id: "sub_1",
      object: "subscription",
      product: { id: "prod_1" },
      customer: { id: "cust_1", email: "private@example.com" },
      current_period_end_date: "2026-10-14T00:00:00Z",
      metadata: {
        account_id: "00000000-0000-4000-8000-000000000001",
        plan_code: "golden",
        checkout_request_id: "00000000-0000-4000-8000-000000000002",
        seats: 1,
      },
    },
  });
  assert.equal(result.p_subscription_id, "sub_1");
  assert.equal(result.p_customer_id, "cust_1");
  assert.equal(result.p_product_id, "prod_1");
  assert.equal(result.p_plan_code, "golden");
  assert.equal(result.p_subscription_status, null);
  assert.equal(JSON.stringify(result).includes("private@example.com"), false);
});

test("allows later events to resolve the account by subscription id", () => {
  const result = normalizeCreemEvent({
    id: "evt_refund",
    eventType: "refund.created",
    object: { subscription: { id: "sub_1", product: "prod_1" } },
  });
  assert.equal(result.p_plan_code, null);
  assert.equal(result.p_subscription_id, "sub_1");
});

test("falls back to one seat for invalid provider data", () => {
  const result = normalizeCreemEvent({
    id: "evt_units",
    eventType: "subscription.active",
    object: { id: "sub_1", object: "subscription", product: "prod_1", metadata: { seats: "unlimited" } },
  });
  assert.equal(result.p_seats, 1);
});

test("rejects events without a product", () => {
  assert.throws(() => normalizeCreemEvent({
    id: "evt_bad",
    eventType: "subscription.paid",
    object: { id: "sub_1", object: "subscription" },
  }), /product is missing/);
});
