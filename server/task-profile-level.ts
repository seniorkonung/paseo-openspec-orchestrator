import { z } from "zod";
import type { RequiredAgentProfileName } from "./agent-profiles.ts";

/** Профили, которым оркестратор поручает OpenSpec-задачи. */
export const TASK_PROFILE_NAMES = Object.freeze([
  "High",
  "Medium",
] as const satisfies readonly RequiredAgentProfileName[]);

export type TaskProfileName = (typeof TASK_PROFILE_NAMES)[number];

/** Профиль, на который эскалирует задачу более слабый профиль. */
export const ESCALATION_PROFILE = "High" satisfies TaskProfileName;

export const taskProfileNameSchema = z.enum(TASK_PROFILE_NAMES);

export const MAX_TASK_PROFILE_TEXT_LENGTH = 2_000;

const CONTROL_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const RUSSIAN_CHARACTER = /[А-Яа-яЁё]/u;

/** Однострочный русский текст обоснования или причины без служебных маркеров. */
export const taskProfileTextSchema = z
  .string()
  .max(MAX_TASK_PROFILE_TEXT_LENGTH)
  .refine(
    (value) => !CONTROL_CHARACTER.test(value),
    "Текст должен занимать одну строку без управляющих символов",
  )
  .transform((value) => value.trim())
  .pipe(z.string().min(1).max(MAX_TASK_PROFILE_TEXT_LENGTH))
  .refine((value) => RUSSIAN_CHARACTER.test(value), "Текст должен быть на русском языке")
  .refine(
    (value) => !value.includes("<!--") && !value.includes("-->"),
    "Текст содержит служебный marker",
  );
