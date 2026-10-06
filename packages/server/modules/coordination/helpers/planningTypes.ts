import type { Nullable } from '@speckle/shared'
import { z } from 'zod'

/**
 * Information delivery planning (ISO 19650 MIDP/TIDP). See
 * officio-bim-coordination/.ai/plans/2026-10-06-planejamento-iso19650.md.
 */

// ---- limits (A06) -----------------------------------------------------------

export const PLANNING_LIMITS = {
  maxCodesPerField: 200,
  maxDeliverablesPerProject: 5_000,
  maxImportRows: 5_000,
  maxRequirementsPerDeliverable: 200,
  maxDeliverablesPage: 500,
  /** retries when two writers take the same sequential number */
  numberRetries: 3
} as const

// ---- naming (ISO 19650-2 container name fields) -----------------------------

export const NamingFields = [
  'project',
  'originator',
  'volume',
  'level',
  'type',
  'role'
] as const
export type NamingField = (typeof NamingFields)[number]

/** Container name: Project-Originator-Volume-Level-Type-Role-Number */
export const NUMBER_DIGITS = 4

export const buildContainerName = (
  codes: Record<NamingField, string>,
  number: number
) =>
  [
    ...NamingFields.map((f) => codes[f]),
    String(number).padStart(NUMBER_DIGITS, '0')
  ].join('-')

const codeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{1,6}$/, 'use de 1 a 6 letras ou números')

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null))

const codeListSchema = z
  .array(z.object({ code: codeSchema, description: optionalText(200) }).strict())
  .max(PLANNING_LIMITS.maxCodesPerField)
  .default([])

export const namingFieldsInputSchema = z
  .object({
    project: codeListSchema,
    originator: codeListSchema,
    volume: codeListSchema,
    level: codeListSchema,
    type: codeListSchema,
    role: codeListSchema
  })
  .strict()
  .superRefine((input, ctx) => {
    for (const field of NamingFields) {
      const seen = new Set<string>()
      for (const [i, item] of input[field].entries()) {
        if (seen.has(item.code)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field, i, 'code'],
            message: `código "${item.code}" repetido`
          })
        }
        seen.add(item.code)
      }
    }
  })
export type NamingFieldsInput = z.infer<typeof namingFieldsInputSchema>

// ---- deliverables -----------------------------------------------------------

export const DeliverableKinds = [
  'model',
  'drawing',
  'document',
  'schedule',
  'other'
] as const
export type DeliverableKind = (typeof DeliverableKinds)[number]

export const DeliverableStatuses = [
  'planned',
  'in_progress',
  'delivered',
  'accepted',
  'rejected'
] as const
export type DeliverableStatus = (typeof DeliverableStatuses)[number]

const idSchema = z.string().trim().min(1).max(10)

export const deliverableInputSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    kind: z.enum(DeliverableKinds),
    project: codeSchema,
    originator: codeSchema,
    volume: codeSchema,
    level: codeSchema,
    type: codeSchema,
    role: codeSchema,
    /** omitted = next free number for the same field combination */
    number: z.number().int().min(1).max(999_999).nullish(),
    milestoneId: idSchema.nullish(),
    responsibleUserId: idSchema.nullish(),
    modelId: idSchema.nullish(),
    dueDate: z.coerce.date().nullish(),
    status: z.enum(DeliverableStatuses).default('planned'),
    notes: optionalText(2000),
    requirementIds: z
      .array(idSchema)
      .max(PLANNING_LIMITS.maxRequirementsPerDeliverable)
      .default([])
  })
  .strict()
export type DeliverableInput = z.infer<typeof deliverableInputSchema>

/**
 * One CSV row as mapped by the app. References use the names people write in
 * a spreadsheet (milestone name, requirement codes), resolved by the server.
 */
export const deliverableImportRowSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    kind: z.enum(DeliverableKinds).default('model'),
    project: codeSchema,
    originator: codeSchema,
    volume: codeSchema,
    level: codeSchema,
    type: codeSchema,
    role: codeSchema,
    number: z.coerce.number().int().min(1).max(999_999).nullish(),
    milestone: optionalText(200),
    dueDate: z.coerce.date().nullish(),
    requirementCodes: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
    notes: optionalText(2000)
  })
  .strict()
export type DeliverableImportRow = z.infer<typeof deliverableImportRowSchema>

// ---- records ----------------------------------------------------------------

export type CoordNamingCodeRecord = {
  projectId: string
  field: NamingField
  code: string
  description: Nullable<string>
  position: number
}

export type CoordDeliverableRecord = {
  id: string
  projectId: string
  containerName: string
  title: string
  kind: DeliverableKind
  project: string
  originator: string
  volume: string
  level: string
  type: string
  role: string
  number: number
  milestoneId: Nullable<string>
  responsibleUserId: Nullable<string>
  modelId: Nullable<string>
  dueDate: Nullable<Date>
  status: DeliverableStatus
  notes: Nullable<string>
  createdBy: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type CoordDeliverableRequirementRecord = {
  deliverableId: string
  requirementId: string
}

export type DeliverableFilter = {
  originator?: Nullable<string>
  role?: Nullable<string>
  milestoneId?: Nullable<string>
  status?: Nullable<DeliverableStatus>
}
