# Workflow OpenSpec

Workflow — граф независимых шагов. `OpenSpecOrchestratorEngine` отвечает за
жизненный цикл, историю, паузу, retry и восстановление; модули в `steps/`
содержат только сценарную логику.

## Границы и контракты

- `types.ts` определяет `WorkflowState`, результат шага, runtime-контекст и
  готовый `WorkflowDefinition`.
- Каждый модуль `steps/*.ts` объявляет собственный узкий интерфейс
  `*Dependencies` из потребностей сценария.
- `steps/index.ts` — единственная точка сборки стандартного workflow.
- Engine исполняет уже собранный граф и не знает о Git, OpenSpec, GitHub или
  агентах конкретного шага.

`WorkflowStepContext` содержит `signal`, read-only `state`, durable
`checkpointState`, ссылки текущего действия и best-effort `notify`. Workspace и
предметные сервисы связываются до запуска.

Результат шага:

- `continue` сохраняет состояние и переходит по явному `next`;
- `complete` успешно заканчивает workflow;
- `halt` сохраняет текущий durable checkpoint и разрешает «Повторить».

Внешний эффект нельзя считать сохранённым только потому, что команда успешно
вернулась. Перед первой мутацией шаг записывает pending-сессию полным вызовом
`checkpointState(nextState)`, а при повторе сверяет уже созданные файлы,
коммиты, refs, push и PR.

## Durable state версии 3

Состояние хранит две разные ветки:

```ts
interface WorkflowState {
  changeBranch: string | null; // неизменяемая change/<id>
  activeBranch: string | null; // planning/root/task branch текущего шага
  change: OrchestratorChange | null;
  // не более одной pending-сессии внешнего эффекта
}
```

`changeBranch` и `activeBranch` устанавливаются вместе. Если `change` известен,
корневая ветка обязана быть точной `change/<change.id>`. Pending-сессии
инициализации, planning-ветки, артефакта, review, findings, planning merge и
задачи взаимоисключающие.

Checkpoint имеет версию 3. Версия 2 не мигрируется: её поле `branch` не
позволяет доказать, какая ветка была корневой. Такой ledger открывается в
read-only degraded-состоянии, исходный файл сохраняется; пользователь может
только явно очистить состояние и начать заново из `change/<id>`.

## Граф веток и PR

```text
main
  ^  root PR (новый всегда Draft)
change/<id>
  ^  Ready planning PR, ручной merge
planning/<id>
  |  planning artifacts, review.md, finding fixes

После merge planning PR:

main
  ^  root PR
change/<id>              activeBranch после fetch + ff-only
  ^
<id>-task-1
  ^
<id>-task-2 ...
```

Task PR сливаются в обратном порядке до `change/<id>`, затем root PR — в
`main`.

## Последовательность шагов

```text
check-agent-profiles
  -> check-git-branch
  -> check-git-worktree
  -> check-mise-toolchain
  -> initialize-change
  -> prepare-planning-branch
  -> inspect-change
       -> create-change-artifacts --+
       |                            |
       +----------------------------+
       -> publish-change
  -> review-change
  -> resolve-review-findings -------+
  -> resolve-implementation-review-findings --+
  -> await-planning-merge
  -> execute-change-tasks ----------+
```

Циклы создают один артефакт, устраняют одну finding или выполняют одну задачу за
итерацию.

## Preflight и определение change

`check-git-branch` допускает только точное `change/<kebab-case-id>`. `main`,
detached HEAD, произвольная ветка, `planning/<id>` и дополнительный сегмент
отклоняются. Change ID всегда извлекается из suffix; агента выбора и инструмента
`set_change` нет.

`check-git-worktree` требует пустой `git status --porcelain=v1
--untracked-files=all`. `check-mise-toolchain` проверяет доступный и уже
установленный `npm:@fission-ai/openspec`, но ничего не устанавливает.

## Инициализация root

`initialize-change` сначала сохраняет `pendingChangeInitializationSession` с
change ID, root branch, исходным commit, repo-local OpenSpec root и признаком
существования change, а также snapshot ранее открытого root PR. Поэтому PR,
существовавший до запуска, сохраняет Ready/Draft, а созданный запуском PR
остаётся Draft и после recovery.

Сервис запускает только официальные JSON-команды через
`mise exec --no-deps -- openspec`:

- `list --json`;
- `new change <id> --json` только для отсутствующего change;
- `status --change <id> --json`.

Во всех JSON-ответах проверяется `root`; смена root между командами или root за
пределами workspace отклоняются. Для нового change сверяются `path`,
`metadataPath` и фактический `changeRoot`.
Все changed и staged paths обязаны лежать внутри repo-local change root. Затем
создаётся один коммит `docs(openspec): add <id> change` либо короткий fallback,
root ветка публикуется без force и создаётся Draft PR в `main`.

Ровно один существующий открытый root PR переиспользуется. Неверная base
исправляется на `main`; Draft/Ready-состояние сохраняется. Закрытый PR не
переоткрывается. После каждого аварийного окна повтор проверяет scaffold,
commit, remote head и PR, а не дублирует их.

## Planning-ветка и артефакты

`prepare-planning-branch` сохраняет root baseline, проверяет одинаковые local и
origin root HEAD и отсутствие local/remote/historical занятости
`planning/<id>`. Ветка создаётся через `git switch -c planning/<id> <baseline>`.
Recovery разрешает только сохранённую root или уже активную planning-ветку.

`inspect-change` читает schema-defined граф OpenSpec. Первый `ready` артефакт
создаётся отдельным Ultra Sandbox агентом и одним коммитом. `complete_artifact`
проверяет точные output paths, чистое дерево, один commit после baseline и
subject. Цикл заканчивается только после успешного `instructions apply --json`.

## Публикация root PR

`publish-change` работает при активной `planning/<id>`. Medium Sandbox агент
читает завершённые артефакты, публикует planning-ветку и полностью заменяет
русские title/body уже существующего root PR `change/<id> -> main`. Он не
создаёт новый root PR и не публикует root-ветку.

`complete_change_publication` проверяет:

- неизменность local planning HEAD во время работы агента;
- точный remote planning HEAD;
- неизменность remote root HEAD;
- тот же GitHub repository и номер root PR;
- `change/<id> -> main`, отсутствие fork и сохранённое Draft/Ready-состояние;
- стабильный title и четыре обязательных раздела body.

## Review и findings на одной ветке

`review-change` не создаёт новую ветку. Pending-сессия сохраняет root branch и
её immutable commit, planning branch и baseline артефактов, repository identity
и номер root PR.

Ultra Sandbox агент запускает `openspec-review-change`, записывает `review.md`
и дополнительные новые review-файлы внутри change root, создаёт ровно один
review-коммит и публикует его в `planning/<id>`. Затем он создаёт единственный
Ready non-fork PR `planning/<id> -> change/<id>` с точными title/body.

Completion проверяет неизменность root local/remote HEAD и root PR, ancestry
planning baseline, ровно один review-коммит, отсутствие изменений существующих
planning-артефактов, точный remote HEAD и Ready planning PR.

Оба finding-контура продолжают коммитить и push в `planning/<id>`. Каждая
итерация выбирает первый активный `F<n>`, требует отдельное разрешение на
исправление/принятие риска и отдельное разрешение на commit+push. MCP повторно
валидирует отчёт, commit, remote head и тот же Ready planning PR, после чего
идемпотентно добавляет результат в управляемую секцию body. Review и
implementation-review findings различаются в marker.

## Merge-gate planning PR

После последней finding `await-planning-merge` читает ровно один PR с head
`planning/<id>` и проверяет repository, Ready, non-fork и base `change/<id>`:

- `OPEN` — recoverable `halt` с URL и просьбой выполнить merge и нажать
  «Повторить»;
- `CLOSED` — ошибка, замена PR автоматически не создаётся;
- `MERGED` — сохраняется `pendingPlanningMergeSession`.

Завершение сессии повторно проверяет тот же merged PR и planning head, требует
чистое дерево, выполняет `git fetch --no-tags origin
refs/heads/change/<id>`, переключается на сохранённую root-ветку и вызывает
только `git merge --ff-only <FETCH_HEAD>`. Recovery принимает как planning, так
и уже переключённую root-ветку. После сверки root с origin OpenSpec change
проверяется ещё раз, `activeBranch` становится `change/<id>`.

## Выполнение задач

`execute-change-tasks` читает `instructions apply --change <id> --json` и
выбирает первую незавершённую задачу. Первая task-ветка создаётся от обновлённой
`change/<id>`, последующие — от предыдущей task-ветки.

Одна итерация сохраняет полный task checkpoint, запускает High Sandbox агента,
создаёт и публикует ветку, выполняет только выбранную задачу, создаёт один
Conventional Commit и Ready PR в сохранённую parent-ветку. Completion проверяет
parent immutability, один commit, единственное допустимое изменение task-state,
progress, точные local/remote heads и GitHub metadata. Успех делает task-ветку
активной и повторяет шаг.

## Профили, MCP и уведомления

Обязательные профили определены в `server/agent-profiles.ts`. Preflight требует
полные provider/model/mode/thinking settings. Конкретный шаг перечитывает профиль
непосредственно перед запуском агента и не сохраняет его в checkpoint.

Каждая агентская сессия получает только свой scoped MCP-инструмент:

- `complete_artifact`;
- `complete_change_publication`;
- `complete_change_review`;
- `complete_review_finding`;
- `complete_implementation_review_finding`;
- `complete_change_task`.

Завершение отдельного хода не завершает workflow: MCP scope и `ntfy=true`
остаются активными. Успешный completion отключает метку после всех проверок.
Ошибка checkpoint возвращает метку и допускает retry.

Engine отправляет best-effort уведомления `retry` после halt и `completed` после
успеха. Ошибка доставки не меняет результат шага.

## Как добавить шаг

1. Создайте `server/workflow/steps/<step>.ts`.
2. Опишите рядом минимальный `*Dependencies`.
3. Добавьте durable поля одновременно в `WorkflowState` и
   `workflowStateSchema`.
4. Сохраните pending-сессию до внешнего эффекта и реализуйте reconciliation.
5. Зарегистрируйте фабрику в `createOpenSpecWorkflow()`.
6. Добавьте переходы и тесты normal/retry/restart/fail-closed.

Передаваемый `AbortSignal` обязателен для команд, агентов и ожиданий. Не
запускайте agent или MCP host на уровне модуля и не делайте force/reset как
способ восстановления.
