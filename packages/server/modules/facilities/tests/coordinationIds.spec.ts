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
import { CoordCheckResults, CoordCheckRuns } from '@/modules/core/dbSchema'
import { parseIdsDocument } from '@/modules/facilities/services/coordinationIds'
import {
  drainCheckRunQueueFactory,
  enqueueCheckRunFactory
} from '@/modules/facilities/services/coordinationRunner'
import {
  columnObject,
  createModelVersion,
  publishMutation,
  runCheckMutation
} from '@/modules/facilities/tests/coordinationHelpers'

/**
 * IDS rule sets: import (shape validation, XXE refusal) and the Node half of
 * an IDS run - aggregating the per-GlobalId results the Python worker
 * (IfcTester) writes. See .ai/plans/2026-10-01-coordenacao-bim-ids.md.
 */

const sampleIds = `<?xml version="1.0" encoding="UTF-8"?>
<ids:ids xmlns:ids="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <ids:info><ids:title>IDS PHD — Teste</ids:title></ids:info>
  <ids:specifications>
    <ids:specification name="Pilares com classe de concreto" ifcVersion="IFC4" identifier="EIR 4.2">
      <ids:applicability minOccurs="0" maxOccurs="unbounded">
        <ids:entity><ids:name><ids:simpleValue>IFCCOLUMN</ids:simpleValue></ids:name></ids:entity>
      </ids:applicability>
      <ids:requirements>
        <ids:property dataType="IFCLABEL" cardinality="required">
          <ids:propertySet><ids:simpleValue>Pset_PHD</ids:simpleValue></ids:propertySet>
          <ids:baseName><ids:simpleValue>ClasseConcreto</ids:simpleValue></ids:baseName>
          <ids:value>
            <xs:restriction base="xs:string">
              <xs:enumeration value="C30"/>
              <xs:enumeration value="C35"/>
            </xs:restriction>
          </ids:value>
        </ids:property>
      </ids:requirements>
    </ids:specification>
    <ids:specification name="Portas com resistência ao fogo" ifcVersion="IFC4">
      <ids:applicability minOccurs="0" maxOccurs="unbounded">
        <ids:entity><ids:name><ids:simpleValue>IFCDOOR</ids:simpleValue></ids:name></ids:entity>
      </ids:applicability>
      <ids:requirements>
        <ids:property dataType="IFCLABEL" cardinality="optional">
          <ids:propertySet><ids:simpleValue>Pset_DoorCommon</ids:simpleValue></ids:propertySet>
          <ids:baseName><ids:simpleValue>FireRating</ids:simpleValue></ids:baseName>
        </ids:property>
      </ids:requirements>
    </ids:specification>
  </ids:specifications>
</ids:ids>`

const importIdsMutation = gql`
  mutation ($projectId: String!, $xml: String!, $ruleSetId: String) {
    coordinationMutations {
      importIdsRuleSet(projectId: $projectId, xml: $xml, ruleSetId: $ruleSetId) {
        ruleSet {
          id
          name
          format
          draft {
            id
            version
            rules {
              id
              code
              name
              severity
              requirementId
              summary
              expected
            }
          }
        }
        createdRequirements
      }
    }
  }
`

const upsertRuleMutation = gql`
  mutation ($ruleSetId: String!, $input: JSONObject!) {
    coordinationMutations {
      upsertDraftRule(ruleSetId: $ruleSetId, input: $input) {
        id
      }
    }
  }
`

const runQuery = gql`
  query ($projectId: String!, $runId: String!) {
    project(id: $projectId) {
      coordination {
        checkRun(id: $runId) {
          status
          engine
          summary {
            elements
            applicable
            passed
            warned
            failed
            notApplicable
            unkeyed
          }
          requirements {
            requirement {
              code
            }
            applicable
            passed
          }
          all: elementResults {
            items {
              elementKey
              speckleObjectId
              status
            }
          }
        }
      }
    }
  }
`

describe('Coordination IDS', () => {
  describe('parseIdsDocument', () => {
    it('summarizes specifications and maps optional requirements to warnings', () => {
      const parsed = parseIdsDocument(sampleIds)
      expect(parsed.title).to.equal('IDS PHD — Teste')
      expect(parsed.specifications).to.have.length(2)
      const [columns, doors] = parsed.specifications
      expect(columns).to.deep.include({
        identifier: 'EIR 4.2',
        severity: 'error',
        ifcVersion: 'IFC4',
        applicability: 'classe IFCCOLUMN',
        requirements: 'Pset_PHD.ClasseConcreto = um de C30, C35'
      })
      expect(doors.severity).to.equal('warning')
      expect(doors.requirements).to.equal(
        '(opcional) Pset_DoorCommon.FireRating preenchida'
      )
    })

    it('refuses specifications without an entity facet', () => {
      const xml = sampleIds.replace(
        '<ids:entity><ids:name><ids:simpleValue>IFCDOOR</ids:simpleValue></ids:name></ids:entity>',
        '<ids:attribute><ids:name><ids:simpleValue>Name</ids:simpleValue></ids:name></ids:attribute>'
      )
      expect(() => parseIdsDocument(xml)).to.throw(/sem faceta de entidade/)
    })

    it('refuses DTDs and entities (XXE)', () => {
      const xml = sampleIds.replace(
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<?xml version="1.0"?><!DOCTYPE ids [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
      )
      expect(() => parseIdsDocument(xml)).to.throw(/DTD/)
    })

    it('refuses malformed XML and non-IDS documents', () => {
      expect(() => parseIdsDocument('<ids:ids><oops></ids:ids>')).to.throw(
        /XML inválido/
      )
      expect(() => parseIdsDocument('<root/>')).to.throw(/não é um IDS/)
    })
  })

  describe('import and runs', () => {
    const owner: BasicTestUser = { name: 'ids owner', email: '', id: '' }
    const project: BasicTestStream = {
      name: 'IDS project',
      isPublic: false,
      ownerId: '',
      id: ''
    }
    let apollo: TestApolloServer
    let ruleSetId: string
    let columnRuleId: string
    let doorRuleId: string

    before(async () => {
      await beforeEachContext()
      await createTestUsers([owner])
      await createTestStreams([[project, owner]])
      apollo = await testApolloServer({ authUserId: owner.id })
    })

    it('imports an IDS as a read-only rule set linked to requirements', async () => {
      const res = await apollo.execute(importIdsMutation, {
        projectId: project.id,
        xml: sampleIds
      })
      expect(res).to.not.haveGraphQLErrors()
      const result = res.data!.coordinationMutations.importIdsRuleSet
      expect(result.createdRequirements).to.deep.equal(['EIR 4.2'])
      expect(result.ruleSet).to.include({ name: 'IDS PHD — Teste', format: 'ids' })
      const rules = result.ruleSet.draft.rules as Array<Record<string, string | null>>
      expect(rules.map((r) => r.code)).to.deep.equal(['EIR 4.2', 'IDS-2'])
      expect(rules[0].requirementId).to.be.a('string')
      expect(rules[0].expected).to.equal('Pset_PHD.ClasseConcreto = um de C30, C35')
      expect(rules[1].severity).to.equal('warning')
      ruleSetId = result.ruleSet.id
      columnRuleId = rules[0].id!
      doorRuleId = rules[1].id!

      const edit = await apollo.execute(upsertRuleMutation, {
        ruleSetId,
        input: { code: 'X', name: 'X', severity: 'error', weight: 1, check: [] }
      })
      expect(edit).to.haveGraphQLErrors()
      expect(edit.errors?.[0].message).to.match(/conjunto IDS/)
    })

    it('re-import replaces the draft rules', async () => {
      const res = await apollo.execute(importIdsMutation, {
        projectId: project.id,
        xml: sampleIds,
        ruleSetId
      })
      expect(res).to.not.haveGraphQLErrors()
      const rules = res.data!.coordinationMutations.importIdsRuleSet.ruleSet.draft.rules
      expect(rules).to.have.length(2)
      columnRuleId = rules[0].id
      doorRuleId = rules[1].id
      const published = await apollo.execute(publishMutation, { ruleSetId })
      expect(published).to.not.haveGraphQLErrors()
    })

    it('refuses to run IDS on a version that did not come from an IFC upload', async () => {
      const version = await createModelVersion({ project, owner, elements: [] })
      const res = await apollo.execute(runCheckMutation, {
        ruleSetId,
        modelId: version.modelId
      })
      expect(res).to.haveGraphQLErrors()
      expect(res.errors?.[0].message).to.match(/IFC original/)
    })

    it('aggregates the IfcTester results written by the Python worker', async () => {
      const version = await createModelVersion({
        project,
        owner,
        elements: [columnObject('col-ok', 'C30'), columnObject('col-bad', 'C25')]
      })
      const { run } = await enqueueCheckRunFactory({ db })({
        projectId: project.id,
        ruleSetId,
        ruleSetVersionId: await publishedVersionId(ruleSetId),
        modelId: version.modelId,
        versionId: version.versionId,
        trigger: 'manual',
        createdBy: owner.id,
        engine: 'ids',
        ifcObjectKey: 'test/fake.ifc'
      })
      expect(run.status).to.equal('queued')

      // The Node worker must leave queued IDS runs to the Python worker
      await drainCheckRunQueueFactory({ db })()
      const untouched = await db(CoordCheckRuns.name).where({ id: run.id }).first()
      expect(untouched.status).to.equal('queued')

      // Simulate the Python worker: IfcTester results by GlobalId
      await db(CoordCheckResults.name).insert([
        { runId: run.id, ruleId: columnRuleId, elementKey: 'col-ok', status: 'pass' },
        {
          runId: run.id,
          ruleId: columnRuleId,
          elementKey: 'col-bad',
          status: 'fail',
          message: 'valor C25 fora da lista'
        },
        // a door IfcTester found that is not a geometry element in Speckle
        {
          runId: run.id,
          ruleId: doorRuleId,
          elementKey: 'door-1',
          status: 'fail',
          message: 'FireRating ausente'
        }
      ])
      await db(CoordCheckRuns.name)
        .where({ id: run.id })
        .update({ status: 'ids_done', attempt: 1, startedAt: new Date() })

      await drainCheckRunQueueFactory({ db })()

      const res = await apollo.execute(runQuery, {
        projectId: project.id,
        runId: run.id
      })
      expect(res).to.not.haveGraphQLErrors()
      const done = res.data!.project.coordination.checkRun
      expect(done.status).to.equal('succeeded')
      expect(done.engine).to.equal('ids')
      // 2 Speckle elements + the door only IfcTester saw
      expect(done.summary).to.deep.include({
        elements: 3,
        applicable: 3,
        passed: 1,
        failed: 1,
        warned: 1,
        notApplicable: 0,
        unkeyed: 0
      })
      expect(done.requirements).to.deep.equal([
        { requirement: { code: 'EIR 4.2' }, applicable: 2, passed: 1 }
      ])
      const door = (done.all.items as Array<Record<string, string | null>>).find(
        (i) => i.elementKey === 'door-1'
      )
      expect(door).to.deep.include({ status: 'warn', speckleObjectId: null })
    })
  })
})

async function publishedVersionId(ruleSetId: string) {
  const row = await db('coord_rule_set_versions')
    .where({ ruleSetId, status: 'published' })
    .orderBy('version', 'desc')
    .first()
  return row.id as string
}
