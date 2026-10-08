/* eslint-disable camelcase */
// Fixtures use Speckle's object format (speckle_type).
import { expect } from 'chai'
import gql from 'graphql-tag'
import { db } from '@/db/knex'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { createTestStreams } from '@/test/speckle-helpers/streamHelper'
import type { CoordRequirementRecord } from '@/modules/coordination/helpers/coordinationTypes'
import { drainCheckRunQueueFactory } from '@/modules/coordination/services/coordinationRunner'
import { parseIdsDocument } from '@/modules/coordination/services/coordinationIds'
import {
  buildRequirementsIds,
  deliverableCompliance,
  parseRequirementSpec
} from '@/modules/coordination/services/coordinationRequirementSpec'
import {
  createModelVersion,
  publishMutation,
  runCheckMutation
} from '@/modules/coordination/tests/coordinationHelpers'

/**
 * Requirement -> verification (Fase 2c of
 * officio-bim-coordination/.ai/plans/2026-10-06-fase2-search-sets-bsdd-ids.md):
 * specification on the requirement, "Gerar regras", "Exportar IDS" and the
 * MIDP compliance column.
 */

const requirement = (
  code: string,
  spec: unknown,
  extra: Partial<CoordRequirementRecord> = {}
): CoordRequirementRecord => ({
  id: `id-${code}`,
  projectId: 'p',
  sourceId: 's',
  milestoneId: null,
  code,
  title: `Título ${code}`,
  discipline: null,
  purpose: null,
  targetPct: 90,
  spec: spec as CoordRequirementRecord['spec'],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra
})

const fireRatingSpec = {
  ifcClasses: ['IfcColumn', 'IfcBeam'],
  where: [{ path: '*.Pset_ColumnCommon.LoadBearing', op: 'equals', value: true }],
  check: [
    { path: '*.Pset_ColumnCommon.FireRating', op: 'in', value: ['60', '90'] },
    { path: '*.Attributes.Name', op: 'regex', value: '^P-\\d+$' },
    {
      path: 'properties.Quantities.Qto_ColumnBaseQuantities.Length',
      op: 'between',
      value: [1, 12]
    }
  ],
  severity: 'error'
}

describe('Coordination requirement specification @coordination', () => {
  describe('IDS export', () => {
    it('exports a specification the IDS facets can express, and our importer reads it back', () => {
      const result = buildRequirementsIds({
        title: 'Teste & <IDS>',
        requirements: [requirement('EIR 4.2', fireRatingSpec)],
        date: new Date('2026-10-08T00:00:00Z')
      })
      expect(result.exported).to.deep.equal(['EIR 4.2'])
      expect(result.notExported).to.deep.equal([])
      const xml = result.xml!
      expect(xml).to.contain('<xs:enumeration value="IFCCOLUMN"/>')
      expect(xml).to.contain('<xs:enumeration value="IFCBEAM"/>')
      expect(xml).to.contain(
        '<property cardinality="required"><propertySet><simpleValue>Pset_ColumnCommon</simpleValue></propertySet><baseName><simpleValue>FireRating</simpleValue></baseName>'
      )
      // applicability facets carry no cardinality
      expect(xml).to.contain(
        '<property><propertySet><simpleValue>Pset_ColumnCommon</simpleValue></propertySet><baseName><simpleValue>LoadBearing</simpleValue></baseName><value><simpleValue>true</simpleValue></value></property>'
      )
      // anchored JS regex -> XSD pattern without the anchors
      expect(xml).to.contain('<xs:pattern value="P-\\d+"/>')
      expect(xml).to.contain(
        '<xs:minInclusive value="1"/><xs:maxInclusive value="12"/>'
      )
      // attributes come before properties (XSD sequence)
      expect(xml.indexOf('<attribute cardinality')).to.be.lessThan(
        xml.indexOf('<property cardinality')
      )
      expect(xml).to.contain('<title>Teste &amp; &lt;IDS&gt;</title>')

      const parsed = parseIdsDocument(xml)
      expect(parsed.specifications).to.have.length(1)
      expect(parsed.specifications[0]).to.include({
        name: 'Título EIR 4.2',
        identifier: 'EIR 4.2'
      })
    })

    it('lists what the IDS cannot express, with the reason', () => {
      const result = buildRequirementsIds({
        title: 'x',
        requirements: [
          requirement('A', null),
          requirement('B', { ...fireRatingSpec, ifcClasses: [] }),
          requirement('C', {
            ifcClasses: ['IfcWall'],
            check: [
              { path: '*.Pset_WallCommon.FireRating', op: 'not_equals', value: '0' }
            ]
          }),
          requirement('D', {
            ifcClasses: ['IfcWall'],
            check: [{ path: '*.FireRating', op: 'exists' }]
          }),
          requirement('E', {
            ifcClasses: ['IfcWall'],
            check: [
              {
                path: '*.Pset_WallCommon.FireRating',
                op: 'equals',
                value: 60,
                map: { '1 HR': 60 }
              }
            ]
          }),
          requirement('F', {
            ifcClasses: ['IfcWall'],
            check: [
              { path: '*.Pset_WallCommon.Reference', op: 'regex', value: 'a(?=b)' }
            ]
          })
        ]
      })
      expect(result.xml).to.equal(null)
      expect(result.exported).to.deep.equal([])
      const reasons = Object.fromEntries(
        result.notExported.map((n) => [n.code, n.reason])
      )
      expect(reasons.A).to.contain('sem especificação')
      expect(reasons.B).to.contain('sem classe IFC')
      expect(reasons.C).to.contain('not_equals')
      expect(reasons.D).to.contain('Pset.Propriedade')
      expect(reasons.E).to.contain('mapeamento')
      expect(reasons.F).to.contain('XSD')
    })

    it('intersects the classes with an ifcType condition and escapes text', () => {
      const result = buildRequirementsIds({
        title: 'x',
        requirements: [
          requirement(
            'R&D',
            {
              ifcClasses: ['IfcColumn', 'IfcBeam'],
              where: [{ path: 'ifcType', op: 'equals', value: 'IfcColumn' }],
              check: [{ path: '*.Pset_ColumnCommon.FireRating', op: 'exists' }]
            },
            { title: 'Pilares "estruturais" <P>' }
          )
        ]
      })
      expect(result.xml).to.contain(
        '<entity><name><simpleValue>IFCCOLUMN</simpleValue>'
      )
      expect(result.xml).to.contain('identifier="R&amp;D"')
      expect(result.xml).to.contain('name="Pilares &quot;estruturais&quot; &lt;P&gt;"')
    })
  })

  describe('specification validation', () => {
    it('refuses invalid classes and too many scope conditions next to classes', () => {
      expect(() =>
        parseRequirementSpec({
          ifcClasses: ['Column'],
          check: [{ path: 'x', op: 'exists' }]
        })
      ).to.throw('classe IFC inválida')
      expect(() => parseRequirementSpec({ ifcClasses: [], check: [] })).to.throw(
        'ao menos uma verificação'
      )
      const where = Array.from({ length: 20 }, (_, i) => ({
        path: `p${i}`,
        op: 'exists'
      }))
      expect(() =>
        parseRequirementSpec({
          ifcClasses: ['IfcWall'],
          where,
          check: [{ path: 'x', op: 'exists' }]
        })
      ).to.throw('no máximo 19')
      expect(
        parseRequirementSpec({ where, check: [{ path: 'x', op: 'exists' }] }).where
      ).to.have.length(20)
    })
  })

  describe('deliverable compliance', () => {
    const reqA = requirement('A', null, { targetPct: 90 })
    const reqB = requirement('B', null, { targetPct: 50 })
    const stats = new Map([
      [
        'model-1',
        new Map([
          [reqA.id, { applicable: 10, passed: 9 }],
          [reqB.id, { applicable: 4, passed: 1 }]
        ])
      ]
    ])

    it('compares each requirement with its own target', () => {
      const met = deliverableCompliance({
        modelId: 'model-1',
        requirements: [reqA],
        stats
      })
      expect(met.status).to.equal('met')
      expect(met.adherence).to.be.closeTo(0.9, 1e-9)

      const below = deliverableCompliance({
        modelId: 'model-1',
        requirements: [reqA, reqB],
        stats
      })
      expect(below.status).to.equal('below')
      expect(below.requirements.map((r) => r.met)).to.deep.equal([true, false])
      expect(below.adherence).to.be.closeTo(10 / 14, 1e-9)

      const reqC = requirement('C', null)
      const partial = deliverableCompliance({
        modelId: 'model-1',
        requirements: [reqA, reqC],
        stats
      })
      expect(partial.status).to.equal('partial')
      expect(partial.requirements[1].met).to.equal(null)
    })

    it('says why there is nothing to compare', () => {
      expect(
        deliverableCompliance({ modelId: null, requirements: [reqA], stats }).status
      ).to.equal('no_model')
      expect(
        deliverableCompliance({ modelId: 'model-1', requirements: [], stats }).status
      ).to.equal('no_requirements')
      expect(
        deliverableCompliance({ modelId: 'model-2', requirements: [reqA], stats })
          .status
      ).to.equal('no_run')
    })
  })

  describe('API', () => {
    const owner: BasicTestUser = { name: 'spec owner', email: '', id: '' }
    const outsider: BasicTestUser = { name: 'spec outsider', email: '', id: '' }
    const project: BasicTestStream = {
      name: 'Spec project',
      isPublic: false,
      ownerId: '',
      id: ''
    }
    const drain = drainCheckRunQueueFactory({ db })

    let apollo: TestApolloServer
    let outsiderApollo: TestApolloServer
    let specReqId: string
    let plainReqId: string

    const setSpec = gql`
      mutation ($id: String!, $spec: JSONObject) {
        coordinationMutations {
          setRequirementSpec(id: $id, spec: $spec) {
            id
            spec
            specSummary
          }
        }
      }
    `
    const generate = gql`
      mutation ($projectId: String!) {
        coordinationMutations {
          generateRequirementRules(projectId: $projectId) {
            generated
            skipped
            ruleSet {
              id
              name
              generatedFrom
              draft {
                rules {
                  code
                  requirementId
                  definition
                }
              }
            }
          }
        }
      }
    `
    const idsQuery = gql`
      query ($projectId: String!) {
        project(id: $projectId) {
          coordination {
            requirementsIds {
              xml
              fileName
              exported
              notExported {
                code
                reason
              }
            }
          }
        }
      }
    `
    const createDeliverable = gql`
      mutation ($projectId: String!, $input: JSONObject!) {
        coordinationMutations {
          createDeliverable(projectId: $projectId, input: $input) {
            id
          }
        }
      }
    `
    const complianceQuery = gql`
      query ($projectId: String!) {
        project(id: $projectId) {
          coordination {
            deliverables {
              id
              compliance {
                status
                adherence
                requirements {
                  requirement {
                    code
                  }
                  applicable
                  passed
                  met
                }
              }
            }
          }
        }
      }
    `

    before(async () => {
      await beforeEachContext()
      await createTestUsers([owner, outsider])
      await createTestStreams([[project, owner]])
      apollo = await testApolloServer({ authUserId: owner.id })
      outsiderApollo = await testApolloServer({ authUserId: outsider.id })

      const source = await apollo.execute(
        gql`
          mutation ($projectId: String!, $input: CoordRequirementSourceInput!) {
            coordinationMutations {
              createRequirementSource(projectId: $projectId, input: $input) {
                id
              }
            }
          }
        `,
        { projectId: project.id, input: { kind: 'EIR', title: 'EIR' } }
      )
      const sourceId = source.data!.coordinationMutations.createRequirementSource.id
      const createReq = async (code: string, targetPct: number) => {
        const res = await apollo.execute(
          gql`
            mutation ($projectId: String!, $input: CoordRequirementInput!) {
              coordinationMutations {
                createRequirement(projectId: $projectId, input: $input) {
                  id
                }
              }
            }
          `,
          {
            projectId: project.id,
            input: { sourceId, code, title: `Req ${code}`, targetPct }
          }
        )
        expect(res).to.not.haveGraphQLErrors()
        return res.data!.coordinationMutations.createRequirement.id as string
      }
      specReqId = await createReq('EIR-FR', 60)
      plainReqId = await createReq('EIR-NONE', 95)
    })

    it('saves, describes and clears a specification; gates outsiders', async () => {
      const spec = {
        ifcClasses: ['IfcColumn'],
        check: [
          { path: '*.Pset_ColumnCommon.FireRating', op: 'in', value: ['60', '90'] }
        ]
      }
      const denied = await outsiderApollo.execute(setSpec, { id: specReqId, spec })
      expect(denied).to.haveGraphQLErrors()

      const invalid = await apollo.execute(setSpec, {
        id: specReqId,
        spec: { ...spec, check: [{ path: 'x', op: 'regex', value: '(a+)+' }] }
      })
      expect(invalid).to.haveGraphQLErrors()

      const cleared = await apollo.execute(setSpec, { id: specReqId, spec: null })
      expect(cleared).to.not.haveGraphQLErrors()
      expect(cleared.data!.coordinationMutations.setRequirementSpec.spec).to.equal(null)

      const saved = await apollo.execute(setSpec, { id: specReqId, spec })
      expect(saved).to.not.haveGraphQLErrors()
      const row = saved.data!.coordinationMutations.setRequirementSpec
      expect(row.spec).to.deep.include({ ifcClasses: ['IfcColumn'], severity: 'error' })
      expect(row.specSummary).to.contain('Em IfcColumn')
    })

    it('generates one rule per specified requirement into the managed draft, idempotently', async () => {
      const denied = await outsiderApollo.execute(generate, { projectId: project.id })
      expect(denied).to.haveGraphQLErrors()

      const first = await apollo.execute(generate, { projectId: project.id })
      expect(first).to.not.haveGraphQLErrors()
      const result = first.data!.coordinationMutations.generateRequirementRules
      expect(result.generated).to.equal(1)
      expect(result.skipped).to.deep.equal(['EIR-NONE'])
      expect(result.ruleSet).to.include({
        name: 'Requisitos do EIR (gerado)',
        generatedFrom: 'requirements'
      })
      const [rule] = result.ruleSet.draft.rules
      expect(rule.code).to.equal('EIR-FR')
      expect(rule.requirementId).to.equal(specReqId)
      expect(rule.definition.where[0]).to.deep.include({
        path: 'ifcType',
        op: 'in',
        value: ['IfcColumn']
      })

      const again = await apollo.execute(generate, { projectId: project.id })
      expect(again).to.not.haveGraphQLErrors()
      const second = again.data!.coordinationMutations.generateRequirementRules
      expect(second.ruleSet.id).to.equal(result.ruleSet.id)
      expect(second.ruleSet.draft.rules).to.have.length(1)
    })

    it('exports the IDS of the specified requirements', async () => {
      const res = await apollo.execute(idsQuery, { projectId: project.id })
      expect(res).to.not.haveGraphQLErrors()
      const out = res.data!.project.coordination.requirementsIds
      expect(out.exported).to.deep.equal(['EIR-FR'])
      expect(out.notExported).to.deep.equal([
        { code: 'EIR-NONE', reason: 'sem especificação verificável' }
      ])
      expect(out.xml).to.contain('IFCCOLUMN')
      expect(out.fileName).to.match(/\.ids$/)
    })

    it('shows on the MIDP how the deliverable model meets its requirements', async () => {
      const generated = await apollo.execute(generate, { projectId: project.id })
      const ruleSetId = generated.data!.coordinationMutations.generateRequirementRules
        .ruleSet.id as string
      const published = await apollo.execute(publishMutation, { ruleSetId })
      expect(published).to.not.haveGraphQLErrors()

      const column = (applicationId: string, fireRating: string) => ({
        applicationId,
        speckle_type: 'Objects.Data.DataObject',
        ifcType: 'IfcColumn',
        name: applicationId,
        properties: {
          'Property Sets': { Pset_ColumnCommon: { FireRating: fireRating } }
        },
        displayValue: [{ referencedId: 'mesh', speckle_type: 'reference' }]
      })
      const { modelId, versionId } = await createModelVersion({
        project,
        owner,
        elements: [column('c1', '60'), column('c2', '90'), column('c3', '30')]
      })

      await apollo.execute(
        gql`
          mutation ($projectId: String!, $input: JSONObject!) {
            coordinationMutations {
              setNamingCodes(projectId: $projectId, input: $input) {
                code
              }
            }
          }
        `,
        {
          projectId: project.id,
          input: {
            project: [{ code: 'P' }],
            originator: [{ code: 'O' }],
            volume: [{ code: 'ZZ' }],
            level: [{ code: 'ZZ' }],
            type: [{ code: 'M3' }],
            role: [{ code: 'S' }]
          }
        }
      )
      const base = {
        kind: 'model',
        project: 'P',
        originator: 'O',
        volume: 'ZZ',
        level: 'ZZ',
        type: 'M3',
        role: 'S'
      }
      const withModel = await apollo.execute(createDeliverable, {
        projectId: project.id,
        input: {
          ...base,
          title: 'Estrutura',
          modelId,
          requirementIds: [specReqId, plainReqId]
        }
      })
      expect(withModel).to.not.haveGraphQLErrors()
      const withoutModel = await apollo.execute(createDeliverable, {
        projectId: project.id,
        input: { ...base, title: 'Sem modelo', requirementIds: [specReqId] }
      })
      expect(withoutModel).to.not.haveGraphQLErrors()

      const before = await apollo.execute(complianceQuery, { projectId: project.id })
      expect(before).to.not.haveGraphQLErrors()
      type ComplianceView = {
        status: string
        adherence: number | null
        requirements: unknown[]
      }
      const statusOf = (data: typeof before.data, id: string): ComplianceView => {
        const rows = data!.project.coordination.deliverables as {
          id: string
          compliance: ComplianceView
        }[]
        return rows.find((d) => d.id === id)!.compliance
      }
      const modelDeliverableId =
        withModel.data!.coordinationMutations.createDeliverable.id
      const noModelId = withoutModel.data!.coordinationMutations.createDeliverable.id
      expect(statusOf(before.data, modelDeliverableId).status).to.equal('no_run')
      expect(statusOf(before.data, noModelId).status).to.equal('no_model')

      const run = await apollo.execute(runCheckMutation, {
        ruleSetId,
        modelId,
        versionId
      })
      expect(run).to.not.haveGraphQLErrors()
      await drain()

      const after = await apollo.execute(complianceQuery, { projectId: project.id })
      expect(after).to.not.haveGraphQLErrors()
      const compliance = statusOf(after.data, modelDeliverableId)
      // 2 of 3 columns pass (67% >= 60% target); EIR-NONE has no rule: partial
      expect(compliance.status).to.equal('partial')
      expect(compliance.adherence).to.be.closeTo(2 / 3, 1e-9)
      expect(compliance.requirements).to.deep.equal([
        { requirement: { code: 'EIR-FR' }, applicable: 3, passed: 2, met: true },
        { requirement: { code: 'EIR-NONE' }, applicable: 0, passed: 0, met: null }
      ])
    })
  })
})
