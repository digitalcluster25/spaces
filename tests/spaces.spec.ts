import { expect, test } from "@playwright/test";

test("landing page presents Spaces product and auth entry points", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: /Spaces управляет/i })).toBeVisible();
  await expect(page.getByRole("link", { name: "Создать аккаунт" }).first()).toBeVisible();
  await expect(page.getByText("AI-оператор Spaces")).toBeVisible();
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
  await expect(page.getByRole("heading", { name: "Аккаунт Spaces" })).toBeVisible();
});
