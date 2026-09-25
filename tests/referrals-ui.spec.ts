import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const referrerEmail = `spaces-referral-ui-owner-${suffix}@example.com`;
const referredEmail = `spaces-referral-ui-guest-${suffix}@example.com`;
const password = `Spaces-${suffix}-Aa1!`;
let referrerId = "";
let referredId = "";
let referralCode = "";

test.describe("Referral profile", () => {
  test.skip(!enabled, "Local Supabase credentials are required");

  test.beforeAll(async () => {
    const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const referrer = await service.auth.admin.createUser({
      email: referrerEmail,
      password,
      email_confirm: true,
      user_metadata: { name: "Владелец ссылки" },
    });
    if (referrer.error) throw referrer.error;
    referrerId = referrer.data.user.id;

    const referred = await service.auth.admin.createUser({
      email: referredEmail,
      password,
      email_confirm: true,
      user_metadata: { name: "Приглашённый пользователь" },
    });
    if (referred.error) throw referred.error;
    referredId = referred.data.user.id;

    const code = await service.from("referral_codes").select("code").eq("user_id", referrerId).single();
    if (code.error) throw code.error;
    referralCode = code.data.code;

    const relationship = await service.from("referrals").insert({
      referrer_user_id: referrerId,
      referred_user_id: referredId,
      source: "referral_code",
    });
    if (relationship.error) throw relationship.error;
  });

  test.afterAll(async () => {
    if (!enabled) return;
    const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    if (referrerId || referredId) await service.from("accounts").delete().in("owner_id", [referrerId, referredId].filter(Boolean));
    if (referredId) await service.auth.admin.deleteUser(referredId);
    if (referrerId) await service.auth.admin.deleteUser(referrerId);
  });

  test("shows the personal code, link, count, and isolated invitee list", async ({ page }, testInfo) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(referrerEmail);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page).toHaveURL(/\/account/);

    const panel = page.locator(".referralPanel");
    await expect(panel.getByRole("heading", { name: "Реферальная регистрация" })).toBeVisible();
    await expect(panel.getByText("1 приглашено", { exact: true })).toBeVisible();
    await expect(panel.getByText(referralCode, { exact: true })).toBeVisible();
    await expect(panel.locator('input[readonly]')).toHaveValue(`https://spaces.community/register?ref=${referralCode}`);
    await expect(panel.getByText("Приглашённый пользователь", { exact: true })).toBeVisible();
    await expect(panel.getByText("s***@example.com", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/spaces-referrals-${testInfo.project.name}.png`, fullPage: true });
  });
});
