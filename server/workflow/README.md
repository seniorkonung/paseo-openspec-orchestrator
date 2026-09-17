# Workflow OpenSpec

Workflow состоит из последовательности независимых шагов. Само выполнение, история
действий, пауза, повторный запуск и восстановление после перезапуска находятся в
`OpenSpecOrchestratorEngine`; в файлах шагов остаётся только бизнес-логика.
Сейчас workflow проверяет обязательные профили агентов Paseo, Git-ветку и чистоту
рабочего дерева, после чего запускает интерактивный выбор OpenSpec change.

## Как добавить шаг

1. Создайте файл `server/workflow/steps/<имя-шага>.ts`.
2. Вынесите логику в экспортируемую функцию с типом `WorkflowStepFunction`.
3. Оберните функцию в `WorkflowStepDefinition` с уникальными `id` и `label`.
4. Добавьте definition в массив `OPEN_SPEC_WORKFLOW_STEPS` в `steps/index.ts`.

Пример:

```ts
import type {
  WorkflowStepContext,
  WorkflowStepDefinition,
  WorkflowStepResult,
} from "../types.ts";

export async function inspectChangeStep(
  context: WorkflowStepContext,
): Promise<WorkflowStepResult> {
  const change = await loadChange(context.workspaceDirectory, context.signal);

  if (!change) {
    return {
      kind: "halt",
      summary: "Change не найден",
      message: "Создайте change и нажмите «Повторить»",
    };
  }

  return {
    kind: "continue",
    next: "review-change",
    summary: `Change: ${change.title}`,
  };
}

export const inspectChange: WorkflowStepDefinition = {
  id: "inspect-change",
  label: "Проверяю текущий change",
  run: inspectChangeStep,
};
```

`context.state` содержит результаты предыдущих шагов и доступен только для чтения.
Если следующему шагу нужно передать новые данные, сначала добавьте типизированное
поле в `WorkflowState` и такое же поле в `workflowStateSchema` в `types.ts`, затем
верните его в `state`. После успешного шага engine атомарно сохраняет checkpoint
со следующим `stepId` и полным состоянием. При перезапуске плагина команда
«Запустить» продолжит workflow с этого checkpoint; команда «Повторить» намеренно
начинает workflow с первого шага.
Результат `continue` запускает следующий шаг, а `halt` завершает текущее выполнение
со статусом `failed`; пользователь сможет исправить причину и выполнить `retry`.
Результат `complete` завершает workflow успешно. Массив
`OPEN_SPEC_WORKFLOW_STEPS` теперь является реестром шагов: порядок элементов не
определяет выполнение, переходы задаются через `next` по идентификатору шага.

Переход может образовывать ветвление или цикл:

```ts
return {
  kind: "continue",
  next: state.issues.length > 0 ? "resolve-issues" : "review-result",
};
```

Шаг `resolve-issues` может после исправления вернуть `next: "execute-task"`, а
`review-result` — `kind: "complete"`.

Для внешних вызовов используйте `context.signal`: engine отменяет его при retry,
остановке плагина или уничтожении workflow. Не запускайте агент или MCP-сервер на
уровне модуля — создавайте и закрывайте их внутри соответствующего шага.

## Профили агентов

Обязательные имена профилей определены один раз в
`server/agent-profiles.ts`. Следующие шаги не должны повторять эти строки или
искать профиль самостоятельно: вызовите `context.services.readAgentProfiles()`,
передайте результат в `resolveRequiredAgentProfiles()` и возьмите полный профиль
из `resolution.profiles` по типизированному `RequiredAgentProfileName`.

Resolver сравнивает имена после удаления крайних пробелов без учёта регистра,
отклоняет неоднозначные совпадения и требует, чтобы каждый обязательный профиль
явно задавал непустые `provider`, `model`, `modeId` и `thinkingOptionId`.
`featureValues` остаётся необязательным. Успешный результат содержит
`CompleteRequiredAgentProfile`, поэтому следующие шаги не должны добавлять
fallback-настройки или выполнять provider discovery. Не сохраняйте профиль в
checkpoint: перечитывайте конфигурацию Paseo непосредственно перед созданием
агента.

Paseo не принимает `profileId` в `agents.create`: шаг разворачивает поля
`Medium Sandbox` в конфигурацию агента согласно
[официальной документации Paseo](https://paseo.sh/docs/mcp#agent-profiles).

## Выбор change

Терминальный шаг `select-change` создаёт агента `Medium Sandbox` в текущем Paseo
workspace через `workspace.agents.create`, устанавливает метку `ntfy=true` и
добавляет ссылку на него в текущее действие. Глобальный `agents.create` для этого
не подходит: он создаёт новый workspace для переданного `cwd`. Агент перечисляет
все активные repo-local changes, требует явный выбор пользователя либо создаёт
только scaffold нового change через `openspec-new-change`. Новый scaffold должен
быть зафиксирован отдельным Git-коммитом; создание proposal, specs, design, tasks
и других артефактов на этом этапе запрещено.

Агент получает единственный orchestrator-owned MCP-инструмент `set_change` через
`OrchestratorMcpToolHost`. Инструмент проверяет change командой `openspec status`,
границы workspace, чистоту рабочего дерева и присутствие каталога в `HEAD`.
После успешной проверки он меняет метку агента на `ntfy=false`, надёжно сохраняет
change вместе с checkpoint и только затем подтверждает успех. При reload уже
сохранённый change проверяется заново без поиска или архивации старого агента.

## Уведомления

Шаг может отправить короткое типизированное уведомление через тот же контекст:

```ts
await context.services.notify({
  kind: "progress",
  message: "Начинаю проверку результата агента",
});
```

Доступны четыре простых вида: `retry` сообщает, что нужно исправить причину и
нажать «Повторить», `completed` означает завершение workflow, `progress` подходит
для проактивных сообщений во время долгого шага, а `manual` — для явного вызова.
Доставка не является частью бизнес-логики шага: ошибка ntfy записывается в лог и
не переводит сам шаг в ошибочное состояние.

Оркестратор автоматически отправляет `retry` при любом `halt` или неожиданной
ошибке шага и `completed` после успешного завершения. Настройки находятся в
Settings → Plugins → «Уведомления OpenSpec» и не зависят от paseo-ntfy. Пустая
тема или выключатель отключают доставку.

В заголовке ntfy сначала указываются название проекта и человекочитаемое имя
workspace (`Проект / Workspace — Событие`). Идентификатор workspace и ссылка на
агента в уведомление не добавляются. Перед каждой отправкой оркестратор заново
получает данные workspace из Paseo, поэтому переименование применяется без
перезапуска плагина.

Кнопка «Очистить состояние» удаляет из ledger историю, change и checkpoint, а
затем следующий запуск проходит все шаги заново. Engine не угадывает, нужно ли
повторять внешнюю работу: каждый шаг сам проверяет актуальное состояние и может
сразу вернуть переход к нужной ветке графа. Поэтому шаги, вызывающие агентов или
изменяющие файлы, должны быть идемпотентными либо уметь безопасно обнаруживать
уже выполненный результат.
