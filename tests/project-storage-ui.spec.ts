import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `spaces-storage-ui-${suffix}@example.com`;
const password = `Spaces-${suffix}-Aa1!`;
let userId = "";
let projectId = "";

test.describe("Project data owner workflow", () => {
  test.skip(!enabled, "Local Supabase credentials are required");

  test.beforeAll(async () => {
    const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    userId = created.data.user.id;
    const account = await service.from("account_memberships").select("account_id").eq("user_id", userId).eq("role", "owner").single();
    if (account.error) throw account.error;
    const owner = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const signedIn = await owner.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    const project = await owner.rpc("create_account_project", {
      p_account_id: account.data.account_id,
      project_name: `Storage UI ${suffix}`,
      project_description: "Authenticated project data UI test",
      project_logo_url: null,
      enabled_service_slugs: [],
    });
    if (project.error) throw project.error;
    projectId = project.data.id;
  });

  test.afterAll(async () => {
    if (!enabled) return;
    const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    if (projectId) {
      const files = await service.from("project_files").select("object_path").eq("project_id", projectId);
      if (files.data?.length) await service.storage.from("project-files").remove(files.data.map((item) => item.object_path));
      await service.from("projects").delete().eq("id", projectId);
    }
    if (userId) await service.auth.admin.deleteUser(userId);
  });

  test("manages knowledge, a private file, and an encrypted secret", async ({ page }, testInfo) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page).toHaveURL(/\/account/);

    const panel = page.locator("#project-data");
    await expect(panel.getByRole("heading", { name: "Данные проекта" })).toBeVisible();
    await panel.getByLabel("Название").fill("UI memory document");
    await panel.getByLabel("Содержание").fill("Private searchable context for the active project");
    await panel.getByRole("button", { name: "Добавить в память" }).click();
    await expect(panel.getByText("UI memory document")).toBeVisible();
    await panel.getByPlaceholder("Поиск по памяти проекта").fill("searchable context");
    await panel.getByRole("button", { name: "Найти" }).click();
    await expect(panel.getByText("UI memory document")).toBeVisible();

    await panel.getByRole("button", { name: "Файлы" }).click();
    await panel.locator('input[type="file"]').setInputFiles({ name: "ui-private.txt", mimeType: "text/plain", buffer: Buffer.from("private ui file") });
    await expect(panel.getByText("ui-private.txt")).toBeVisible();

    await panel.getByRole("button", { name: "Секреты" }).click();
    const secretValue = `secret-${suffix}`;
    await panel.getByLabel("Имя").fill("UI_API_KEY");
    await panel.getByLabel("Сервис").fill("spaces");
    await panel.getByLabel("Описание").fill("Playwright encrypted secret");
    await panel.getByLabel("Значение").fill(secretValue);
    await panel.getByRole("button", { name: "Сохранить секрет" }).click();
    await expect(panel.getByText("UI_API_KEY")).toBeVisible();
    await expect(page.getByText(secretValue)).toHaveCount(0);
    await panel.getByRole("button", { name: "Отключить" }).click();
    await expect(panel.getByText("Отключён", { exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/spaces-storage-${testInfo.project.name}.png`, fullPage: true });

    await panel.getByRole("button", { name: "Файлы" }).click();
    await panel.getByTitle("Удалить файл").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Подтвердить" }).click();
    await expect(panel.getByText("ui-private.txt")).toHaveCount(0);
  });

  test("shows a stable error when the secrets service returns an empty response", async ({ page }) => {
    await page.route("**/api/data/secrets?**", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: "" });
    });
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page).toHaveURL(/\/account/);
    await expect(page.locator("#project-data")).toContainText("Сервис данных вернул пустой ответ");
    await expect(page.getByText(/Cannot read properties/)).toHaveCount(0);
  });
});
