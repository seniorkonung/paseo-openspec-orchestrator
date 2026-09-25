# Workflow OpenSpec

Workflow — граф типизированных шагов. `OpenSpecOrchestratorEngine` отвечает за
жизненный цикл, историю, паузу, Retry и восстановление; модули в `steps/`
содержат сценарную логику. `steps/index.ts` — точка сборки стандартного графа.

## Граница Git и pull request

Все этапы работают в точной ветке `change/<id>`. Один корневой PR направлен в
`main` и остаётся Draft, пока есть работа. Planning, implementation, review
и finding создают отдельные коммиты в этой ветке. Дочерние ветки, PR и
промежуточные merge-gate отсутствуют.

```text
main
  ^  один корневой PR, ручной merge после Ready
change/<id>
  | scaffold и planning-артефакты
  | OpenSpec review и решения findings
  | пофазное планирование задач
  | task-коммиты, пакетное implementation review и исправления
```

Начальная публикация PR, task-коммит, review-коммит и finding-коммит проходят
проверку состава изменений и сохранённого baseline. Публикацию проверенного
HEAD выполняет `root-branch-delivery.ts`: remote должен указывать на baseline
или уже опубликованный HEAD, а точный корневой PR — быть открытым Draft из
`change/<id>` в `main`. Никаких force push. Преждевременный merge, чужой
коммит и смена репозитория останавливают этап.

Название и описание PR меняет только оркестратор через REST gateway.
Сформированное описание change и результаты findings находятся в отдельных
управляемых секциях body; обновление одной сохраняет другую и пользовательский
текст. Комментарии и review корневого PR не читаются оркестратором.

## Последовательность шагов

```text
check-agent-profiles -> check-git-branch -> check-git-worktree
  -> check-mise-toolchain -> initialize-change
  -> prepare-planning-branch [проверка корневой ветки]
  -> inspect-change -> create-change-artifacts -> publish-change
  -> review-change -> resolve-review-findings
  -> inspect-phase-work
       | planning-required
       -> prepare-phase-planning-branch [проверка корневой ветки]
       -> plan-phase-tasks -> publish-change -> review-change
       -> resolve-review-findings
       -> resolve-implementation-review-findings
       -> validate-phase-planning -> inspect-phase-work
       | implementation-required
       -> prepare-implementation-branch [проверка корневой ветки]
       -> execute-change-tasks -> review-implementation
       -> resolve-review-findings
       -> resolve-implementation-review-findings
       -> execute-change-tasks [следующий пакет] -> inspect-phase-work
       | change-complete
       -> archive-change [High, sync specs, один коммит]
       -> await-root-merge [root Ready] -> ожидание ручного merge и Retry -> complete
```

Имена трёх `prepare-*-branch` шагов сохранены как внутренние идентификаторы
графа. Они больше не создают ветки: проверяют, что текущая локальная и
удалённая `change/<id>` совпадают и корневой PR открыт Draft.

`inspect-phase-work` читает ограниченный обычный `plan.md`, распознаёт
заголовки `## Phase N...` и `## Фаза N...`, сопоставляет задачи с фазами по
первому сегменту номера и выбирает первую фазу без задач или с незавершёнными
задачами. Перед новым этапом он сверяет локальный HEAD с origin без fast-forward
и проверяет PR.
Архивация разрешена только при `change-complete`, завершённых артефактах и
задачах и отсутствии нерешённых findings. Ранее Ready PR возвращается в Draft
до архивного коммита. Merge до архивации и закрытие PR без merge — ошибка.

Task planning может добавить незавершённые задачи только выбранной фазы,
сохраняя прежний список задач. Implementation выполняет одну задачу в одном
коммите; непустой пакет проверяется по точному диапазону
`baseCommit..reviewedHead`. Findings из `review.md` и
`implementation-review.md` устраняются по одному после предусмотренного
промптом решения пользователя. Новые задачи после исправления образуют
следующий пакет review.

## Durable state и восстановление

`WorkflowState` хранит `changeBranch`, `activeBranch`, OpenSpec change,
identity корневого PR, progress фаз, planning/implementation run и не более
одной pending-сессии внешнего эффекта. Pending-сессия архивации сохраняет
baseline, исходный и целевой пути; завершённый архив — commit SHA и эту
сессию. После архивации финальный gate проверяет дерево и точный HEAD PR,
не обращаясь к активным задачам. При сохранённом change обе ветки равны
`change/<id>`. Baseline каждого run и пакета остаётся отдельным commit SHA:
граница проверки определяется коммитами, а не ответвлением Git.

Checkpoint имеет версию 6. Checkpoint версии 5 и старше не мигрируется и
остаётся доступным только для просмотра до явного Clear. Активный старый
workflow нужно завершить прежней версией плагина до обновления либо
перезапустить вручную. Поля архивации необязательны в прежних checkpoint v6;
если PR уже слит без архива, Retry останавливается с объяснением. Recovery
принимает проверенный локальный коммит до
push и уже опубликованный commit до checkpoint; неожиданные состояния
останавливаются без reset, rebase, force push и автоматического merge.

`WorkflowStepContext` содержит `signal`, read-only `state`, durable
`checkpointState`, ссылки текущего действия и best-effort `notify`.
Результат `continue` сохраняет состояние и переходит к `next`; `halt`
сохраняет checkpoint для Retry; `complete` завершает workflow. Внешний
эффект нельзя считать сохранённым только потому, что команда завершилась:
следующий запуск должен сверить уже созданный commit, remote ref или PR.

## Добавление этапа

Новый шаг объявляет узкий интерфейс `*Dependencies`, создаётся в
`steps/` и регистрируется в `steps/index.ts`. Долговечное состояние
добавляется одновременно в типы и Zod-схему `WorkflowState`. Для нового
Git-эффекта сначала сохраняется pending-сессия с ожидаемым baseline, затем
проверяются путь, commit, origin и корневой PR. Агент получает только свой
scoped MCP-инструмент завершения; GitHub и сменой веток владеет оркестратор.
