import { z } from 'zod'

/**
 * ISO 19650 CDE (common data environment) states per model version. The
 * project can rename states, add its own (each one belongs to one ISO stage)
 * and change suitability codes and the revision scheme; the stage is what the
 * flow rules and the MIDP status are based on.
 */
export const CdeStages = ['wip', 'shared', 'published', 'archived'] as const
export type CdeStage = (typeof CdeStages)[number]

export const CdeActions = [
  'created',
  'advanced',
  'shared',
  'published',
  'rejected',
  'archived'
] as const
export type CdeAction = (typeof CdeActions)[number]

/** manual: a person; automatic: a Model Check criterion; exception: published
 * below target with a justification; system: version created / superseded. */
export type CdeKind = 'manual' | 'automatic' | 'exception' | 'system'

export const CDE_LIMITS = {
  maxStates: 20,
  maxCodesPerStage: 20,
  maxComment: 1000,
  maxApprovers: 50,
  maxRevisionDigits: 4
} as const

const stateSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(
        /^[A-Za-z0-9_-]{1,20}$/,
        'Código de estado: até 20 letras, números, _ ou -'
      ),
    label: z.string().trim().min(1).max(60),
    stage: z.enum(CdeStages),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .nullish(),
    active: z.boolean().default(true)
  })
  .strict()

const codeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9]{1,6}$/, 'Código de adequação: até 6 letras ou números'),
    label: z.string().trim().min(1).max(80),
    active: z.boolean().default(true)
  })
  .strict()

export const cdeConfigSchema = z
  .object({
    /** In flow order; within a stage, a version moves to the next active state. */
    states: z.array(stateSchema).min(4).max(CDE_LIMITS.maxStates),
    suitability: z
      .object({
        shared: z.array(codeSchema).min(1).max(CDE_LIMITS.maxCodesPerStage),
        published: z.array(codeSchema).min(1).max(CDE_LIMITS.maxCodesPerStage)
      })
      .strict(),
    revision: z
      .object({
        sharedPrefix: z.string().regex(/^[A-Za-z]{1,3}$/),
        publishedPrefix: z.string().regex(/^[A-Za-z]{1,3}$/),
        digits: z.number().int().min(1).max(CDE_LIMITS.maxRevisionDigits)
      })
      .strict(),
    /** Publishing needs the Model Check target met, or a justification. */
    requireAdherenceToPublish: z.boolean(),
    /** A shared version below target goes back to WIP by itself. */
    autoRejectBelowTarget: z.boolean()
  })
  .strict()
  .superRefine((config, ctx) => {
    const codes = config.states.map((s) => s.code.toUpperCase())
    if (new Set(codes).size !== codes.length) {
      ctx.addIssue({ code: 'custom', message: 'Códigos de estado repetidos' })
    }
    for (const stage of CdeStages) {
      if (!config.states.some((s) => s.stage === stage && s.active)) {
        ctx.addIssue({
          code: 'custom',
          message: `Falta um estado ativo na etapa ${stage}`
        })
      }
    }
    // states of a stage are contiguous, in ISO order
    const order = config.states.map((s) => CdeStages.indexOf(s.stage))
    if (order.some((stage, i) => i > 0 && stage < order[i - 1])) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Os estados precisam seguir a ordem WIP → Shared → Published → Archived'
      })
    }
    for (const list of [config.suitability.shared, config.suitability.published]) {
      const c = list.map((s) => s.code.toUpperCase())
      if (new Set(c).size !== c.length) {
        ctx.addIssue({ code: 'custom', message: 'Códigos de adequação repetidos' })
      }
      if (!list.some((s) => s.active)) {
        ctx.addIssue({ code: 'custom', message: 'Falta um código de adequação ativo' })
      }
    }
  })

export type CdeConfig = z.infer<typeof cdeConfigSchema>
export type CdeState = CdeConfig['states'][number]

/**
 * UK National Annex to ISO 19650-2 (market default): S0 = WIP, S1-S4 shared
 * purposes, A1… / B published, P01… preliminary and C01… contractual revisions.
 */
export const DEFAULT_CDE_CONFIG: CdeConfig = {
  states: [
    {
      code: 'WIP',
      label: 'Em produção (WIP)',
      stage: 'wip',
      color: '#64748b',
      active: true
    },
    {
      code: 'SHARED',
      label: 'Compartilhado',
      stage: 'shared',
      color: '#2563eb',
      active: true
    },
    {
      code: 'PUBLISHED',
      label: 'Publicado',
      stage: 'published',
      color: '#16a34a',
      active: true
    },
    {
      code: 'ARCHIVED',
      label: 'Arquivado',
      stage: 'archived',
      color: '#9ca3af',
      active: true
    }
  ],
  suitability: {
    shared: [
      { code: 'S1', label: 'Adequado para coordenação', active: true },
      { code: 'S2', label: 'Adequado para informação', active: true },
      { code: 'S3', label: 'Adequado para revisão e comentários', active: true },
      { code: 'S4', label: 'Adequado para aprovação', active: true }
    ],
    published: [
      { code: 'A1', label: 'Aceito (etapa 1)', active: true },
      { code: 'A2', label: 'Aceito (etapa 2)', active: true },
      { code: 'A3', label: 'Aceito (etapa 3)', active: true },
      { code: 'B', label: 'Aceito parcialmente, com comentários', active: true }
    ]
  },
  revision: { sharedPrefix: 'P', publishedPrefix: 'C', digits: 2 },
  requireAdherenceToPublish: false,
  autoRejectBelowTarget: false
}

export type CoordCdeConfigRecord = {
  projectId: string
  config: CdeConfig
  updatedBy: string | null
  updatedAt: Date
}

export type CoordProjectApproverRecord = {
  projectId: string
  userId: string
  createdBy: string | null
  createdAt: Date
}

export type CoordVersionStateRecord = {
  id: string
  projectId: string
  modelId: string
  versionId: string
  deliverableId: string | null
  stage: CdeStage
  stateCode: string
  stateLabel: string
  suitability: string | null
  revision: string | null
  action: CdeAction
  kind: CdeKind
  comment: string | null
  changedBy: string | null
  changedAt: Date
}

export const transitionInputSchema = z
  .object({
    toStateCode: z.string().trim().min(1).max(20),
    suitability: z.string().trim().max(6).nullish(),
    comment: z.string().trim().max(CDE_LIMITS.maxComment).nullish(),
    /** Publishing below the Model Check target (requireAdherenceToPublish). */
    justification: z.string().trim().max(CDE_LIMITS.maxComment).nullish()
  })
  .strict()

export type TransitionInput = z.infer<typeof transitionInputSchema>
