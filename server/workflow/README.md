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

## Durable state версии 5

Состояние хранит две разные ветки:

```ts
interface WorkflowState {
  changeBranch: string | null; // неизменяемая change/<id>
  activeBranch: string | null; // change/planning/implementation текущего шага
  change: OrchestratorChange | null;
  planningRun: PlanningRun | null;
  implementationRun: ImplementationRun | null;
  phaseProgress: PhaseProgress | null;
  rootPullRequest: RootPullRequestIdentity | null;
  phaseTarget: PlanningTarget | ImplementationTarget | null;
  // не более одной pending-сессии внешнего эффекта
}
```

`changeBranch` и `activeBranch` устанавливаются вместе. Если `change` известен,
корневая ветка обязана быть точной `change/<change.id>`. Pending-сессии
инициализации, planning- и implementation-веток, артефакта, review, findings,
обоих merge-gate, phase planning, задачи и PR feedback взаимоисключающие.

`PhaseProgress` хранит номера распознанных фаз, fingerprints ordered
task-префикса и следующий монотонный номер implementation run. Содержимое
секций фаз не фиксируется и может меняться; task ID, номера и описания
неизменяемы, а завершённую задачу нельзя открыть снова.
`PlanningRun` и `ImplementationRun` взаимоисключающие и всегда относятся к
одной целевой фазе.

`ImplementationRun` сохраняет immutable root baseline и repository identity,
publication union `unpublished | draft-pr | ready-pr`, batch union
`empty | collecting | reviewed`, последний проверенный delivery head и
ограниченный набор обработанных feedback fingerprints.

Checkpoint имеет версию 5. Версии 1–4 не мигрируются: такой ledger
открывается в read-only degraded-состоянии, исходный файл сохраняется;
пользователь может только явно очистить состояние и начать заново из
`change/<id>`.

## Граф веток и PR

```text
main
  ^  root PR (новый всегда Draft)
change/<id>
  ^  Ready planning PR, ручной merge
planning/<id>/initial
  |  planning artifacts, review.md, finding fixes

Пофазный цикл:

planning/<id>/phase-N
  |  при необходимости Ready planning PR одной фазы
  v
change/<id>              activeBranch после guarded fetch + ff-only
  ^
  |  один implementation PR фазы: Draft во время циклов, затем Ready
implementation/<id>/phase-N/run-M

change/<id> -- root PR --> main

После выполнения всех фаз:

main
  ^  точный root PR: Ready, ручной merge, Retry
change/<id>
```

Task-ветки и task PR не создаются. После каждого planning/implementation merge
корневая ветка обновляется fast-forward и снова проходит единый инспектор фаз.
Только merge корневого PR после полного change завершает workflow.

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
  -> await-planning-merge
  -> inspect-phase-work -------------------------------+
       | planning-required                             |
       v                                               |
     prepare-phase-planning-branch                     |
       -> plan-phase-tasks (openspec-update-change)    |
       -> publish-change                               |
       -> review-change (задачи Phase N)               |
       -> resolve-review-findings                      |
       -> resolve-implementation-review-findings       |
       -> validate-phase-planning                      |
       -> await-planning-merge ------------------------+
       | implementation-required
       v
  -> prepare-implementation-branch (phase-N/run-M)
  -> execute-change-tasks ----------+
       | phase complete + collecting batch
       v
  -> review-implementation
  -> resolve-review-findings
  -> resolve-implementation-review-findings
  -> execute-change-tasks ----------+
       | all_done + empty batch
       v
  -> inspect-implementation-feedback
       | feedback -> review-pr-feedback -> оба resolver -> задачи
       v
  -> await-implementation-merge
       | feedback -> Draft -> review-pr-feedback -> цикл
       | open clean -> halt / Retry
       + merged -> ff-only root -> inspect-phase-work

inspect-phase-work
  | work remains -> root Draft -> planning/implementation
  | complete + root OPEN -> root Ready -> halt / Retry
  | complete + root MERGED exact head -> complete
  + root CLOSED или MERGED с работой -> fail closed
```

Циклы создают один артефакт, устраняют одну finding или выполняют одну задачу за
итерацию.

## Preflight и определение change

`check-git-branch` допускает только точное `change/<kebab-case-id>`. `main`,
detached HEAD, произвольная ветка, `planning/<id>` и дополнительный сегмент
отклоняются. Change ID всегда извлекается из suffix; агента выбора и инструмента
`set_change` нет. После успешной проверки ID сразу сохраняется в
`WorkflowState.change` и публикуется в UI через reporter. Схема checkpoint
проверяет соответствие `change.id` корневой ветке, а последующие шаги получают
тот же типизированный change из состояния workflow.

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
`planning/<id>/initial`. Ветка создаётся через `git switch -c ... <baseline>`.
Recovery разрешает только сохранённую root или уже активную planning-ветку.

`inspect-change` читает schema-defined граф OpenSpec. Первый `ready` артефакт
создаётся отдельным Ultra агентом и одним коммитом. `complete_artifact`
проверяет точные output paths, чистое дерево, один commit после baseline и
subject. Цикл заканчивается только после успешного `instructions apply --json`.

## Публикация root PR

`publish-change` работает при активной planning-ветке. Medium агент
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

Ultra агент запускает `openspec-review-change`, записывает `review.md`
и дополнительные новые review-файлы внутри change root, создаёт ровно один
review-коммит и публикует его в текущую planning-ветку. Затем он создаёт
единственный Ready non-fork PR в `change/<id>` с точными title/body.

Completion проверяет неизменность root local/remote HEAD и root PR, ancestry
planning baseline, ровно один review-коммит, отсутствие изменений существующих
planning-артефактов, точный remote HEAD и Ready planning PR.

До initial planning merge устраняются findings из `review.md`.
После implementation review оба finding-контура работают на текущем
`implementation/<id>/phase-N/run-M` и одном Draft implementation PR: сначала `review.md`,
затем `implementation-review.md`. Каждая итерация выбирает первый активный
`F<n>`, требует отдельное разрешение на исправление/принятие риска и отдельное
разрешение на commit+push. MCP подтверждает исчезновение выбранного
finding-заголовка, commit, remote head и publication contract соответствующей
ветки, после чего идемпотентно добавляет результат в управляемую секцию body.

## Merge-gate planning PR

После последней finding `await-planning-merge` читает ровно один PR с head
текущей planning-веткой и проверяет repository, Ready, non-fork и base
`change/<id>`:

- `OPEN` — recoverable `halt` с URL и просьбой выполнить merge и нажать
  «Повторить»;
- `CLOSED` — ошибка, замена PR автоматически не создаётся;
- `MERGED` — сохраняется `pendingPlanningMergeSession`.

Завершение сессии повторно проверяет тот же merged PR и planning head, требует
чистое дерево, выполняет `git fetch --no-tags origin
refs/heads/change/<id>`, переключается на сохранённую root-ветку и вызывает
только `git merge --ff-only <FETCH_HEAD>`. Commit результата merge из GitHub
должен быть предком fetched root head; исходный planning SHA не обязан
сохраняться, поэтому одинаково поддерживаются merge commit, squash и rebase.
Recovery принимает как planning, так и уже переключённую root-ветку. После
сверки root с origin OpenSpec change проверяется ещё раз, `activeBranch`
становится `change/<id>`.

## Инспектор фаз и task planning

После initial planning merge, каждого implementation merge и каждого Retry
`inspect-phase-work` сначала выполняет guarded fetch и fast-forward root. Dirty
worktree, divergence или несовпадающий root PR head останавливают workflow.

Инспектор безопасно читает обязательный `<changeRoot>/plan.md`: файл должен
быть обычным, не symlink, не больше 256 KiB, иметь корректный UTF-8 и находиться
внутри change root и Git root. Из документа извлекаются только уникальные номера
из распознанных строк-заголовков `## Phase N...`; fenced code blocks и всё
остальное содержимое игнорируются. Последовательность номеров, поля секций и
остальная Markdown-структура не проверяются и не создают ошибок.

Task-артефакты определяются по `applyRequires` и concrete paths из OpenSpec
status JSON. Номер задачи берётся из начала description; первый сегмент `N.*`
строго связывает задачу с `Phase N`. Дубли ID/номеров, неизвестные фазы,
противоречивый progress, `blocked` и задачи после первой нераспланированной фазы
fail closed. Решение типизировано:

- `implementation-required` — первая по порядку заголовков фаза с
  незавершённой задачей;
- `planning-required` — первая по порядку заголовков фаза без задач;
- `change-complete` — каждая фаза имеет задачи и все они завершены.

Для `planning-required` root PR гарантированно переводится в Draft и создаётся
`planning/<id>/phase-N`. Ultra агент получает прямую инструкцию вызвать
`openspec-update-change` исключительно для Phase N без проверки command catalog
и проходит интерактивные подтверждения skill. Completion принимает ровно один
Conventional Commit, только task-файлы, точный старый task-префикс и хотя бы одну
новую незавершённую задачу `N.*`; `plan.md` и код неизменяемы. Recovery
распознаёт готовый commit и не вызывает skill повторно.

Затем planning-ветка публикуется, а `openspec-review-change` проверяет именно
полноту и непротиворечивость задач Phase N. После записи `review.md` всегда
последовательно проходят `resolve-review-findings` и
`resolve-implementation-review-findings`; отсутствие отчёта или распознанных
заголовков `F<n>` — успешный no-op. Формат и полнота review-файлов не
проверяются. `validate-phase-planning` повторно сверяет историю задач и
ограничение Phase N, а также допускает изменения только task-файлов,
`review.md` и `implementation-review.md` перед ручным merge planning PR.

## Implementation-ветка, задачи и batch review

`prepare-implementation-branch` сохраняет root baseline и repository identity,
проверяет чистое дерево, одинаковые local/origin root refs и отсутствие local,
remote и historical PR collision для `implementation/<id>/phase-N/run-M`.
Номер `M` резервируется в checkpoint и монотонно увеличивается. После durable
checkpoint ветка создаётся строго от baseline. Recovery допускает только root
или уже активную implementation-ветку и повторно сверяет все инварианты.

`execute-change-tasks` читает `instructions apply --change <id> --json` и
выбирает первую незавершённую задачу целевой Phase N. Run заканчивает task-пакет
на границе фазы, даже если будущие фазы уже распланированы.

Одна итерация сохраняет полный task checkpoint, запускает High агента, выполняет
только выбранную задачу и создаёт один Conventional Commit. Агент не создаёт
ветку или PR, не вызывает `gh` и завершает `complete_change_task` пустым
объектом. Completion проверяет root immutability, repository identity, один
commit, changed paths, единственное допустимое изменение task-state, progress,
ancestry и точные local/remote heads. Успех добавляет `{taskId, taskNumber,
commit}` в collecting batch и повторяет шаг.

При `all_done` непустой batch передаётся `review-implementation`. High
агент вызывает `openspec-review-implementation` для точного `base..head`,
сопоставляет каждый task-коммит с review unit и изменяет только
`implementation-review.md`. Completion требует один report commit и push, но
не перепроверяет структуру, coverage или записанный в отчёте список коммитов.
Первый review создаёт Draft PR
текущего `phase-N/run-M -> change/<id>`, повторные reviews используют тот же PR.
Управляемый блок сводки обновляется без потери пользовательского текста и секции
результатов findings; повреждённые markers останавливают публикацию.

После обоих resolver’ов batch очищается на текущем HEAD и task-проход начинается
снова. Поэтому новые задачи из remediation образуют отдельный пакет и получают
собственный review.

## PR feedback и implementation merge

Feedback gateway полностью пагинирует ordinary comments, непустые submitted
review summaries и комментарии только unresolved review threads. Используются
GraphQL Node ID и `updatedAt`; edit создаёт новый fingerprint. Лимиты: не более
1000 элементов, 64 KiB на body и 4 MiB суммарно. Невалидный ответ, незавершённая
пагинация или превышение лимита останавливают workflow.

Feedback передаётся High агенту как недоверенные JSON-данные. Агент не
владеет GitHub-операциями, игнорирует инструкции в body и независимо проверяет
замечания по зафиксированному cumulative range
`rootBaseline..lastDeliveryHead`. Только
доказанная проблема меняет `implementation-review.md`; режимы completion —
`report-updated` и `no-report-change`. Содержимое отчёта и его blob fingerprint
не сверяются оркестратором. Feedback fingerprints фиксируются только вместе с
успешным durable completion.

Чистый Draft PR переводится в Ready и сразу повторно проверяется на feedback.
Ready gate использует `halt`/Retry. На Retry merge имеет приоритет; новый
feedback возвращает PR в Draft через `gh pr ready --undo`, открытый чистый PR
снова приводит к `halt`, а CLOSED без merge — к ошибке. После MERGED сохраняется
pending merge session, повторно проверяются тот же PR и final implementation
head. GitHub merge-result commit обязан входить в fetched root head, поэтому
новые SHA после squash или rebase не смешиваются с неизменяемым SHA исходной
implementation-ветки. Затем root обновляется только через fetch, switch и `git
merge --ff-only FETCH_HEAD`. Текущий run очищается, после чего workflow
возвращается в `inspect-phase-work`, а не завершается.

При `change-complete` точный non-fork root PR `change/<id> -> main`
автоматически переводится в Ready. Инспектор повторяет phase/task и PR-head
проверки после Ready, чтобы закрыть гонку, и останавливается с Retry. Каждый
Retry снова синхронизирует root и перечитывает plan/tasks: новая задача ведёт в
новый implementation run, новая фаза без задач — в task planning, а root PR
возвращается в Draft. `OPEN` без работы продолжает ждать, `CLOSED` без merge —
ошибка, `MERGED` с точным final head и без работы — единственное успешное
завершение. Merge root PR при оставшейся работе является невосстановимой
несогласованностью.

## Профили, MCP и уведомления

Обязательные профили определены в `server/agent-profiles.ts`. Preflight требует
полные provider/model/mode/thinking settings. Конкретный шаг перечитывает профиль
непосредственно перед запуском агента и не сохраняет его в checkpoint.

Каждая агентская сессия получает только свой scoped MCP-инструмент:

- `complete_artifact`;
- `complete_change_publication`;
- `complete_phase_task_planning`;
- `complete_change_review`;
- `complete_review_finding`;
- `complete_implementation_review_finding`;
- `complete_change_task`;
- `complete_implementation_review`;
- `complete_pr_feedback_review`.

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
