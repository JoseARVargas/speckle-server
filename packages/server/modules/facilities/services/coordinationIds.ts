import type { Knex } from 'knex'
import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { BadRequestError } from '@/modules/shared/errors'
import type {
  CoordIdsRuleDefinition,
  CoordRuleRecord,
  CoordRuleSetRecord,
  CoordSeverity
} from '@/modules/facilities/helpers/coordinationTypes'
import { COORD_LIMITS } from '@/modules/facilities/helpers/coordinationTypes'
import {
  deleteRulesOfVersionFactory,
  getDraftVersionFactory,
  getMaxVersionNumberFactory,
  insertRuleSetFactory,
  insertRuleSetVersionFactory,
  insertRulesFactory,
  updateRuleSetVersionFactory
} from '@/modules/facilities/repositories/coordination'
import {
  newCoordId,
  resolveRequirementLabelsFactory,
  splitRequirementLabel
} from '@/modules/facilities/services/coordination'

/**
 * IDS 1.0 (buildingSMART Information Delivery Specification) import. The
 * XML is parsed only to validate its shape and to build readable rule
 * summaries; the actual validation runs in the Python worker (IfcTester)
 * against the verbatim XML stored on the rule set version.
 */

// ---- parsing (A05: no DTD, no entities, bounded size) ----------------------

const ARRAY_TAGS = new Set([
  'specification',
  'entity',
  'attribute',
  'property',
  'classification',
  'material',
  'partOf',
  'enumeration'
])

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ARRAY_TAGS.has(name)
})

type XmlNode = Record<string, unknown>

const asNode = (v: unknown): XmlNode | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as XmlNode) : null

const asArray = (v: unknown): XmlNode[] =>
  Array.isArray(v) ? v.map(asNode).filter((n): n is XmlNode => !!n) : []

const attr = (node: XmlNode | null, name: string) => {
  const v = node?.[`@_${name}`]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

const text = (v: unknown) => (typeof v === 'string' ? v : asNode(v)?.['#text'])

/** <simpleValue> or an <xs:restriction> (enumeration / pattern / bounds) as text. */
const describeValue = (v: unknown): string | null => {
  const node = asNode(v)
  if (!node) return null
  const simple = text(node.simpleValue)
  if (typeof simple === 'string' && simple) return simple
  const restriction = asNode(
    Array.isArray(node.restriction) ? node.restriction[0] : node.restriction
  )
  if (!restriction) return null
  const options = asArray(restriction.enumeration)
    .map((e) => attr(e, 'value'))
    .filter(Boolean)
  if (options.length) return `um de ${options.join(', ')}`
  const parts: string[] = []
  const bound = (tag: string, label: string) => {
    const b = asNode(restriction[tag])
    const value = attr(b, 'value')
    if (value) parts.push(`${label} ${value}`)
  }
  bound('pattern', 'padrão')
  bound('minInclusive', '≥')
  bound('minExclusive', '>')
  bound('maxInclusive', '≤')
  bound('maxExclusive', '<')
  bound('length', 'tamanho')
  bound('minLength', 'tamanho ≥')
  bound('maxLength', 'tamanho ≤')
  return parts.length ? parts.join(' e ') : null
}

type FacetGroup = { facets: string[]; entityCount: number; cardinalities: string[] }

/** Readable summary of the facets inside <applicability> or <requirements>. */
const describeFacets = (
  group: XmlNode | null,
  withCardinality: boolean
): FacetGroup => {
  const out: FacetGroup = { facets: [], entityCount: 0, cardinalities: [] }
  if (!group) return out
  const push = (facet: XmlNode, description: string) => {
    const cardinality = attr(facet, 'cardinality') ?? 'required'
    if (withCardinality) out.cardinalities.push(cardinality)
    const prefix = !withCardinality
      ? ''
      : cardinality === 'prohibited'
      ? 'não deve ter '
      : cardinality === 'optional'
      ? '(opcional) '
      : ''
    out.facets.push(prefix + description)
  }
  for (const f of asArray(group.entity)) {
    out.entityCount++
    const type = describeValue(f.predefinedType)
    push(f, `classe ${describeValue(f.name) ?? '?'}${type ? ` (${type})` : ''}`)
  }
  for (const f of asArray(group.attribute)) {
    const value = describeValue(f.value)
    push(
      f,
      `atributo ${describeValue(f.name) ?? '?'}${value ? ` = ${value}` : ' preenchido'}`
    )
  }
  for (const f of asArray(group.property)) {
    const value = describeValue(f.value)
    const name = `${describeValue(f.propertySet) ?? '?'}.${
      describeValue(f.baseName) ?? '?'
    }`
    push(f, `${name}${value ? ` = ${value}` : ' preenchida'}`)
  }
  for (const f of asArray(group.classification)) {
    const system = describeValue(f.system)
    const value = describeValue(f.value)
    push(f, `classificação${system ? ` ${system}` : ''}${value ? ` = ${value}` : ''}`)
  }
  for (const f of asArray(group.material)) {
    const value = describeValue(f.value)
    push(f, `material${value ? ` = ${value}` : ' informado'}`)
  }
  for (const f of asArray(group.partOf)) {
    const parent = asArray(f.entity)[0] ?? null
    const relation = attr(f, 'relation')
    push(
      f,
      `parte de ${describeValue(parent?.name) ?? '?'}${
        relation ? ` (${relation})` : ''
      }`
    )
  }
  return out
}

export type ParsedIdsSpecification = {
  index: number
  name: string
  identifier: string | null
  ifcVersion: string | null
  severity: CoordSeverity
  applicability: string
  requirements: string
}

export type ParsedIds = {
  title: string | null
  specifications: ParsedIdsSpecification[]
}

/**
 * Validates and summarizes an IDS document. Throws BadRequestError with a
 * pt-BR message on anything the importer refuses.
 */
export const parseIdsDocument = (xml: string): ParsedIds => {
  if (Buffer.byteLength(xml, 'utf8') > COORD_LIMITS.maxIdsBytes) {
    throw new BadRequestError('Arquivo IDS grande demais (limite de 2 MB)')
  }
  // A05/XXE: IDS files never need a DTD; refuse instead of trying to sanitize
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new BadRequestError('Arquivo IDS com DTD ou entidades não é aceito')
  }
  const valid = XMLValidator.validate(xml)
  if (valid !== true) {
    throw new BadRequestError(`Arquivo IDS com XML inválido (linha ${valid.err.line})`)
  }
  const doc = asNode(parser.parse(xml))
  const root = asNode(doc?.ids)
  if (!root) throw new BadRequestError('O arquivo não é um IDS (raiz <ids> ausente)')

  const specs = asArray(asNode(root.specifications)?.specification)
  if (!specs.length) throw new BadRequestError('O IDS não tem especificações')
  if (specs.length > COORD_LIMITS.maxIdsSpecifications) {
    throw new BadRequestError(
      `O IDS tem ${specs.length} especificações; o limite é ${COORD_LIMITS.maxIdsSpecifications}`
    )
  }

  const withoutEntity: string[] = []
  const specifications = specs.map((spec, index) => {
    const name = attr(spec, 'name') ?? `Especificação ${index + 1}`
    const applicability = describeFacets(asNode(spec.applicability), false)
    const requirements = describeFacets(asNode(spec.requirements), true)
    // Without an entity facet IfcTester walks the whole model per spec (spec §6.1)
    if (!applicability.entityCount) withoutEntity.push(name)
    const allOptional =
      requirements.cardinalities.length > 0 &&
      requirements.cardinalities.every((c) => c === 'optional')
    return {
      index,
      name: name.slice(0, 200),
      identifier: attr(spec, 'identifier')?.slice(0, 100) ?? null,
      ifcVersion: attr(spec, 'ifcVersion'),
      severity: (allOptional ? 'warning' : 'error') as CoordSeverity,
      applicability: (applicability.facets.join(' e ') || 'todos os elementos').slice(
        0,
        4000
      ),
      requirements: (requirements.facets.join(' e ') || 'sem requisitos').slice(0, 4000)
    }
  })
  if (withoutEntity.length) {
    throw new BadRequestError(
      `Especificações sem faceta de entidade na aplicabilidade: ${withoutEntity
        .slice(0, 5)
        .join(
          ', '
        )}. Adicione a classe IFC (ex.: IFCWALL) para a validação não percorrer o modelo inteiro.`
    )
  }

  const info = asNode(root.info)
  const title = text(info?.title)
  return {
    title: typeof title === 'string' && title ? title.slice(0, 200) : null,
    specifications
  }
}

// ---- import ----------------------------------------------------------------

/** Requirement code of a specification: its identifier, or "EIR 4.2 — ..." in the name. */
const requirementLabelOf = (spec: ParsedIdsSpecification) => {
  if (spec.identifier) return spec.identifier
  const split = splitRequirementLabel(spec.name)
  return split.code !== split.title ? spec.name : null
}

export const importIdsRuleSetFactory =
  (deps: { db: Knex }) =>
  async (p: {
    projectId: string
    xml: string
    userId: string
    name?: string | null
    milestoneId?: string | null
    /** Re-import into an existing IDS rule set as its new draft */
    ruleSet?: CoordRuleSetRecord | null
  }) => {
    const parsed = parseIdsDocument(p.xml)
    if (p.ruleSet && p.ruleSet.format !== 'ids') {
      throw new BadRequestError('Só é possível reimportar IDS num conjunto do tipo IDS')
    }

    const milestoneId = p.ruleSet ? p.ruleSet.milestoneId : p.milestoneId ?? null
    const { requirementIds, createdRequirements } =
      await resolveRequirementLabelsFactory(deps)({
        projectId: p.projectId,
        milestoneId,
        labels: parsed.specifications.map(requirementLabelOf)
      })

    const ruleSet =
      p.ruleSet ??
      (await insertRuleSetFactory(deps)({
        id: newCoordId(),
        projectId: p.projectId,
        name: (p.name?.trim() || parsed.title || 'Conjunto IDS').slice(0, 200),
        format: 'ids',
        milestoneId,
        purpose: null,
        createdBy: p.userId,
        createdAt: new Date(),
        updatedAt: new Date()
      }))

    // The IDS replaces the whole draft: drop the old draft's rules, keep its row
    let draft = await getDraftVersionFactory(deps)({ ruleSetId: ruleSet.id })
    if (draft) {
      await deleteRulesOfVersionFactory(deps)({ ruleSetVersionId: draft.id })
      draft = await updateRuleSetVersionFactory(deps)({
        id: draft.id,
        update: { idsXml: p.xml }
      })
    } else {
      const max = await getMaxVersionNumberFactory(deps)({ ruleSetId: ruleSet.id })
      draft = await insertRuleSetVersionFactory(deps)({
        id: newCoordId(),
        projectId: p.projectId,
        ruleSetId: ruleSet.id,
        version: max + 1,
        status: 'draft',
        publishedAt: null,
        publishedBy: null,
        idsXml: p.xml,
        createdAt: new Date(),
        updatedAt: new Date()
      })
    }

    const usedCodes = new Set<string>()
    const uniqueCode = (wanted: string) => {
      let code = wanted.slice(0, 60)
      for (let i = 2; usedCodes.has(code.toLowerCase()); i++) {
        code = `${wanted.slice(0, 55)}-${i}`
      }
      usedCodes.add(code.toLowerCase())
      return code
    }

    const rules: CoordRuleRecord[] = parsed.specifications.map((spec) => {
      const label = requirementLabelOf(spec)
      const definition: CoordIdsRuleDefinition = {
        kind: 'ids',
        specIndex: spec.index,
        ifcVersion: spec.ifcVersion,
        applicability: spec.applicability,
        requirements: spec.requirements
      }
      return {
        id: newCoordId(),
        projectId: p.projectId,
        ruleSetVersionId: draft.id,
        code: uniqueCode(spec.identifier ?? `IDS-${spec.index + 1}`),
        name: spec.name,
        requirementId: label
          ? requirementIds.get(splitRequirementLabel(label).code.toLowerCase()) ?? null
          : null,
        severity: spec.severity,
        weight: 1,
        definition,
        position: spec.index,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    await insertRulesFactory(deps)(rules)

    return {
      ruleSet,
      createdRequirements,
      specifications: parsed.specifications.length
    }
  }
