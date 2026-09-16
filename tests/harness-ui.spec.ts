import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import defaults from "../harness/defaults.json" with { type: "json" };

const url = process.env.LOCAL_SUPABASE_URL;
const anonKey = process.env.LOCAL_SUPABASE_ANON_KEY;
const serviceKey = process.env.LOCAL_SUPABASE_SERVICE_KEY;
const enabled = Boolean(url && anonKey && serviceKey);
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `spaces-harness-ui-${suffix}@example.com`;
const password = `Spaces-${suffix}-Aa1!`;
let userId = "";
let projectId = "";
let templateId = "";

test.describe("Harness owner workflow", () => {
  test.skip(!enabled, "Local Supabase credentials are required");

  test.beforeAll(async () => {
    const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    userId = created.data.user.id;

    const existingTemplate = await service.from("harness_templates").select("id").eq("key", "spaces-core").maybeSingle();
    if (existingTemplate.error) throw existingTemplate.error;
    if (!existingTemplate.data) {
      const template = await service.from("harness_templates").insert({
        key: "spaces-core",
        name: "Spaces Harness",
        description: "Harness UI test template",
        status: "published",
        created_by: userId,
      }).select().single();
      if (template.error) throw template.error;
      templateId = template.data.id;
      const version = await service.from("harness_versions").insert({
        template_id: templateId,
        version: 1,
        admin_config: defaults,
        schema_version: 1,
        git_revision: "abcdef0",
        status: "published",
        test_report: { passed: true },
        created_by: userId,
        published_at: new Date().toISOString(),
      });
      if (version.error) throw version.error;
    }

    const account = await service.from("account_memberships").select("account_id").eq("user_id", userId).eq("role", "owner").single();
    if (account.error) throw account.error;
    const owner = createClient(url!, anonKey!, { auth: { persistSession: false } });
    const signedIn = await owner.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    const project = await owner.rpc("create_account_project", {
      p_account_id: account.data.account_id,
      project_name: `Harness UI ${suffix}`,
      project_description: "Authenticated Harness UI test",
      project_logo_url: null,
      enabled_service_slugs: [],
    });
    if (project.error) throw project.error;
    projectId = project.data.id;
  });

  test.afterAll(async () => {
    if (!enabled) return;
    const service = createClient(url!, serviceKey!, { auth: { persistSession: false } });
    if (projectId) await service.from("projects").delete().eq("id", projectId);
    if (templateId) await service.from("harness_templates").delete().eq("id", templateId);
    if (userId) await service.from("accounts").delete().eq("owner_id", userId);
    if (userId) await service.auth.admin.deleteUser(userId);
  });

  test("previews, publishes, and restores a project version", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Пароль").fill(password);
    await page.getByRole("button", { name: "Войти" }).click();
    await expect(page).toHaveURL(/\/account/);

    await expect(page.getByRole("heading", { name: "Настройки среды" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Административный" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Пользовательский" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Итоговый" })).toBeVisible();
    await expect(page.getByRole("button", { name: "История" })).toBeVisible();

    await page.getByLabel("Цели проекта").fill("Проверить полный цикл версий Harness в интерфейсе владельца.");
    await page.getByRole("button", { name: "Проверить изменения" }).click();
    await expect(page.getByText("Проверка пройдена", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Опубликовать версию" })).toBeVisible();

    await page.getByRole("button", { name: "Опубликовать версию" }).click();
    await expect(page.getByRole("heading", { name: "Опубликовать Harness?" })).toBeVisible();
    await page.getByRole("button", { name: "Опубликовать", exact: true }).click();
    await expect(page.getByText("Новая версия опубликована.")).toBeVisible();
    await expect(page.getByText("Версия 2", { exact: true })).toBeVisible();

    const firstVersion = page.locator(".harnessHistory article").filter({ hasText: "Версия 1" });
    await firstVersion.getByRole("button", { name: "Восстановить" }).click();
    await expect(page.getByRole("heading", { name: "Восстановить версию?" })).toBeVisible();
    await page.getByRole("alertdialog").getByRole("button", { name: "Восстановить", exact: true }).click();
    await expect(page.getByText("Версия 1 восстановлена как новая версия.")).toBeVisible();
    await expect(page.getByText("Версия 3", { exact: true })).toBeVisible();
  });
});
