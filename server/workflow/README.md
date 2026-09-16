# Workflow OpenSpec

Workflow состоит из последовательности независимых шагов. Само выполнение, история
действий, пауза, повторный запуск и восстановление после перезапуска находятся в
`OpenSpecOrchestratorEngine`; в файлах шагов остаётся только бизнес-логика.
Сейчас список проверяет Git-ветку и чистоту рабочего дерева; после них каркас
завершается, чтобы следующие шаги можно было добавлять по одному.

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
поле в `WorkflowState` в `types.ts`, затем верните его в `state`.
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
