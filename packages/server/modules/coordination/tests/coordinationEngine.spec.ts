/* eslint-disable camelcase */
// Fixtures use Speckle's object format (speckle_type).
import { expect } from 'chai'
import type { CoordCondition } from '@/modules/coordination/helpers/coordinationTypes'
import {
  coordConditionSchema,
  coordRuleInputSchema,
  getUnsafeRegexReason
} from '@/modules/coordination/helpers/coordinationTypes'
import {
  compileRule,
  describeRule,
  evaluateElement,
  flattenLeaves,
  toNumber
} from '@/modules/coordination/services/coordinationEngine'

/**
 * Pure WHERE/CHECK engine behind the coordination "model check" - see
 * speckle-digitaltwin-console/.ai/plans/2026-10-01-coordenacao-bim-model-check.md.
 */

// Shaped like a Revit object from the Speckle v3 connector
const column = {
  id: 'obj1',
  applicationId: 'guid-col-1',
  speckle_type: 'Objects.Data.DataObject:Objects.Data.RevitObject',
  category: 'Structural Columns',
  properties: {
    category: 'Structural Columns',
    Parameters: {
      'Instance Parameters': {
        Constraints: {
          Nível: { name: 'Nível', value: 'Térreo', units: null },
          'Base Offset': { name: 'Base Offset', value: '25 mm', units: 'mm' }
        }
      },
      'Type Parameters': {
        Materials: {
          'Classe do Concreto': {
            name: 'Classe do Concreto',
            value: 'C25',
            units: null
          },
          'Fire Rating': { name: 'Fire Rating', value: '60 MIN', units: null }
        }
      }
    },
    Comments: '',
    Tags: ['EST', 'P-12']
  },
  displayValue: [{ referencedId: 'mesh1', speckle_type: 'reference' }]
}

const rule = (
  id: string,
  check: CoordCondition[],
  where: CoordCondition[] = [],
  severity: 'error' | 'warning' = 'error',
  weight = 1
) => compileRule({ id, severity, weight, definition: { where, check } })

const evalOne = (check: CoordCondition, obj: Record<string, unknown> = column) =>
  evaluateElement([rule('r', [check])], obj).results[0]

describe('Coordination engine', () => {
  describe('flattenLeaves', () => {
    it('collapses parameter objects, skips geometry and empty values stay as leaves', () => {
      const leaves = flattenLeaves(column)
      const paths = leaves.map((l) => l.segments.join('.'))
      expect(paths).to.include(
        'properties.Parameters.Type Parameters.Materials.Classe do Concreto'
      )
      expect(paths.some((p) => p.startsWith('displayValue'))).to.equal(false)
      const concrete = leaves.find((l) => l.segments.at(-1) === 'Classe do Concreto')
      expect(concrete?.value).to.equal('C25')
      expect(concrete?.alias).to.equal('Classe do Concreto')
    })

    it('yields one leaf per item of a primitive array', () => {
      const tags = flattenLeaves(column).filter((l) => l.segments.at(-1) === 'Tags')
      expect(tags.map((t) => t.value)).to.deep.equal(['EST', 'P-12'])
    })
  })

  describe('path modes', () => {
    it('exact matches the full dotted path', () => {
      expect(
        evalOne({
          path: 'properties.category',
          op: 'equals',
          value: 'Structural Columns'
        }).status
      ).to.equal('pass')
      expect(evalOne({ path: 'category.x', op: 'exists' }).status).to.equal('fail')
    })

    it('suffix (*.X) matches the last segment, case-insensitively', () => {
      expect(evalOne({ path: '*.classe do concreto', op: 'exists' }).status).to.equal(
        'pass'
      )
      expect(
        evalOne({ path: '*.Materials.Classe do Concreto', op: 'exists' }).status
      ).to.equal('pass')
    })

    it('regex matches against the joined path', () => {
      expect(
        evalOne({ path: 'Parameters\\..*Concreto$', match: 'regex', op: 'exists' })
          .status
      ).to.equal('pass')
    })
  })

  describe('operators', () => {
    const cases: Array<[string, CoordCondition, 'pass' | 'fail']> = [
      ['exists', { path: '*.Nível', op: 'exists' }, 'pass'],
      ['exists on empty string', { path: '*.Comments', op: 'exists' }, 'fail'],
      ['not_exists', { path: '*.Inexistente', op: 'not_exists' }, 'pass'],
      [
        'equals (case-insensitive)',
        { path: '*.Nível', op: 'equals', value: 'térreo' },
        'pass'
      ],
      ['not_equals', { path: '*.Nível', op: 'not_equals', value: 'Térreo' }, 'fail'],
      ['in', { path: '*.Classe do Concreto', op: 'in', value: ['C30', 'C35'] }, 'fail'],
      [
        'in (hit)',
        { path: '*.Classe do Concreto', op: 'in', value: ['C25', 'C30'] },
        'pass'
      ],
      [
        'regex',
        { path: '*.Classe do Concreto', op: 'regex', value: '^C\\d{2}$' },
        'pass'
      ],
      ['gte with units', { path: '*.Base Offset', op: 'gte', value: 25 }, 'pass'],
      ['gt', { path: '*.Base Offset', op: 'gt', value: 25 }, 'fail'],
      ['lt', { path: '*.Base Offset', op: 'lt', value: 30 }, 'pass'],
      ['lte', { path: '*.Base Offset', op: 'lte', value: 24 }, 'fail'],
      ['between', { path: '*.Base Offset', op: 'between', value: [20, 30] }, 'pass'],
      [
        'equals_property',
        {
          path: 'category',
          op: 'equals_property',
          value: { path: 'properties.category' }
        },
        'pass'
      ],
      [
        'map before comparing',
        {
          path: '*.Fire Rating',
          op: 'gte',
          value: 60,
          map: { '60 MIN': 60, '1 HR': 60 }
        },
        'pass'
      ]
    ]
    for (const [name, cond, expected] of cases) {
      it(name, () => {
        expect(evalOne(cond).status).to.equal(expected)
      })
    }

    it('reports a missing property', () => {
      const res = evalOne({ path: '*.Inexistente', op: 'equals', value: 'x' })
      expect(res.status).to.equal('fail')
      expect(res.message).to.equal('propriedade ausente')
    })

    it('reports a non numeric value', () => {
      const res = evalOne({ path: '*.Nível', op: 'gt', value: 1 })
      expect(res.status).to.equal('fail')
      expect(res.message).to.equal('valor não numérico')
    })

    it('passes when any of several matches satisfies (instance vs type param)', () => {
      const obj = {
        ...column,
        a: { Mark: { name: 'Mark', value: 'X' } },
        b: { Mark: { name: 'Mark', value: 'P-12' } }
      }
      expect(
        evalOne({ path: '*.Mark', op: 'equals', value: 'P-12' }, obj).status
      ).to.equal('pass')
    })

    it('records the values found', () => {
      expect(
        evalOne({ path: '*.Classe do Concreto', op: 'in', value: ['C30'] }).actualValue
      ).to.deep.equal(['C25'])
    })
  })

  describe('toNumber', () => {
    it('parses leading numbers with comma or dot decimals', () => {
      expect(toNumber('25 mm')).to.equal(25)
      expect(toNumber('25,5')).to.equal(25.5)
      expect(toNumber(3)).to.equal(3)
      expect(toNumber('abc')).to.equal(null)
    })
  })

  describe('element status and score', () => {
    const isColumn: CoordCondition[] = [
      { path: 'properties.category', op: 'equals', value: 'Structural Columns' }
    ]

    it('is na when no WHERE matches', () => {
      const res = evaluateElement(
        [
          rule(
            'r1',
            [{ path: '*.Nível', op: 'exists' }],
            [{ path: 'category', op: 'equals', value: 'Walls' }]
          )
        ],
        column
      )
      expect(res.status).to.equal('na')
      expect(res.score).to.equal(null)
      expect(res.results).to.have.length(0)
    })

    it('fails on an error rule, weights the score', () => {
      const res = evaluateElement(
        [
          rule(
            'concrete',
            [{ path: '*.Classe do Concreto', op: 'in', value: ['C30'] }],
            isColumn,
            'error',
            2
          ),
          rule('level', [{ path: '*.Nível', op: 'exists' }], isColumn, 'error', 1),
          rule(
            'offset',
            [{ path: '*.Base Offset', op: 'gte', value: 0 }],
            isColumn,
            'warning',
            1
          )
        ],
        column
      )
      expect(res.status).to.equal('fail')
      expect(res.score).to.equal(2 / 4)
      expect(res.results.map((r) => r.status)).to.deep.equal(['fail', 'pass', 'pass'])
    })

    it('is warn when only warning rules fail', () => {
      const res = evaluateElement(
        [
          rule('level', [{ path: '*.Nível', op: 'exists' }], isColumn, 'error'),
          rule(
            'concrete',
            [{ path: '*.Classe do Concreto', op: 'in', value: ['C30'] }],
            isColumn,
            'warning'
          )
        ],
        column
      )
      expect(res.status).to.equal('warn')
      expect(res.results[1].status).to.equal('warn')
    })
  })

  describe('validation', () => {
    it('rejects catastrophic or invalid regexes', () => {
      expect(getUnsafeRegexReason('(a+)+$')).to.be.a('string')
      expect(getUnsafeRegexReason('(\\w*)*x')).to.be.a('string')
      expect(getUnsafeRegexReason('(a)\\1')).to.be.a('string')
      expect(getUnsafeRegexReason('[')).to.be.a('string')
      expect(getUnsafeRegexReason('a'.repeat(201))).to.be.a('string')
      expect(getUnsafeRegexReason('^(AF|AQ|ESG)')).to.equal(null)
      expect(getUnsafeRegexReason('^NXT-[A-Z]{3}-\\d{5}$')).to.equal(null)
    })

    it('rejects a regex condition with an unsafe pattern', () => {
      const res = coordConditionSchema.safeParse({
        path: '*.X',
        op: 'regex',
        value: '(a+)+'
      })
      expect(res.success).to.equal(false)
    })

    it('requires operator-appropriate values', () => {
      expect(
        coordConditionSchema.safeParse({ path: '*.X', op: 'gt', value: 'a' }).success
      ).to.equal(false)
      expect(
        coordConditionSchema.safeParse({ path: '*.X', op: 'between', value: [3, 1] })
          .success
      ).to.equal(false)
      expect(
        coordConditionSchema.safeParse({ path: '*.X', op: 'in', value: [] }).success
      ).to.equal(false)
      expect(
        coordConditionSchema.safeParse({ path: '*.X', op: 'exists', extra: 1 }).success
      ).to.equal(false)
    })

    it('accepts the example rule from the spec', () => {
      const res = coordRuleInputSchema.safeParse({
        code: 'EIR-STR-012',
        name: 'Pilares com classe de concreto',
        requirement: 'EIR 4.2 — Pilares com classe de concreto',
        where: [
          { path: 'properties.category', op: 'equals', value: 'Structural Columns' }
        ],
        check: [
          {
            path: '*.Classe do Concreto',
            match: 'suffix',
            op: 'in',
            value: ['C30', 'C35', 'C40']
          }
        ],
        severity: 'error',
        weight: 2
      })
      expect(res.success).to.equal(true)
    })

    it('describes a rule in Portuguese', () => {
      expect(
        describeRule({
          where: [
            { path: 'properties.category', op: 'equals', value: 'Structural Columns' }
          ],
          check: [{ path: '*.Classe do Concreto', op: 'in', value: ['C30', 'C35'] }]
        })
      ).to.equal(
        'Onde properties.category é igual a Structural Columns, verificar se *.Classe do Concreto está em C30, C35'
      )
    })
  })
})
