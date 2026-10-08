import type { Nullable } from '@speckle/shared'
import { z } from 'zod'

// ---- limits (A06: bound what a rule author can make the server do) ---------

export const COORD_LIMITS = {
  maxRulesPerVersion: 200,
  maxConditionsPerList: 20,
  maxValuesPerList: 100,
  maxPathLength: 300,
  maxRegexLength: 200,
  maxStringValueLength: 500,
  maxImportBytes: 1024 * 1024,
  maxQueuedRunsPerProject: 20,
  maxManualRunsPerProjectPerHour: 30,
  maxElementsPerRun: 200_000,
  maxRunSeconds: 15 * 60,
  keptFullResultRuns: 10,
  maxIdsBytes: 2 * 1024 * 1024,
  maxIdsSpecifications: 200
} as const

// ---- rule definition --------------------------------------------------------

export const CoordPathMatchModes = ['exact', 'suffix', 'regex'] as const
export type CoordPathMatch = (typeof CoordPathMatchModes)[number]

export const CoordOperators = [
  'exists',
  'not_exists',
  'equals',
  'not_equals',
  'in',
  'regex',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'equals_property'
] as const
export type CoordOperator = (typeof CoordOperators)[number]

/**
 * Patterns with nested quantifiers or backreferences are the classic
 * catastrophic-backtracking shapes - rejected up front, since rule regexes
 * run server-side over every element of a model (ReDoS, A05/A06).
 */
export const getUnsafeRegexReason = (pattern: string): string | null => {
  if (pattern.length > COORD_LIMITS.maxRegexLength) {
    return `regex longer than ${COORD_LIMITS.maxRegexLength} characters`
  }
  if (/\\[1-9]/.test(pattern) || /\\k</.test(pattern)) {
    return 'regex backreferences are not allowed'
  }
  // A quantified group that itself contains a quantifier: (a+)+, (a*)*, (a|b+){2,}
  if (/\([^()]*[+*}][^()]*\)\s*[+*{]/.test(pattern)) {
    return 'nested quantifiers are not allowed'
  }
  try {
    new RegExp(pattern)
  } catch {
    return 'invalid regex'
  }
  return null
}

const scalar = z.union([
  z.string().max(COORD_LIMITS.maxStringValueLength),
  z.number().finite(),
  z.boolean()
])

const pathRefSchema = z
  .object({
    path: z.string().trim().min(1).max(COORD_LIMITS.maxPathLength),
    match: z.enum(CoordPathMatchModes).optional()
  })
  .strict()

export const coordConditionSchema = z
  .object({
    path: z.string().trim().min(1).max(COORD_LIMITS.maxPathLength),
    match: z.enum(CoordPathMatchModes).optional(),
    op: z.enum(CoordOperators),
    value: z
      .union([
        scalar,
        z.array(scalar).max(COORD_LIMITS.maxValuesPerList),
        pathRefSchema
      ])
      .optional(),
    map: z
      .record(z.string().max(COORD_LIMITS.maxStringValueLength), scalar)
      .optional()
      .refine((m) => !m || Object.keys(m).length <= COORD_LIMITS.maxValuesPerList, {
        message: `map supports at most ${COORD_LIMITS.maxValuesPerList} entries`
      })
  })
  .strict()
  .superRefine((cond, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    const v = cond.value
    switch (cond.op) {
      case 'exists':
      case 'not_exists':
        break
      case 'equals':
      case 'not_equals':
        if (v === undefined || Array.isArray(v) || typeof v === 'object')
          issue(`"${cond.op}" needs a single value`)
        break
      case 'in':
        if (!Array.isArray(v) || !v.length) issue('"in" needs a non-empty list')
        break
      case 'regex': {
        if (typeof v !== 'string') {
          issue('"regex" needs a pattern string')
          break
        }
        const reason = getUnsafeRegexReason(v)
        if (reason) issue(reason)
        break
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
        if (typeof v !== 'number') issue(`"${cond.op}" needs a number`)
        break
      case 'between':
        if (
          !Array.isArray(v) ||
          v.length !== 2 ||
          typeof v[0] !== 'number' ||
          typeof v[1] !== 'number' ||
          v[0] > v[1]
        )
          issue('"between" needs [min, max] with min <= max')
        break
      case 'equals_property':
        if (!v || typeof v !== 'object' || Array.isArray(v))
          issue('"equals_property" needs { path, match }')
        break
    }
    const pathMatch = cond.match ?? inferPathMatch(cond.path)
    if (pathMatch === 'regex') {
      const reason = getUnsafeRegexReason(cond.path)
      if (reason) issue(`path: ${reason}`)
    }
  })

export type CoordCondition = z.infer<typeof coordConditionSchema>

const conditionList = z
  .array(coordConditionSchema)
  .max(COORD_LIMITS.maxConditionsPerList)

export const coordRuleDefinitionSchema = z
  .object({
    where: conditionList.default([]),
    check: conditionList.min(1, 'a rule needs at least one check condition')
  })
  .strict()

export type CoordRuleDefinition = z.infer<typeof coordRuleDefinitionSchema>

/**
 * A rule imported from an IDS <specification>: validated by IfcTester in the
 * Python worker, so only human readable summaries are kept here (the IDS XML
 * itself lives on the rule set version).
 */
export const coordIdsRuleDefinitionSchema = z
  .object({
    kind: z.literal('ids'),
    specIndex: z.number().int().min(0),
    ifcVersion: z.string().max(100).nullable(),
    applicability: z.string().max(4000),
    requirements: z.string().max(4000),
    /** Metadata fields the user changed after import (kept on re-import) */
    edited: z.array(z.enum(['name', 'severity', 'weight', 'requirementId'])).optional()
  })
  .strict()

export type CoordIdsRuleDefinition = z.infer<typeof coordIdsRuleDefinitionSchema>

/**
 * What can be edited on an IDS rule: its metadata. The validation itself
 * (entities, Psets, values) comes from the IDS XML - change it by re-importing.
 */
export const coordIdsRuleMetadataSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    severity: z.enum(['error', 'warning']),
    weight: z.number().positive().max(100),
    requirementId: z.string().max(10).optional().nullable()
  })
  .strict()

export type CoordIdsEditableField = NonNullable<
  CoordIdsRuleDefinition['edited']
>[number]

export type CoordAnyRuleDefinition = CoordRuleDefinition | CoordIdsRuleDefinition

export const isIdsRuleDefinition = (
  definition: unknown
): definition is CoordIdsRuleDefinition =>
  !!definition &&
  typeof definition === 'object' &&
  (definition as { kind?: unknown }).kind === 'ids'

/**
 * A rule as authored/imported: definition plus metadata. `requirement` is
 * the import form ("EIR 4.2 — Pilares ..."), `requirementId` the edit form.
 */
export const coordRuleInputSchema = z
  .object({
    code: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(200),
    requirement: z.string().trim().max(300).optional().nullable(),
    requirementId: z.string().max(10).optional().nullable(),
    severity: z.enum(['error', 'warning']),
    weight: z.number().positive().max(100).default(1),
    where: conditionList.default([]),
    check: conditionList.min(1, 'a rule needs at least one check condition')
  })
  .strict()

export type CoordRuleInput = z.infer<typeof coordRuleInputSchema>

export const coordRuleSetImportSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    milestone: z.string().trim().max(200).optional().nullable(),
    purpose: z.string().trim().max(300).optional().nullable(),
    rules: z.array(coordRuleInputSchema).max(COORD_LIMITS.maxRulesPerVersion)
  })
  .strict()

/**
 * Verifiable specification of a requirement (Fase 2c): the IFC classes it
 * applies to plus the same WHERE/CHECK conditions as a rule. "Gerar regras"
 * turns it into one rule of the managed rule set; "Exportar IDS" into one
 * IDS specification when it fits the IDS facets.
 */
export const coordRequirementSpecSchema = z
  .object({
    ifcClasses: z
      .array(
        z
          .string()
          .trim()
          .regex(/^Ifc[A-Za-z0-9]{1,60}$/, 'classe IFC inválida (ex.: IfcColumn)')
      )
      .max(COORD_LIMITS.maxValuesPerList)
      .default([]),
    where: conditionList.default([]),
    check: conditionList.min(1, 'a especificação precisa de ao menos uma verificação'),
    severity: z.enum(['error', 'warning']).default('error')
  })
  .strict()

export type CoordRequirementSpec = z.infer<typeof coordRequirementSpecSchema>

/** Name of the managed rule set "Gerar regras" writes (one per project). */
export const GENERATED_RULE_SET_NAME = 'Requisitos do EIR (gerado)'

/** `*.Name` (or `*.A.B`) means suffix matching even when `match` is omitted. */
export const inferPathMatch = (path: string): CoordPathMatch =>
  path.startsWith('*.') ? 'suffix' : 'exact'

// ---- records ------------------------------------------------------------------

export type CoordRequirementSourceKind = 'OIR' | 'AIR' | 'PIR' | 'EIR'
export type CoordSeverity = 'error' | 'warning'
export type CoordRuleSetVersionStatus = 'draft' | 'published'
export type CoordRunTrigger = 'manual' | 'version_created' | 'preview'
/**
 * native: queued -> running -> succeeded | failed | blocked
 * ids:    queued -> ids_running (Python) -> ids_done -> processing (Node)
 *         -> succeeded | failed | blocked
 */
export type CoordRunStatus =
  | 'queued'
  | 'running'
  | 'ids_running'
  | 'ids_done'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'blocked'
export type CoordRunEngine = 'native' | 'ids'
export type CoordResultStatus = 'pass' | 'warn' | 'fail'
export type CoordElementStatus = CoordResultStatus | 'na'

export type CoordRequirementSourceRecord = {
  id: string
  projectId: string
  kind: CoordRequirementSourceKind
  title: string
  document: Nullable<string>
  revision: Nullable<string>
  clause: Nullable<string>
  parentId: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type CoordMilestoneRecord = {
  id: string
  projectId: string
  name: string
  dueDate: Nullable<Date>
  discipline: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type CoordRequirementRecord = {
  id: string
  projectId: string
  sourceId: string
  milestoneId: Nullable<string>
  code: string
  title: string
  discipline: Nullable<string>
  purpose: Nullable<string>
  targetPct: number
  /** Verifiable specification (null = not verifiable yet) */
  spec?: Nullable<CoordRequirementSpec>
  createdAt: Date
  updatedAt: Date
}

export type CoordRuleSetRecord = {
  id: string
  projectId: string
  name: string
  format: 'native' | 'ids'
  milestoneId: Nullable<string>
  purpose: Nullable<string>
  /** 'requirements' = maintained by "Gerar regras"; null = authored */
  generatedFrom?: Nullable<'requirements'>
  createdBy: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type CoordRuleSetVersionRecord = {
  id: string
  projectId: string
  ruleSetId: string
  version: number
  status: CoordRuleSetVersionStatus
  publishedAt: Nullable<Date>
  publishedBy: Nullable<string>
  /** The IDS XML, verbatim (ids rule sets only) */
  idsXml?: Nullable<string>
  createdAt: Date
  updatedAt: Date
}

export type CoordRuleRecord = {
  id: string
  projectId: string
  ruleSetVersionId: string
  code: string
  name: string
  requirementId: Nullable<string>
  severity: CoordSeverity
  weight: number
  definition: CoordAnyRuleDefinition
  position: number
  createdAt: Date
  updatedAt: Date
}

export type CoordRuleSetBindingRecord = {
  projectId: string
  ruleSetId: string
  modelId: string
  autoRun: boolean
  unkeyedBlockPct: number
  createdAt: Date
  updatedAt: Date
}

export type CoordCheckRunRecord = {
  id: string
  projectId: string
  ruleSetId: string
  ruleSetVersionId: string
  modelId: string
  versionId: string
  trigger: CoordRunTrigger
  status: CoordRunStatus
  attempt: number
  createdBy: Nullable<string>
  unkeyedBlockPct: number
  queuedAt: Date
  startedAt: Nullable<Date>
  finishedAt: Nullable<Date>
  error: Nullable<string>
  elementCount: number
  applicableCount: number
  passCount: number
  warnCount: number
  failCount: number
  naCount: number
  unkeyedCount: number
  adherence: Nullable<number>
  unkeyedSample: string[]
  engine: CoordRunEngine
  /** MinIO object key of the version's original IFC (ids runs) */
  ifcObjectKey: Nullable<string>
}

export type CoordCheckResultRecord = {
  runId: string
  ruleId: string
  elementKey: string
  speckleObjectId: Nullable<string>
  status: CoordResultStatus
  actualValue: unknown
  message: Nullable<string>
}

export type CoordElementScoreRecord = {
  runId: string
  elementKey: string
  speckleObjectId: Nullable<string>
  status: CoordElementStatus
  score: Nullable<number>
}

export type CoordRequirementStatRecord = {
  runId: string
  requirementId: string
  applicableCount: number
  passCount: number
}

export type CoordRuleStatRecord = {
  runId: string
  ruleId: string
  applicableCount: number
  passCount: number
  warnCount: number
  failCount: number
}

export type CoordAuditEventRecord = {
  id: string
  projectId: string
  actorId: Nullable<string>
  action: string
  entityType: string
  entityId: string
  data: unknown
  createdAt: Date
}
