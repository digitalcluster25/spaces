import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const required = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CREEM_API_KEY", "CREEM_WEBHOOK_SECRET"];
const mode = process.env.CREEM_MODE === "live" ? "live" : "test";
const creemApi = mode === "live" ? "https://api.creem.io/v1" : "https://test-api.creem.io/v1";
const supportedEvents = new Set([
  "checkout.completed",
  "subscription.active",
  "subscription.paid",
  "subscription.canceled",
  "subscription.scheduled_cancel",
  "subscription.past_due",
  "subscription.unpaid",
  "subscription.expired",
  "subscription.update",
  "subscription.trialing",
  "subscription.paused",
  "refund.created",
  "dispute.created",
]);

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function rawBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function supabaseRpc(name, body, authorization) {
  const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${authorization}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.message || `Database request failed (${response.status})`), { status: response.status });
  return data;
}

async function authenticatedUser(token) {
  const response = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${token}` },
  });
  const user = await response.json().catch(() => null);
  if (!response.ok || !user?.id || !user?.email) throw Object.assign(new Error("Authentication required"), { status: 401 });
  return user;
}

export function validCreemSignature(payload, signature, secret) {
  if (!signature || !/^[a-f\d]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function objectId(value) {
  if (typeof value === "string") return value;
  return typeof value?.id === "string" ? value.id : null;
}

function seats(value, fallback = 1) {
  const result = Number(value ?? fallback);
  return Number.isInteger(result) && result >= 1 && result <= 1000 ? result : fallback;
}

export function normalizeCreemEvent(event) {
  if (!event || typeof event.id !== "string" || !supportedEvents.has(event.eventType) || typeof event.object !== "object") {
    throw Object.assign(new Error("Unsupported webhook event"), { status: 400 });
  }
  const eventCreatedAt = new Date(typeof event.created_at === "number" ? event.created_at : String(event.created_at || ""));
  if (Number.isNaN(eventCreatedAt.getTime())) throw Object.assign(new Error("Webhook timestamp is missing"), { status: 400 });
  const object = event.object;
  const subscription = object.object === "subscription" ? object : object.subscription || {};
  const metadata = object.metadata || subscription.metadata || object.checkout?.metadata || {};
  const productId = objectId(subscription.product) || objectId(object.product) || objectId(object.order?.product);
  const accountId = metadata.account_id || null;
  const planCode = metadata.plan_code || null;
  const subscriptionId = objectId(subscription);
  if (!productId && !subscriptionId) throw Object.assign(new Error("Webhook product and subscription are missing"), { status: 400 });

  return {
    p_event_id: event.id,
    p_mode: mode,
    p_event_type: event.eventType,
    p_payload_sha256: "",
    p_event_created_at: eventCreatedAt.toISOString(),
    p_account_id: accountId,
    p_plan_code: planCode,
    p_product_id: productId,
    p_customer_id: objectId(subscription.customer) || objectId(object.customer) || objectId(object.order?.customer),
    p_subscription_id: subscriptionId,
    p_subscription_status: typeof subscription.status === "string" ? subscription.status : null,
    p_seats: seats(metadata.seats || object.units || object.checkout?.units || subscription.items?.[0]?.units),
    p_period_end: subscription.current_period_end_date || null,
    p_trial_ends_at: subscription.trial_period_end_date || subscription.trial_ends_at || (event.eventType === "subscription.trialing" ? subscription.current_period_end_date : null),
    p_checkout_request_id: metadata.checkout_request_id || object.request_id || object.checkout?.request_id || null,
  };
}

async function portal(request, response) {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json(response, 401, { error: "Authentication required" });
  const body = JSON.parse((await rawBody(request)).toString("utf8") || "{}");
  const preparedRows = await supabaseRpc("prepare_billing_portal", {
    p_account_id: body.accountId,
    p_mode: mode,
  }, token);
  const customerId = preparedRows?.[0]?.customer_id;
  if (!customerId) throw new Error("Billing portal preparation failed");

  const providerResponse = await fetch(`${creemApi}/customers/billing`, {
    method: "POST",
    headers: { "x-api-key": process.env.CREEM_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ customer_id: customerId }),
  });
  const provider = await providerResponse.json().catch(() => null);
  if (!providerResponse.ok || !provider?.customer_portal_link) {
    throw Object.assign(new Error(provider?.message || `Creem request failed (${providerResponse.status})`), { code: `creem_${providerResponse.status}` });
  }
  return json(response, 200, { portalUrl: provider.customer_portal_link });
}

async function readiness(request, response) {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json(response, 401, { error: "Authentication required" });
  const allowed = await supabaseRpc("is_superadmin", {}, token);
  if (allowed !== true) return json(response, 403, { error: "Superadmin AAL2 access required" });
  return json(response, 200, {
    status: "ok",
    mode,
    apiConfigured: Boolean(process.env.CREEM_API_KEY),
    webhookConfigured: Boolean(process.env.CREEM_WEBHOOK_SECRET),
  });
}

async function checkout(request, response) {
  const token = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return json(response, 401, { error: "Authentication required" });
  const body = JSON.parse((await rawBody(request)).toString("utf8") || "{}");
  const requestedSeats = Number(body.seats ?? 1);
  if (!Number.isInteger(requestedSeats) || requestedSeats < 1 || requestedSeats > 1000) {
    throw Object.assign(new Error("Seats must be an integer from 1 to 1000"), { status: 400 });
  }
  const user = await authenticatedUser(token);
  const preparedRows = await supabaseRpc("prepare_billing_checkout", {
    p_account_id: body.accountId,
    p_plan_code: body.planCode,
    p_seats: requestedSeats,
    p_mode: mode,
  }, token);
  const prepared = preparedRows?.[0];
  if (!prepared?.checkout_request_id || !prepared?.product_id) throw new Error("Checkout preparation failed");

  let providerResponse;
  try {
    providerResponse = await fetch(`${creemApi}/checkouts`, {
      method: "POST",
      headers: { "x-api-key": process.env.CREEM_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        product_id: prepared.product_id,
        request_id: prepared.checkout_request_id,
        units: prepared.seats,
        customer: { email: user.email, name: prepared.account_name },
        success_url: "https://spaces.community/account?billing=success",
        metadata: {
          account_id: body.accountId,
          plan_code: body.planCode,
          checkout_request_id: prepared.checkout_request_id,
          user_id: user.id,
          seats: prepared.seats,
        },
      }),
    });
    const provider = await providerResponse.json().catch(() => null);
    if (!providerResponse.ok || !provider?.checkout_url || !provider?.id) {
      throw Object.assign(new Error(provider?.message || `Creem request failed (${providerResponse.status})`), { code: `creem_${providerResponse.status}` });
    }
    await supabaseRpc("complete_billing_checkout", {
      p_checkout_request_id: prepared.checkout_request_id,
      p_creem_checkout_id: provider.id,
    }, process.env.SUPABASE_SERVICE_ROLE_KEY);
    return json(response, 200, { checkoutUrl: provider.checkout_url });
  } catch (error) {
    await supabaseRpc("fail_billing_checkout", {
      p_checkout_request_id: prepared.checkout_request_id,
      p_error_code: error.code || "provider_error",
    }, process.env.SUPABASE_SERVICE_ROLE_KEY).catch(() => {});
    throw error;
  }
}

async function webhook(request, response) {
  const payload = await rawBody(request);
  if (!validCreemSignature(payload, request.headers["creem-signature"], process.env.CREEM_WEBHOOK_SECRET)) {
    return json(response, 401, { error: "Invalid signature" });
  }
  const normalized = normalizeCreemEvent(JSON.parse(payload.toString("utf8")));
  normalized.p_payload_sha256 = createHash("sha256").update(payload).digest("hex");
  const processed = await supabaseRpc("apply_creem_webhook", normalized, process.env.SUPABASE_SERVICE_ROLE_KEY);
  return json(response, 200, { received: true, processed });
}

export function createBillingServer() {
  return createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") return json(response, 200, { status: "ok", mode });
      if (request.method === "GET" && request.url === "/readiness") return await readiness(request, response);
      if (request.method === "POST" && request.url === "/checkout") return await checkout(request, response);
      if (request.method === "POST" && request.url === "/portal") return await portal(request, response);
      if (request.method === "POST" && request.url === "/webhook") return await webhook(request, response);
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      console.error("billing request failed", { path: request.url, message: error.message });
      return json(response, Number(error.status) || 500, { error: Number(error.status) < 500 ? error.message : "Billing service unavailable" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length) throw new Error(`Missing required environment: ${missing.join(", ")}`);
  const port = Number(process.env.PORT || 3000);
  createBillingServer().listen(port, "0.0.0.0", () => console.log(`Spaces billing listening in ${mode} mode on ${port}`));
}
