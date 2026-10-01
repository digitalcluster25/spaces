# Агент-раннер (SPC-0018)

Источник фактов: `infrastructure/agent-runner/dispatcher.js`.

- Карточка Paca переходит в «Беклог» или «На доработку агенту», автоматизация шлёт вебхук `POST /spaces-agents/hook`.
- Диспетчер перечитывает карточку и ведёт одну задачу за раз (очередь), остальные ждут.
- Он клонирует репозиторий в рабочую копию непривилегированного пользователя и запускает Claude Code без bypass (`--permission-mode dontAsk`).
- Агенту разрешены: чтение и правка файлов, `npm ci`, `npm run build`, `npm test`, `npm run test:*`, `npx playwright test`, `npx tsc`, `node --test`, `git status/diff/log/show/add/commit`, `ls`.
- Агенту запрещены: сеть (`WebFetch`, `WebSearch`, `curl`, `wget`, `ssh`), `git push/remote/config`, `npm install`, `supabase`; всё остальное вне списка отклоняется без запроса.
- У агента нет доступа к ключам Paca, Outline, GitHub и Supabase.
- Заявлениям агента диспетчер не верит: сам повторно запускает `npm run build` и unit-тесты (harness, billing, mcp, tasks, security, agents). Playwright e2e он не запускает.
- Диспетчер пушит ветку `spc-<N>` с deploy-ключом, никогда не в main и без `--force`. Исключение — ветка `stage` для превью, она перезаписывается под каждую задачу.
- Результат он пишет комментарием в Paca со ссылкой на сравнение, добавляет checkpoint в спецификацию в Outline и переводит карточку в «На утверждение» (или «Застрял»).
- Слияние в main и проверку продакшена делает владелец, после этого карточка переводится в «Готово».
