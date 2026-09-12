do $$
declare
  existing_user auth.users%rowtype;
begin
  for existing_user in select * from auth.users loop
    insert into public.profiles (id, email, display_name, avatar_url, is_superadmin)
    values (
      existing_user.id,
      existing_user.email,
      coalesce(
        existing_user.raw_user_meta_data->>'name',
        existing_user.raw_user_meta_data->>'full_name',
        split_part(existing_user.email, '@', 1)
      ),
      existing_user.raw_user_meta_data->>'avatar_url',
      lower(existing_user.email) = 'digitalcluster25@gmail.com'
    )
    on conflict (id) do update set
      email = excluded.email,
      display_name = coalesce(public.profiles.display_name, excluded.display_name),
      avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url),
      updated_at = now();

    perform public.ensure_personal_account(
      existing_user.id,
      existing_user.email,
      coalesce(
        existing_user.raw_user_meta_data->>'name',
        existing_user.raw_user_meta_data->>'full_name',
        split_part(existing_user.email, '@', 1)
      )
    );
  end loop;
end;
$$;

do $$
declare
  superadmin_id uuid;
  spaces_project_id uuid;
  target_template_id uuid;
  target_version_id uuid;
begin
  select id into superadmin_id
  from public.profiles
  where is_superadmin and lower(email) = 'digitalcluster25@gmail.com';

  select id into spaces_project_id
  from public.projects
  where system_key = 'spaces-root';

  if superadmin_id is not null and spaces_project_id is not null then
    insert into public.harness_templates (key, name, description, status, created_by)
    values (
      'spaces-core',
      'Spaces Harness',
      'Эталонная конфигурация точности, безопасности и поведения агентов Spaces',
      'published',
      superadmin_id
    )
    on conflict (key) do update set
      name = excluded.name,
      description = excluded.description,
      status = excluded.status,
      updated_at = now()
    returning id into target_template_id;

    insert into public.harness_versions (
      template_id,
      version,
      admin_config,
      status,
      test_report,
      created_by,
      published_at
    )
    values (
      target_template_id,
      1,
      jsonb_build_object(
        'identity', jsonb_build_object(
          'name', 'Spaces Harness',
          'purpose', 'Точная и безопасная работа агентов в пределах активного проекта'
        ),
        'priority', jsonb_build_array('security', 'permissions', 'user intent', 'accuracy', 'speed'),
        'security', jsonb_build_object(
          'tenant_isolation', true,
          'least_privilege', true,
          'secret_redaction', true,
          'destructive_action_confirmation', true
        ),
        'response', jsonb_build_object(
          'language', 'ru',
          'concise', true,
          'state_uncertainty', true,
          'never_invent', true
        ),
        'tooling', jsonb_build_object(
          'verify_after_write', true,
          'retry_transient_failures', true,
          'record_audit_events', true
        ),
        'quality', jsonb_build_object(
          'require_acceptance_criteria', true,
          'require_tests', true,
          'require_production_check', true
        )
      ),
      'published',
      jsonb_build_object('status', 'baseline', 'passed', true),
      superadmin_id,
      now()
    )
    on conflict (template_id, version) do update set
      admin_config = excluded.admin_config,
      status = excluded.status,
      test_report = excluded.test_report,
      published_at = excluded.published_at
    returning id into target_version_id;

    insert into public.project_harness_settings (
      project_id,
      template_id,
      active_version_id,
      user_config,
      conflict_report,
      updated_by
    )
    values (
      spaces_project_id,
      target_template_id,
      target_version_id,
      '{}'::jsonb,
      '[]'::jsonb,
      superadmin_id
    )
    on conflict (project_id) do update set
      template_id = excluded.template_id,
      active_version_id = excluded.active_version_id,
      updated_by = excluded.updated_by,
      updated_at = now();
  end if;
end;
$$;
