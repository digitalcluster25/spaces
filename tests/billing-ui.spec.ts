import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `spaces-billing-ui-${suffix}@example.com`;
const password = `Spaces-${suffix}-Aa1!`;
let userId = "";

test.describe("Account billing", () => {
  test.skip(!enabled, "Local Supabase credentials are required");

  test.beforeAll(async () => {
    const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    const account = await service.from("account_memberships").select("account_id").eq("user_id", userId).eq("role", "owner").single();
    if (account.error) throw account.error;
    const plan = await service.from("plans").select("id").eq("code", "golden").single();
    if (plan.error) throw plan.error;
    const subscription = await service.from("account_subscriptions").update({
      plan_id: plan.data.id,
      status: "active",
      provider_mode: "test",
      creem_customer_id: `cust_${suffix}`,
      creem_subscription_id: `sub_${suffix}`,
      current_period_end: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      trial_ends_at: null,
    }).eq("account_id", account.data.account_id);
    if (subscription.error) throw subscription.error;
  });

  test.afterAll(async () => {
    if (!enabled || !userId) return;
    const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    await service.auth.admin.deleteUser(userId);
  });

  test("shows the customer portal action without exposing provider identifiers", async ({ page }, testInfo) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page).toHaveURL(/\/account/);

    const billing = page.locator(".billingPanel");
    await expect(billing.getByRole("heading", { name: "Тариф аккаунта" })).toBeVisible();
    await expect(billing.locator(".billingStatus").getByText("Золотой стандарт", { exact: true })).toBeVisible();
    await expect(billing.getByRole("button", { name: "Управлять оплатой" })).toBeVisible();
    await expect(page.getByText(`cust_${suffix}`)).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/spaces-billing-${testInfo.project.name}.png`, fullPage: true });
  });
});
