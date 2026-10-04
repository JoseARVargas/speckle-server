/* eslint-disable camelcase */
// Operator names (not_exists, equals_property...) are the WHERE/CHECK rule format.
import type {
  CoordCondition,
  CoordElementStatus,
  CoordPathMatch,
  CoordResultStatus,
  CoordRuleDefinition,
  CoordSeverity
} from '@/modules/coordination/helpers/coordinationTypes'
import { inferPathMatch } from '@/modules/coordination/helpers/coordinationTypes'

/**
 * Pure evaluation of WHERE/CHECK rules (the native "model check" format,
 * modelled on speckle-automate-checker) against one Speckle object's JSON.
 * No I/O here - the runner feeds objects in and persists what comes out.
 */

const MAX_DEPTH = 10
const MAX_LEAVES_PER_OBJECT = 5000
const MAX_TESTED_VALUE_LENGTH = 512
const MAX_REPORTED_VALUES = 3

/** Keys that are geometry, children or Speckle internals, never properties. */
const SKIPPED_KEYS = new Set(['displayValue', '@displayValue', 'elements', '@elements'])

export type Leaf = {
  segments: string[]
  /** `name` of a parameter object ({ name, value, units }) - matches as the last segment too */
  alias: string | null
  value: unknown
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const isPrimitive = (v: unknown) => v === null || typeof v !== 'object'

/**
 * Revit/IFC connectors store parameters as { name, value, units, ... }; such
 * an object is one property whose value is `.value`, not a branch to walk.
 */
const isParameterObject = (v: Record<string, unknown>) =>
  'value' in v && isPrimitive(v.value) && ('name' in v || 'units' in v)

/**
 * Flattens an object into (path, value) leaves. Parameter objects collapse
 * into one leaf, primitive arrays yield one leaf per item, and detached
 * references / geometry / internals are skipped.
 */
export const flattenLeaves = (obj: Record<string, unknown>): Leaf[] => {
  const leaves: Leaf[] = []
  const walk = (value: unknown, segments: string[], depth: number) => {
    if (leaves.length >= MAX_LEAVES_PER_OBJECT) return
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (isPrimitive(item)) leaves.push({ segments, alias: null, value: item })
        else if (depth < MAX_DEPTH) walk(item, [...segments, String(i)], depth + 1)
      })
      return
    }
    if (isPlainObject(value)) {
      if (typeof value.referencedId === 'string') return // detached child
      if (segments.length && isParameterObject(value)) {
        leaves.push({
          segments,
          alias: typeof value.name === 'string' ? value.name : null,
          value: value.value
        })
        return
      }
      if (depth >= MAX_DEPTH) return
      for (const [key, child] of Object.entries(value)) {
        if (key.startsWith('__') || SKIPPED_KEYS.has(key)) continue
        walk(child, [...segments, key], depth + 1)
      }
      return
    }
    leaves.push({ segments, alias: null, value })
  }
  walk(obj, [], 0)
  return leaves
}

const norm = (s: string) => s.trim().toLowerCase()

type PathMatcher = (leaf: Leaf) => boolean

const compilePathMatcher = (path: string, match: CoordPathMatch): PathMatcher => {
  if (match === 'regex') {
    const re = new RegExp(path)
    return (leaf) => re.test(leaf.segments.join('.'))
  }
  if (match === 'suffix') {
    const parts = path.replace(/^\*\./, '').split('.').map(norm)
    return (leaf) => {
      const segs = leaf.segments
      if (segs.length < parts.length) return false
      const offset = segs.length - parts.length
      for (let i = 0; i < parts.length; i++) {
        const seg = norm(segs[offset + i])
        const isLast = i === parts.length - 1
        if (seg === parts[i]) continue
        if (isLast && leaf.alias !== null && norm(leaf.alias) === parts[i]) continue
        return false
      }
      return true
    }
  }
  return (leaf) => leaf.segments.join('.') === path
}

const isEmptyValue = (v: unknown) =>
  v === null || v === undefined || (typeof v === 'string' && !v.trim())

/** "25 mm" -> 25, "25,5" -> 25.5, 3 -> 3; anything else -> null. */
export const toNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^[-+]?\d+(?:[.,]\d+)?/)
  return m ? Number(m[0].replace(',', '.')) : null
}

const toText = (v: unknown) => String(v).slice(0, MAX_TESTED_VALUE_LENGTH)

const valuesEqual = (actual: unknown, expected: unknown) => {
  if (typeof expected === 'number') {
    const n = toNumber(actual)
    return n !== null && Math.abs(n - expected) < 1e-9
  }
  if (typeof expected === 'boolean') {
    if (typeof actual === 'boolean') return actual === expected
    return norm(toText(actual)) === String(expected)
  }
  return norm(toText(actual)) === norm(toText(expected))
}

export type ConditionOutcome = {
  passed: boolean
  /** Up to 3 values found at the condition's path, after label mapping */
  values: unknown[]
  message: string | null
}

type CompiledCondition = {
  source: CoordCondition
  evaluate: (leaves: Leaf[]) => ConditionOutcome
}

const compileCondition = (cond: CoordCondition): CompiledCondition => {
  const matches = compilePathMatcher(cond.path, cond.match ?? inferPathMatch(cond.path))
  const mapEntries = cond.map
    ? Object.entries(cond.map).map(([k, v]) => [norm(k), v] as const)
    : null
  const applyMap = (v: unknown) => {
    if (!mapEntries) return v
    const key = norm(toText(v))
    const hit = mapEntries.find(([k]) => k === key)
    return hit ? hit[1] : v
  }
  const candidatesOf = (leaves: Leaf[], matcher: PathMatcher) =>
    leaves
      .filter((l) => matcher(l) && !isEmptyValue(l.value))
      .map((l) => applyMap(l.value))

  const regex = cond.op === 'regex' ? new RegExp(String(cond.value)) : null
  const otherMatcher =
    cond.op === 'equals_property' && isPlainObject(cond.value)
      ? compilePathMatcher(
          String(cond.value.path),
          (cond.value.match as CoordPathMatch | undefined) ??
            inferPathMatch(String(cond.value.path))
        )
      : null

  const evaluate = (leaves: Leaf[]): ConditionOutcome => {
    const candidates = candidatesOf(leaves, matches)
    const values = candidates.slice(0, MAX_REPORTED_VALUES)
    const result = (passed: boolean, message: string | null = null) => ({
      passed,
      values,
      message: passed ? null : message
    })

    if (cond.op === 'exists')
      return result(candidates.length > 0, 'propriedade ausente')
    if (cond.op === 'not_exists')
      return result(candidates.length === 0, 'propriedade existe')
    if (!candidates.length) return result(false, 'propriedade ausente')

    switch (cond.op) {
      case 'equals':
        return result(
          candidates.some((c) => valuesEqual(c, cond.value)),
          'valor diferente do esperado'
        )
      case 'not_equals':
        return result(
          !candidates.some((c) => valuesEqual(c, cond.value)),
          'valor igual ao proibido'
        )
      case 'in': {
        const options = Array.isArray(cond.value) ? cond.value : []
        return result(
          candidates.some((c) => options.some((o) => valuesEqual(c, o))),
          'valor fora da lista permitida'
        )
      }
      case 'regex':
        return result(
          candidates.some((c) => regex!.test(toText(c))),
          'valor não corresponde ao padrão'
        )
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
      case 'between': {
        const numbers = candidates.map(toNumber).filter((n): n is number => n !== null)
        if (!numbers.length) return result(false, 'valor não numérico')
        const test = (n: number) => {
          const v = cond.value
          if (cond.op === 'between' && Array.isArray(v)) {
            return n >= Number(v[0]) && n <= Number(v[1])
          }
          const x = Number(v)
          if (cond.op === 'gt') return n > x
          if (cond.op === 'gte') return n >= x
          if (cond.op === 'lt') return n < x
          return n <= x
        }
        return result(numbers.some(test), 'valor fora do intervalo')
      }
      case 'equals_property': {
        const others = otherMatcher ? candidatesOf(leaves, otherMatcher) : []
        if (!others.length) return result(false, 'propriedade de comparação ausente')
        return result(
          candidates.some((c) => others.some((o) => valuesEqual(c, o))),
          'propriedades diferentes'
        )
      }
    }
    return result(false, 'operador desconhecido')
  }

  return { source: cond, evaluate }
}

// ---- rules ------------------------------------------------------------------

export type EngineRule = {
  id: string
  severity: CoordSeverity
  weight: number
  definition: CoordRuleDefinition
}

export type CompiledRule = {
  id: string
  severity: CoordSeverity
  weight: number
  where: CompiledCondition[]
  check: CompiledCondition[]
}

export const compileRule = (rule: EngineRule): CompiledRule => ({
  id: rule.id,
  severity: rule.severity,
  weight: rule.weight,
  where: rule.definition.where.map(compileCondition),
  check: rule.definition.check.map(compileCondition)
})

export type RuleResult = {
  ruleId: string
  status: CoordResultStatus
  actualValue: unknown[] | null
  message: string | null
}

export type ElementEvaluation = {
  results: RuleResult[]
  status: CoordElementStatus
  /** Weighted share of applicable rules passed; null when no rule applies */
  score: number | null
}

/** True when every WHERE condition holds (an empty WHERE applies to all). */
export const matchesWhere = (where: CompiledCondition[], leaves: Leaf[]) =>
  where.every((c) => c.evaluate(leaves).passed)

export const evaluateElement = (
  rules: CompiledRule[],
  obj: Record<string, unknown>
): ElementEvaluation => {
  const leaves = flattenLeaves(obj)
  const results: RuleResult[] = []
  let applicableWeight = 0
  let passedWeight = 0
  let hasError = false
  let hasWarning = false

  for (const rule of rules) {
    if (!matchesWhere(rule.where, leaves)) continue
    const outcomes = rule.check.map((c) => c.evaluate(leaves))
    const failed = outcomes.find((o) => !o.passed)
    const reported = failed ?? outcomes[0]
    const status: CoordResultStatus = !failed
      ? 'pass'
      : rule.severity === 'error'
      ? 'fail'
      : 'warn'
    applicableWeight += rule.weight
    if (status === 'pass') passedWeight += rule.weight
    else if (status === 'fail') hasError = true
    else hasWarning = true
    results.push({
      ruleId: rule.id,
      status,
      actualValue: reported.values.length ? reported.values : null,
      message: failed?.message ?? null
    })
  }

  if (!results.length) return { results, status: 'na', score: null }
  return {
    results,
    status: hasError ? 'fail' : hasWarning ? 'warn' : 'pass',
    score: applicableWeight > 0 ? passedWeight / applicableWeight : null
  }
}

// ---- human readable summaries (pt-BR, shown as "Esperado" in the UI) ------

const OP_LABELS: Record<CoordCondition['op'], string> = {
  exists: 'existe',
  not_exists: 'não existe',
  equals: 'é igual a',
  not_equals: 'é diferente de',
  in: 'está em',
  regex: 'corresponde a',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  between: 'está entre',
  equals_property: 'é igual a'
}

const formatValue = (cond: CoordCondition) => {
  const v = cond.value
  if (cond.op === 'exists' || cond.op === 'not_exists') return ''
  if (cond.op === 'between' && Array.isArray(v)) return `${v[0]} e ${v[1]}`
  if (Array.isArray(v)) return v.join(', ')
  if (isPlainObject(v)) return String(v.path)
  return String(v)
}

export const describeCondition = (cond: CoordCondition) => {
  const value = formatValue(cond)
  return [cond.path, OP_LABELS[cond.op], value].filter(Boolean).join(' ')
}

/** "Onde <where>, verificar se <check>" - the sentence shown under a rule. */
export const describeRule = (definition: CoordRuleDefinition) => {
  const check = definition.check.map(describeCondition).join(' e ')
  if (!definition.where.length) return `Verificar se ${check}`
  return `Onde ${definition.where
    .map(describeCondition)
    .join(' e ')}, verificar se ${check}`
}

/** Just the CHECK part - the "Esperado" column of an element's results. */
export const describeExpected = (definition: CoordRuleDefinition) =>
  definition.check.map(describeCondition).join(' e ')
