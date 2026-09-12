import { expect, test } from "@playwright/test";

test("landing page presents Spaces product and auth entry points", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Spaces управляет/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Создать аккаунт" }).first()).toBeVisible();
  await expect(page.getByText("AI-оператор Spaces")).toBeVisible();
  await expect(page.getByRole("link", { name: "Платформа" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Карта созданных страниц Spaces." })).toHaveCount(0);
  await expect(page.locator(".purposeSection, .sitemapSection, .sectionBand, .splitSection, .securitySection")).toHaveCount(0);
});

test("auth screens are available", async ({ page }) => {
  await page.goto("/register");
  await expect(page.getByRole("heading", { name: "Создать аккаунт Spaces" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Продолжить с Google" })).toBeVisible();

  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Вход в Spaces" })).toBeVisible();

  await page.goto("/forgot");
  await expect(page.getByRole("heading", { name: "Восстановить пароль" })).toBeVisible();

  await page.goto("/reset-password");
  await expect(page.getByRole("heading", { name: "Новый пароль" })).toBeVisible();

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Нужно войти" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "MCP для внешних агентов" })).toHaveCount(0);
  await expect(page.getByText("Вход выполнен")).toHaveCount(0);

  await page.goto("/privacy");
  await expect(page.getByRole("heading", { name: "Privacy Policy" })).toBeVisible();

  await page.goto("/terms");
  await expect(page.getByRole("heading", { name: "Terms of Service" })).toBeVisible();
});

test("superadmin control plane is closed without authentication", async ({ page }) => {
  await page.goto("/superadmin");
  await expect(page.getByRole("heading", { name: "Нужно войти" })).toBeVisible();
  await expect(page.getByText("Суперадминка доступна только владельцу Spaces.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Superadminko" })).toHaveCount(0);
});

test("service launch requires the Spaces session and preserves its destination", async ({ page }) => {
  await page.goto("/launch?project=project-id&service=outline");

  await expect(page).toHaveURL(/\/login\?redirect=/);
  await expect(page.getByRole("heading", { name: "Вход в Spaces" })).toBeVisible();
  const redirect = new URL(page.url()).searchParams.get("redirect");
  expect(redirect).toBe("/launch?project=project-id&service=outline");
});
