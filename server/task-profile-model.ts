import { z } from "zod";
import {
  MAX_TASKS,
  MAX_TASK_DESCRIPTION_LENGTH,
  TASK_NUMBER_PREFIX,
  taskNumberSchema,
  type TaskExecutionProfile,
} from "./change-task-model.ts";
import {
  ESCALATION_PROFILE,
  TASK_PROFILE_NAMES,
  taskProfileNameSchema,
  taskProfileTextSchema,
  type TaskProfileName,
} from "./task-profile-level.ts";

/**
 * Файл профилей агентов для OpenSpec-задач.
 *
 * Перед выполнением задач фазы High-агент оценивает каждую незавершённую
 * задачу без оценки и назначает ей профиль агента, который её выполнит.
 * Оценка привязана к полному тексту задачи вместе с номером: изменённая
 * задача теряет оценку и оценивается заново. Пользователь может
 * переопределить профиль, изменив файл. Форматом владеет оркестратор: он сам
 * генерирует файл из проверенных данных и строго разбирает его при чтении.
 */

export const TASK_PROFILES_FILE_NAME = "task-profiles.md";
export const MAX_TASK_PROFILES_BYTES = 1024 * 1024;

const FILE_TITLE = "# Профили агентов OpenSpec-задач";
const FORMAT_MARKER = "<!-- paseo-openspec-orchestrator:task-profiles:v1 -->";
const PREAMBLE =
  "Файл ведёт оркестратор. Перед выполнением задач фазы High-агент назначает каждой незавершённой задаче без оценки профиль агента, который её выполнит. Оценка действует, пока не изменился текст задачи вместе с номером. Чтобы переопределить профиль, укажите в поле «Профиль» High или Medium и закоммитьте файл; чтобы задачу оценили заново, удалите её раздел.";
/** Описание задачи может содержать табуляцию, но не перевод строки. */
const HEADING_BREAKING_CHARACTER = /(?!\t)[\p{Cc}\p{Zl}\p{Zp}]/u;
/** Сколько номеров задач и символов цитаты помещается в сообщение пользователю. */
const LISTED_TASKS = 12;
const QUOTED_LENGTH = 120;

export class TaskProfilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskProfilesError";
  }
}

/** Полное описание задачи из OpenSpec: заголовок её раздела в файле. */
const taskHeadingSchema = z
  .string()
  .min(1)
  .max(MAX_TASK_DESCRIPTION_LENGTH, `Описание задачи длиннее ${MAX_TASK_DESCRIPTION_LENGTH} символов`)
  .refine(
    (value) => !HEADING_BREAKING_CHARACTER.test(value) && value === value.trim(),
    "Описание задачи должно занимать одну строку без управляющих символов",
  )
  .refine(
    (value) => TASK_NUMBER_PREFIX.test(value),
    "Описание задачи должно начинаться с её номера",
  );

/**
 * Назначение профиля задаче.
 *
 * - `assessed` — профиль назначен оценкой или пользователем;
 * - `escalated` — агент слабого профиля передал задачу профилю
 *   `ESCALATION_PROFILE`; исходное обоснование оценки сохраняется.
 */
export type TaskProfileAssignment =
  | {
      readonly kind: "assessed";
      readonly profile: TaskProfileName;
      readonly rationale: string;
    }
  | {
      readonly kind: "escalated";
      readonly rationale: string;
      readonly reason: string;
    };

export interface TaskProfileRecord {
  readonly taskNumber: string;
  /** Полное описание задачи: оценка действует, только пока оно не изменилось. */
  readonly heading: string;
  readonly assignment: TaskProfileAssignment;
}

/** Задача, как её видит выбор профиля. */
export interface ProfileTask {
  readonly number: string;
  readonly description: string;
}

export function assignedProfile(assignment: TaskProfileAssignment): TaskProfileName {
  switch (assignment.kind) {
    case "assessed":
      return assignment.profile;
    case "escalated":
      return ESCALATION_PROFILE;
  }
}

/** Профиль выполнения задачи по её записи в файле профилей. */
export function executionProfileFor(record: TaskProfileRecord): TaskExecutionProfile {
  const { assignment } = record;
  switch (assignment.kind) {
    case "assessed":
      return { profile: assignment.profile, escalationReason: null };
    case "escalated":
      return { profile: ESCALATION_PROFILE, escalationReason: assignment.reason };
  }
}

/** Оценка, действующая для задачи: её раздел озаглавлен текущим описанием задачи. */
export function recordForTask(
  records: readonly TaskProfileRecord[],
  task: ProfileTask,
): TaskProfileRecord | null {
  return records.find(({ heading }) => heading === task.description) ?? null;
}

/** Задачи без действующей оценки, в порядке исполнения. */
export function unassessedTasks(
  tasks: readonly ProfileTask[],
  records: readonly TaskProfileRecord[],
): readonly ProfileTask[] {
  return tasks.filter((task) => recordForTask(records, task) === null);
}

/** Вход MCP-инструмента сессии оценки. */
export const taskProfilesInputSchema = z
  .object({
    assessments: z
      .array(
        z
          .object({
            taskNumber: taskNumberSchema,
            profile: taskProfileNameSchema,
            rationale: taskProfileTextSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_TASKS),
  })
  .strict();

export type TaskProfilesInput = z.output<typeof taskProfilesInputSchema>;

/**
 * Проверяет, что оценки покрывают ровно задачи сессии, и связывает их с
 * описаниями задач.
 */
export function bindTaskProfiles(
  tasks: readonly ProfileTask[],
  input: TaskProfilesInput,
): readonly TaskProfileRecord[] {
  const byNumber = new Map<string, TaskProfilesInput["assessments"][number]>();
  for (const assessment of input.assessments) {
    if (byNumber.has(assessment.taskNumber)) {
      throw new TaskProfilesError(
        `Оценка задачи ${assessment.taskNumber} передана больше одного раза`,
      );
    }
    byNumber.set(assessment.taskNumber, assessment);
  }
  const expected = new Set(tasks.map(({ number }) => number));
  const unexpected = [...byNumber.keys()].filter((number) => !expected.has(number));
  if (unexpected.length > 0) {
    throw new TaskProfilesError(
      `Оценки переданы для задач вне этой сессии: ${listTaskNumbers(unexpected)}`,
    );
  }
  const missing = tasks.filter(({ number }) => !byNumber.has(number)).map(({ number }) => number);
  if (missing.length > 0) {
    throw new TaskProfilesError(`Нет оценки задач: ${listTaskNumbers(missing)}`);
  }
  return Object.freeze(
    tasks.map((task) => {
      const { profile, rationale } = byNumber.get(task.number)!;
      return Object.freeze({
        taskNumber: task.number,
        heading: parseTaskHeading(task),
        assignment: Object.freeze({ kind: "assessed" as const, profile, rationale }),
      });
    }),
  );
}

/**
 * Файл после записи новых оценок: оценка задачи с тем же номером заменяется на
 * месте, остальные новые оценки добавляются в конец. Оценки завершённых задач
 * остаются записью о том, каким профилем они выполнены.
 */
export function mergeTaskProfiles(
  existing: readonly TaskProfileRecord[],
  added: readonly TaskProfileRecord[],
): readonly TaskProfileRecord[] {
  const addedByNumber = new Map(added.map((record) => [record.taskNumber, record]));
  const merged = existing.map((record) => addedByNumber.get(record.taskNumber) ?? record);
  const replaced = new Set(existing.map(({ taskNumber }) => taskNumber));
  return Object.freeze([
    ...merged,
    ...added.filter(({ taskNumber }) => !replaced.has(taskNumber)),
  ]);
}

/**
 * Файл после эскалации задачи. Эскалировать можно только задачу, которой
 * оценка назначила профиль слабее `ESCALATION_PROFILE`.
 */
export function escalateTaskProfile(
  records: readonly TaskProfileRecord[],
  task: ProfileTask,
  reasonInput: string,
): readonly TaskProfileRecord[] {
  const record = recordForTask(records, task);
  if (!record) {
    throw new TaskProfilesError(
      `${TASK_PROFILES_FILE_NAME} не содержит оценку задачи ${task.number}`,
    );
  }
  if (assignedProfile(record.assignment) === ESCALATION_PROFILE) {
    throw new TaskProfilesError(
      `Задаче ${task.number} уже назначен профиль ${ESCALATION_PROFILE}`,
    );
  }
  const parsed = taskProfileTextSchema.safeParse(reasonInput);
  if (!parsed.success) {
    throw new TaskProfilesError(
      `Причина эскалации некорректна: ${parsed.error.issues[0]?.message ?? "неизвестная ошибка"}`,
    );
  }
  const escalated: TaskProfileRecord = Object.freeze({
    ...record,
    assignment: Object.freeze({
      kind: "escalated" as const,
      rationale: record.assignment.rationale,
      reason: parsed.data,
    }),
  });
  return Object.freeze(records.map((candidate) => (candidate === record ? escalated : candidate)));
}

export function sameTaskProfiles(
  left: readonly TaskProfileRecord[],
  right: readonly TaskProfileRecord[],
): boolean {
  return renderSections(left) === renderSections(right);
}

/** Номера задач для сообщения: длинный список сокращается. */
export function listTaskNumbers(numbers: readonly string[]): string {
  if (numbers.length <= LISTED_TASKS) return numbers.join(", ");
  return `${numbers.slice(0, LISTED_TASKS).join(", ")} и ещё ${numbers.length - LISTED_TASKS}`;
}

/** Цитата строки файла в сообщении об ошибке: строка может быть очень длинной. */
function quote(line: string): string {
  return line.length <= QUOTED_LENGTH ? line : `${line.slice(0, QUOTED_LENGTH - 1)}…`;
}

/** Краткая сводка профилей для истории workflow. */
export function summarizeTaskProfiles(records: readonly TaskProfileRecord[]): string {
  return TASK_PROFILE_NAMES.map((profile) => [
    profile,
    listTaskNumbers(
      records
        .filter(({ assignment }) => assignedProfile(assignment) === profile)
        .map(({ taskNumber }) => taskNumber),
    ),
  ])
    .filter(([, list]) => list !== "")
    .map(([profile, list]) => `${profile}: ${list}`)
    .join("; ");
}

export function renderTaskProfiles(records: readonly TaskProfileRecord[]): string {
  const sections = renderSections(records);
  return `${FILE_TITLE}\n\n${FORMAT_MARKER}\n\n${PREAMBLE}\n${sections.length > 0 ? `\n${sections}` : ""}`;
}

function renderSections(records: readonly TaskProfileRecord[]): string {
  return records.map(renderSection).join("\n");
}

const PROFILE_FIELD = "Профиль";
const RATIONALE_FIELD = "Обоснование";
const ESCALATION_FIELD = `Эскалация на ${ESCALATION_PROFILE}`;

function renderSection(record: TaskProfileRecord): string {
  const { assignment } = record;
  const fields: (readonly [string, string])[] = [
    [PROFILE_FIELD, assignedProfile(assignment)],
    [RATIONALE_FIELD, assignment.rationale],
  ];
  if (assignment.kind === "escalated") fields.push([ESCALATION_FIELD, assignment.reason]);
  const lines = fields.map(([label, value]) => `- **${label}:** ${value}`).join("\n");
  return `## ${record.heading}\n\n${lines}\n`;
}

/**
 * Строго разбирает файл профилей. Любое отклонение от формата — ошибка с
 * объяснением: файл может отредактировать пользователь, и молча пропущенная
 * правка запустила бы задачу не тем профилем, который он ожидает.
 */
export function parseTaskProfiles(source: string): readonly TaskProfileRecord[] {
  const fail: (detail: string) => never = (detail) => {
    throw new TaskProfilesError(`${TASK_PROFILES_FILE_NAME}: ${detail}`);
  };
  const lines = source.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n").split("\n");
  if (lines[0] !== FILE_TITLE) fail(`первая строка должна быть «${FILE_TITLE}»`);

  let index = 1;
  let markerSeen = false;
  for (; index < lines.length && !lines[index]!.startsWith("## "); index += 1) {
    const line = lines[index]!;
    if (line === FORMAT_MARKER) {
      if (markerSeen) fail("служебный marker формата повторяется");
      markerSeen = true;
    } else if (line.startsWith("#") || line.includes("<!--")) {
      fail(`неожиданная строка перед профилями: «${quote(line)}»`);
    }
  }
  if (!markerSeen) fail("нет служебного marker формата");

  const records: TaskProfileRecord[] = [];
  const taskNumbers = new Set<string>();
  while (index < lines.length) {
    const headingLine = lines[index]!;
    const heading = taskHeadingSchema.safeParse(headingLine.slice("## ".length));
    if (!heading.success) return fail(`некорректный заголовок задачи «${quote(headingLine)}»`);
    const taskNumber = taskNumberSchema.safeParse(TASK_NUMBER_PREFIX.exec(heading.data)?.[1]);
    if (!taskNumber.success) return fail(`некорректный номер задачи в заголовке «${quote(headingLine)}»`);
    if (taskNumbers.has(taskNumber.data)) fail(`профиль задачи ${taskNumber.data} повторяется`);
    taskNumbers.add(taskNumber.data);
    if (records.length >= MAX_TASKS) fail("слишком много задач");

    index += 1;
    const fieldLines: string[] = [];
    for (; index < lines.length && !lines[index]!.startsWith("## "); index += 1) {
      const line = lines[index]!;
      if (line.trim() === "") continue;
      if (line.startsWith("#")) fail(`неожиданный заголовок «${quote(line)}» в профиле задачи ${taskNumber.data}`);
      fieldLines.push(line);
    }
    records.push(
      Object.freeze({
        taskNumber: taskNumber.data,
        heading: heading.data,
        assignment: parseAssignment(taskNumber.data, fieldLines, fail),
      }),
    );
  }
  return Object.freeze(records);
}

function parseAssignment(
  taskNumber: string,
  lines: readonly string[],
  fail: (detail: string) => never,
): TaskProfileAssignment {
  const read = (position: number, label: string): string => {
    const prefix = `- **${label}:** `;
    const line = lines[position];
    if (line === undefined || !line.startsWith(prefix)) {
      return fail(`в профиле задачи ${taskNumber} строка ${position + 1} должна начинаться с «${prefix.trim()}»`);
    }
    return line.slice(prefix.length);
  };
  if (lines.length !== 2 && lines.length !== 3) {
    return fail(`в профиле задачи ${taskNumber} должно быть 2 или 3 строки полей`);
  }
  const profile = taskProfileNameSchema.safeParse(read(0, PROFILE_FIELD));
  if (!profile.success) {
    return fail(
      `в профиле задачи ${taskNumber} поле «${PROFILE_FIELD}» должно быть одним из: ${TASK_PROFILE_NAMES.join(", ")}`,
    );
  }
  const text = (position: number, label: string): string => {
    const parsed = taskProfileTextSchema.safeParse(read(position, label));
    if (!parsed.success) {
      return fail(
        `в профиле задачи ${taskNumber} поле «${label}» некорректно: ${parsed.error.issues[0]?.message ?? "неизвестная ошибка"}`,
      );
    }
    return parsed.data;
  };
  const rationale = text(1, RATIONALE_FIELD);
  if (lines.length === 2) {
    return Object.freeze({ kind: "assessed", profile: profile.data, rationale });
  }
  const reason = text(2, ESCALATION_FIELD);
  if (profile.data !== ESCALATION_PROFILE) {
    return fail(
      `в профиле задачи ${taskNumber} после эскалации поле «${PROFILE_FIELD}» должно быть ${ESCALATION_PROFILE}; чтобы вернуть другой профиль, удалите строку «${ESCALATION_FIELD}»`,
    );
  }
  return Object.freeze({ kind: "escalated", rationale, reason });
}

/**
 * Проверяет, что задачи можно записать в файл профилей. Вызывается до запуска
 * агента оценки: описание задачи он исправить не может.
 */
export function assertProfileTaskHeadings(tasks: readonly ProfileTask[]): void {
  for (const task of tasks) parseTaskHeading(task);
}

function parseTaskHeading(task: ProfileTask): string {
  const heading = taskHeadingSchema.safeParse(task.description);
  if (!heading.success) {
    throw new TaskProfilesError(
      `Задачу ${task.number} нельзя записать в ${TASK_PROFILES_FILE_NAME}: ${heading.error.issues[0]?.message ?? "некорректное описание"}`,
    );
  }
  return heading.data;
}
