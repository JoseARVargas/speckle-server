import type { Knex } from 'knex'
import { BadRequestError } from '@/modules/shared/errors'
import type {
  CoordCondition,
  CoordRequirementRecord,
  CoordRequirementSpec,
  CoordRuleRecord,
  CoordRuleSetRecord
} from '@/modules/coordination/helpers/coordinationTypes'
import {
  COORD_LIMITS,
  GENERATED_RULE_SET_NAME,
  coordRequirementSpecSchema,
  inferPathMatch
} from '@/modules/coordination/helpers/coordinationTypes'
import {
  deleteRulesOfVersionFactory,
  getGeneratedRuleSetFactory,
  insertRuleSetFactory,
  insertRulesFactory,
  listLatestSucceededRunsFactory,
  listRequirementStatsFactory,
  listRequirementsFactory,
  updateRequirementFactory
} from '@/modules/coordination/repositories/coordination'
import {
  ensureDraftFactory,
  isUniqueViolation,
  newCoordId,
  parseOrBadRequest
} from '@/modules/coordination/services/coordination'
import { describeRule } from '@/modules/coordination/services/coordinationEngine'
import { parseIdsDocument } from '@/modules/coordination/services/coordinationIds'

/**
 * Requirement -> verification (Fase 2c of
 * officio-bim-coordination/.ai/plans/2026-10-06-fase2-search-sets-bsdd-ids.md):
 * the requirement's specification becomes a Model Check rule ("Gerar regras"),
 * an IDS specification ("Exportar IDS") and, through the run stats, the
 * compliance shown on the MIDP.
 */

// ---- specification ----------------------------------------------------------

/** The class filter a rule gets from the specification's IFC classes. */
const classCondition = (classes: string[]): CoordCondition[] =>
  classes.length ? [{ path: 'ifcType', match: 'exact', op: 'in', value: classes }] : []

export const parseRequirementSpec = (input: unknown): CoordRequirementSpec => {
  const spec = parseOrBadRequest(coordRequirementSpecSchema, input, 'Especificação')
  // The classes become one more WHERE condition of the generated rule
  if (
    spec.ifcClasses.length &&
    spec.where.length >= COORD_LIMITS.maxConditionsPerList
  ) {
    throw new BadRequestError(
      `Com classes IFC, a especificação aceita no máximo ${
        COORD_LIMITS.maxConditionsPerList - 1
      } condições de escopo`
    )
  }
  return spec
}

/** "Em IfcColumn, IfcBeam: Onde ..., verificar se ..." */
export const describeRequirementSpec = (spec: CoordRequirementSpec) => {
  const rule = describeRule({ where: spec.where, check: spec.check })
  return spec.ifcClasses.length ? `Em ${spec.ifcClasses.join(', ')}: ${rule}` : rule
}

export const setRequirementSpecFactory =
  (deps: { db: Knex }) =>
  async (p: { requirement: CoordRequirementRecord; spec: unknown }) =>
    await updateRequirementFactory(deps)({
      id: p.requirement.id,
      update: {
        spec:
          p.spec === null || p.spec === undefined ? null : parseRequirementSpec(p.spec)
      }
    })

// ---- "Gerar regras" -----------------------------------------------------------

const RULE_NAME_MAX = 200

const generatedRuleSetFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string; userId: string }): Promise<CoordRuleSetRecord> => {
    const existing = await getGeneratedRuleSetFactory(deps)({
      projectId: p.projectId,
      generatedFrom: 'requirements'
    })
    if (existing) return existing
    // The name is unique per project: a set the user already called that way
    // pushes the generated one to "(2)", "(3)"...
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await insertRuleSetFactory(deps)({
          id: newCoordId(),
          projectId: p.projectId,
          name:
            attempt === 1
              ? GENERATED_RULE_SET_NAME
              : `${GENERATED_RULE_SET_NAME} (${attempt})`,
          format: 'native',
          milestoneId: null,
          purpose: 'Gerado a partir das especificações dos requisitos',
          generatedFrom: 'requirements',
          createdBy: p.userId,
          createdAt: new Date(),
          updatedAt: new Date()
        })
      } catch (err) {
        if (!isUniqueViolation(err)) throw err
        // A concurrent "Gerar regras" may have created it meanwhile
        const raced = await getGeneratedRuleSetFactory(deps)({
          projectId: p.projectId,
          generatedFrom: 'requirements'
        })
        if (raced) return raced
      }
    }
    throw new BadRequestError('Não foi possível criar o conjunto de regras gerado')
  }

/**
 * Rewrites the draft of the managed rule set with one rule per requirement
 * that has a specification. The published version stays as it was: the user
 * reviews and publishes like any other set. Hand edits in that draft are
 * replaced (the app warns before).
 */
export const generateRequirementRulesFactory =
  (deps: { db: Knex }) => async (p: { projectId: string; userId: string }) => {
    const requirements = await listRequirementsFactory(deps)({ projectId: p.projectId })
    const withSpec = requirements.filter((r) => r.spec)
    if (!withSpec.length) {
      throw new BadRequestError(
        'Nenhum requisito tem especificação verificável; descreva ao menos um antes de gerar'
      )
    }
    if (withSpec.length > COORD_LIMITS.maxRulesPerVersion) {
      throw new BadRequestError(
        `São ${withSpec.length} requisitos com especificação; um conjunto aceita no máximo ${COORD_LIMITS.maxRulesPerVersion} regras`
      )
    }
    const ruleSet = await generatedRuleSetFactory(deps)(p)
    const draft = await ensureDraftFactory(deps)(ruleSet)
    const rules: CoordRuleRecord[] = withSpec.map((requirement, position) => {
      // Stored specs were validated when saved; parse again so an old shape
      // fails here, not later in the runner
      const spec = coordRequirementSpecSchema.parse(requirement.spec)
      return {
        id: newCoordId(),
        projectId: p.projectId,
        ruleSetVersionId: draft.id,
        code: requirement.code,
        name: requirement.title.slice(0, RULE_NAME_MAX),
        requirementId: requirement.id,
        severity: spec.severity,
        weight: 1,
        definition: {
          where: [...classCondition(spec.ifcClasses), ...spec.where],
          check: spec.check
        },
        position,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    await deps.db.transaction(async (trx) => {
      await deleteRulesOfVersionFactory({ db: trx })({ ruleSetVersionId: draft.id })
      await insertRulesFactory({ db: trx })(rules)
    })
    return {
      ruleSet,
      generated: rules.length,
      skipped: requirements.filter((r) => !r.spec).map((r) => r.code)
    }
  }

// ---- "Exportar IDS" -----------------------------------------------------------

const IDS_IFC_VERSIONS = 'IFC2X3 IFC4 IFC4X3_ADD2'

const xmlEscape = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')

class NotExportable extends Error {}

type FacetTarget =
  | { kind: 'attribute'; name: string }
  | { kind: 'property'; propertySet: string; baseName: string }

/**
 * Where an IFC import puts things (see the plan): attributes under
 * properties.Attributes, Psets under properties["Property Sets"], quantities
 * under properties.Quantities. Only those map onto IDS facets.
 */
const facetTargetOf = (cond: CoordCondition): FacetTarget => {
  const match = cond.match ?? inferPathMatch(cond.path)
  if (match === 'regex') {
    throw new NotExportable(
      `caminho por regex (${cond.path}) não tem equivalente no IDS`
    )
  }
  const segments = cond.path.replace(/^\*\./, '').split('.')
  const fromGroup = (group: string[], rest: string[]): FacetTarget | null => {
    if (group[0] === 'Attributes' && rest.length === 1) {
      return { kind: 'attribute', name: rest[0] }
    }
    if (
      (group[0] === 'Property Sets' || group[0] === 'Quantities') &&
      rest.length === 2
    ) {
      return { kind: 'property', propertySet: rest[0], baseName: rest[1] }
    }
    return null
  }
  if (match === 'exact') {
    const target =
      segments[0] === 'properties' ? fromGroup([segments[1]], segments.slice(2)) : null
    if (target) return target
  } else {
    // suffix: *.Attributes.Name, *.Pset_X.Prop or *.Property Sets.Pset_X.Prop
    const target =
      segments.length >= 3
        ? fromGroup([segments[segments.length - 3]], segments.slice(-2))
        : null
    if (target) return target
    if (segments.length === 2 && segments[0] === 'Attributes') {
      return { kind: 'attribute', name: segments[1] }
    }
    if (segments.length === 2) {
      return { kind: 'property', propertySet: segments[0], baseName: segments[1] }
    }
  }
  throw new NotExportable(
    `o caminho ${cond.path} não é um atributo IFC nem Pset.Propriedade (ex.: *.Pset_WallCommon.FireRating)`
  )
}

/** JS regex (unanchored, as the engine tests it) -> XSD pattern (anchored). */
const xsdPattern = (pattern: string) => {
  if (/\(\?|\\[bB]|[*+?}]\?/.test(pattern)) {
    throw new NotExportable(
      `a regex ${pattern} usa recursos sem equivalente no XSD (grupos (?…), \\b ou quantificador preguiçoso)`
    )
  }
  let body = pattern
  const starts = body.startsWith('^')
  const ends = body.endsWith('$') && !body.endsWith('\\$')
  if (starts) body = body.slice(1)
  if (ends) body = body.slice(0, -1)
  if (/(^|[^\\])[\^$]/.test(body)) {
    throw new NotExportable(`a regex ${pattern} tem âncoras no meio`)
  }
  return `${starts ? '' : '.*'}${body}${ends ? '' : '.*'}`
}

const simple = (v: string) => `<simpleValue>${xmlEscape(v)}</simpleValue>`

const restriction = (base: string, inner: string) =>
  `<xs:restriction base="${base}">${inner}</xs:restriction>`

/** The <value> of a facet, or '' when the condition only asks for presence. */
const valueXml = (cond: CoordCondition) => {
  const v = cond.value
  switch (cond.op) {
    case 'exists':
    case 'not_exists':
      return ''
    case 'equals':
      return `<value>${simple(String(v))}</value>`
    case 'in': {
      const values = Array.isArray(v) ? v : []
      const numeric = values.every((x) => typeof x === 'number')
      return `<value>${restriction(
        numeric ? 'xs:double' : 'xs:string',
        values.map((x) => `<xs:enumeration value="${xmlEscape(String(x))}"/>`).join('')
      )}</value>`
    }
    case 'regex':
      return `<value>${restriction(
        'xs:string',
        `<xs:pattern value="${xmlEscape(xsdPattern(String(v)))}"/>`
      )}</value>`
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const tag = {
        gt: 'minExclusive',
        gte: 'minInclusive',
        lt: 'maxExclusive',
        lte: 'maxInclusive'
      }[cond.op]
      return `<value>${restriction(
        'xs:double',
        `<xs:${tag} value="${Number(v)}"/>`
      )}</value>`
    }
    case 'between': {
      const [min, max] = Array.isArray(v) ? v.map(Number) : [NaN, NaN]
      return `<value>${restriction(
        'xs:double',
        `<xs:minInclusive value="${min}"/><xs:maxInclusive value="${max}"/>`
      )}</value>`
    }
    default:
      throw new NotExportable(`o operador "${cond.op}" não tem equivalente no IDS`)
  }
}

type Facet = { kind: FacetTarget['kind']; xml: string }

const facetXml = (cond: CoordCondition, inRequirements: boolean): Facet => {
  if (cond.map) {
    throw new NotExportable(`o mapeamento de rótulos em ${cond.path} não existe no IDS`)
  }
  if (cond.op === 'not_equals' || cond.op === 'equals_property') {
    throw new NotExportable(`o operador "${cond.op}" não tem equivalente no IDS`)
  }
  if (cond.op === 'not_exists' && !inRequirements) {
    throw new NotExportable(
      `"não existe" no escopo (${cond.path}) não tem equivalente na aplicabilidade do IDS`
    )
  }
  const target = facetTargetOf(cond)
  const cardinality = inRequirements
    ? ` cardinality="${cond.op === 'not_exists' ? 'prohibited' : 'required'}"`
    : ''
  const value = valueXml(cond)
  if (target.kind === 'attribute') {
    return {
      kind: 'attribute',
      xml: `<attribute${cardinality}><name>${simple(
        target.name
      )}</name>${value}</attribute>`
    }
  }
  return {
    kind: 'property',
    xml: `<property${cardinality}><propertySet>${simple(
      target.propertySet
    )}</propertySet><baseName>${simple(target.baseName)}</baseName>${value}</property>`
  }
}

/** IDS 1.0 facet order inside applicability/requirements (XSD sequence). */
const orderFacets = (facets: Facet[]) =>
  [
    ...facets.filter((f) => f.kind === 'attribute'),
    ...facets.filter((f) => f.kind === 'property')
  ]
    .map((f) => f.xml)
    .join('')

const entityClassesOf = (spec: CoordRequirementSpec) => {
  let classes = spec.ifcClasses.map((c) => c.toUpperCase())
  for (const cond of spec.where.filter((c) => c.path === 'ifcType')) {
    const values =
      cond.op === 'equals' ? [cond.value] : cond.op === 'in' ? cond.value : null
    if (!Array.isArray(values)) {
      throw new NotExportable(
        'o filtro de ifcType só vai para o IDS com "é igual a" ou "está em"'
      )
    }
    const named = values.map((v) => String(v).toUpperCase())
    // Classes and an ifcType condition are AND-ed: keep what both allow
    classes = classes.length ? classes.filter((c) => named.includes(c)) : named
  }
  if (!classes.length) {
    throw new NotExportable(
      'sem classe IFC: informe as classes a que o requisito se aplica'
    )
  }
  return classes
}

const specificationXml = (
  requirement: CoordRequirementRecord,
  spec: CoordRequirementSpec
) => {
  if (spec.check.some((c) => c.path === 'ifcType')) {
    throw new NotExportable(
      'verificar ifcType não tem equivalente nos requisitos do IDS'
    )
  }
  const classes = entityClassesOf(spec)
  const entityName =
    classes.length === 1
      ? simple(classes[0])
      : restriction(
          'xs:string',
          classes.map((c) => `<xs:enumeration value="${xmlEscape(c)}"/>`).join('')
        )
  const applicability =
    `<entity><name>${entityName}</name></entity>` +
    orderFacets(
      spec.where.filter((c) => c.path !== 'ifcType').map((c) => facetXml(c, false))
    )
  const requirements = orderFacets(spec.check.map((c) => facetXml(c, true)))
  return (
    `<specification name="${xmlEscape(
      requirement.title
    )}" ifcVersion="${IDS_IFC_VERSIONS}"` +
    ` identifier="${xmlEscape(requirement.code)}">` +
    `<applicability minOccurs="0" maxOccurs="unbounded">${applicability}</applicability>` +
    `<requirements>${requirements}</requirements></specification>`
  )
}

export type RequirementsIdsExport = {
  xml: string | null
  exported: string[]
  notExported: { code: string; reason: string }[]
}

/**
 * IDS 1.0 of the requirements whose specification fits the IDS facets (IFC
 * entity + attributes/Pset properties with presence, equality, list, regex
 * or numeric bounds). Everything else is listed with the reason. The XML is
 * checked by our own IDS parser before it leaves the server.
 */
export const buildRequirementsIds = (p: {
  title: string
  requirements: CoordRequirementRecord[]
  date?: Date
}): RequirementsIdsExport => {
  const specs: string[] = []
  const exported: string[] = []
  const notExported: { code: string; reason: string }[] = []
  for (const requirement of p.requirements) {
    if (!requirement.spec) {
      notExported.push({
        code: requirement.code,
        reason: 'sem especificação verificável'
      })
      continue
    }
    try {
      const spec = coordRequirementSpecSchema.parse(requirement.spec)
      specs.push(specificationXml(requirement, spec))
      exported.push(requirement.code)
    } catch (err) {
      if (!(err instanceof NotExportable)) throw err
      notExported.push({ code: requirement.code, reason: err.message })
    }
  }
  if (!specs.length) return { xml: null, exported, notExported }
  if (specs.length > COORD_LIMITS.maxIdsSpecifications) {
    throw new BadRequestError(
      `São ${specs.length} especificações; o limite do IDS é ${COORD_LIMITS.maxIdsSpecifications}`
    )
  }
  const date = (p.date ?? new Date()).toISOString().slice(0, 10)
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<ids xmlns="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema"` +
    ` xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
    ` xsi:schemaLocation="http://standards.buildingsmart.org/IDS http://standards.buildingsmart.org/IDS/1.0/ids.xsd">` +
    `<info><title>${xmlEscape(p.title)}</title><date>${date}</date></info>` +
    `<specifications>${specs.join('')}</specifications></ids>\n`
  // Our importer is stricter than the XSD on purpose (entity facet required,
  // size limits): what we export must come back in
  parseIdsDocument(xml)
  return { xml, exported, notExported }
}

export const exportRequirementsIdsFactory =
  (deps: { db: Knex }) =>
  async (p: {
    projectId: string
    projectName: string
    milestoneId?: string | null
  }) => {
    const requirements = await listRequirementsFactory(deps)({
      projectId: p.projectId,
      milestoneId: p.milestoneId
    })
    return buildRequirementsIds({
      title: `Requisitos de informação · ${p.projectName}`.slice(0, 200),
      requirements
    })
  }

// ---- MIDP compliance --------------------------------------------------------

export type DeliverableComplianceStatus =
  | 'no_model'
  | 'no_requirements'
  | 'no_run'
  | 'met'
  | 'partial'
  | 'below'

export type DeliverableRequirementCompliance = {
  requirement: CoordRequirementRecord
  applicable: number
  passed: number
  adherence: number | null
  met: boolean | null
}

export type DeliverableCompliance = {
  status: DeliverableComplianceStatus
  adherence: number | null
  requirements: DeliverableRequirementCompliance[]
}

/** Per (model, requirement): applicable/passed summed over the latest runs. */
export type ProjectRunStats = Map<
  string,
  Map<string, { applicable: number; passed: number }>
>

export const loadProjectRunStatsFactory =
  (deps: { db: Knex }) =>
  async (p: { projectId: string }): Promise<ProjectRunStats> => {
    const runs = await listLatestSucceededRunsFactory(deps)({ projectId: p.projectId })
    const modelOfRun = new Map(runs.map((r) => [r.id, r.modelId]))
    const stats = await listRequirementStatsFactory(deps)({
      runIds: runs.map((r) => r.id)
    })
    const out: ProjectRunStats = new Map()
    for (const s of stats) {
      const modelId = modelOfRun.get(s.runId)!
      const byRequirement = out.get(modelId) ?? new Map()
      const t = byRequirement.get(s.requirementId) ?? { applicable: 0, passed: 0 }
      t.applicable += s.applicableCount
      t.passed += s.passCount
      byRequirement.set(s.requirementId, t)
      out.set(modelId, byRequirement)
    }
    return out
  }

/**
 * How the deliverable's model does, in its latest Model Check runs, on the
 * requirements the deliverable must meet - each against its own target.
 * Read only: changing the deliverable status from it is Fase 3b.
 */
export const deliverableCompliance = (p: {
  modelId: string | null
  requirements: CoordRequirementRecord[]
  stats: ProjectRunStats
}): DeliverableCompliance => {
  if (!p.modelId) return { status: 'no_model', adherence: null, requirements: [] }
  if (!p.requirements.length) {
    return { status: 'no_requirements', adherence: null, requirements: [] }
  }
  const byRequirement = p.stats.get(p.modelId) ?? new Map()
  let applicable = 0
  let passed = 0
  const requirements = p.requirements.map((requirement) => {
    const t = byRequirement.get(requirement.id) ?? { applicable: 0, passed: 0 }
    applicable += t.applicable
    passed += t.passed
    const adherence = t.applicable ? t.passed / t.applicable : null
    return {
      requirement,
      applicable: t.applicable,
      passed: t.passed,
      adherence,
      met: adherence === null ? null : adherence * 100 >= requirement.targetPct
    }
  })
  const measured = requirements.filter((r) => r.met !== null)
  const status: DeliverableComplianceStatus = !measured.length
    ? 'no_run'
    : measured.some((r) => !r.met)
    ? 'below'
    : measured.length < requirements.length
    ? 'partial'
    : 'met'
  return {
    status,
    adherence: applicable ? passed / applicable : null,
    requirements
  }
}
