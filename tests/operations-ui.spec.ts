import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);
const email = "digitalcluster25@gmail.com";
const password = `Spaces-operations-${Date.now()}-Aa1!`;

function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/=+$/u, "").toUpperCase()) {
    bits += alphabet.indexOf(character).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/gu)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1)! & 15;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return value.toString().padStart(6, "0");
}

test("superadmin controls operations after MFA on desktop and mobile", async ({ page }, testInfo) => {
  test.skip(!enabled || testInfo.project.name !== "chromium", "Local Supabase credentials and Chromium are required");
  const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
  const owner = createClient(url!, anonKey!, { auth: { persistSession: false, autoRefreshToken: false } });
  let userId = "";
  let factorId = "";

  try {
    const listed = await service.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listed.error) throw listed.error;
    const existing = listed.data.users.find((user) => user.email?.toLowerCase() === email);
    if (existing) {
      userId = existing.id;
      const updated = await service.auth.admin.updateUserById(userId, { password, email_confirm: true });
      if (updated.error) throw updated.error;
    } else {
      const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) throw created.error;
      userId = created.data.user.id;
    }

    const signedIn = await owner.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    const enrolled = await owner.auth.mfa.enroll({ factorType: "totp", friendlyName: `Operations UI ${Date.now()}` });
    if (enrolled.error) throw enrolled.error;
    factorId = enrolled.data.id;
    const verified = await owner.auth.mfa.challengeAndVerify({ factorId, code: totp(enrolled.data.totp.secret) });
    if (verified.error) throw verified.error;
    const factors = await owner.auth.mfa.listFactors();
    if (factors.error) throw factors.error;
    for (const factor of factors.data.totp.filter((item) => item.id !== factorId)) {
      const removed = await owner.auth.mfa.unenroll({ factorId: factor.id });
      if (removed.error) throw removed.error;
    }

    await page.goto("/login?redirect=/superadmin");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page.getByRole("heading", { name: "Двухфакторная защита" })).toBeVisible();

    await page.getByLabel("Код из приложения").fill(totp(enrolled.data.totp.secret));
    await page.getByRole("button", { name: "Подтвердить вход" }).click();

    await expect(page.getByRole("heading", { name: "Superadminko" })).toBeVisible();
    await page.getByRole("button", { name: "Операции" }).click();
    await expect(page.getByRole("heading", { name: "Здоровье платформы" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Резервные копии" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ограничения запросов" })).toBeVisible();
    await expect(page.locator(".rateLimitRow")).toHaveCount(8);

    const firstPolicy = page.locator(".rateLimitRow").first();
    await firstPolicy.getByRole("button", { name: "Сохранить" }).click();
    await expect(page.getByRole("heading", { name: "Ты уверен, босс?" })).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Отмена" }).click();

    await page.screenshot({ path: "/tmp/spaces-operations-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 393, height: 851 });
    await expect(page.getByRole("heading", { name: "Ограничения запросов" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: "/tmp/spaces-operations-mobile.png", fullPage: true });

    await page.getByRole("button", { name: "Тарифы" }).click();
    await expect(page.getByText("Creem test", { exact: true })).toBeVisible();
    await expect(page.getByText("API и webhook настроены", { exact: true })).toBeVisible();
    await expect(page.getByText("Live products 0/2", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Аудит" }).click();
    await page.getByPlaceholder("Действие, проект или объект").fill("auth.mfa_verified");
    await expect(page.getByText("auth.mfa_verified", { exact: true }).first()).toBeVisible();
  } finally {
    if (factorId) await owner.auth.mfa.unenroll({ factorId });
    await owner.auth.signOut();
  }
});
