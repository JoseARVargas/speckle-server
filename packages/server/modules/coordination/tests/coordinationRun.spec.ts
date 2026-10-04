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
import { drainCheckRunQueueFactory } from '@/modules/coordination/services/coordinationRunner'
import {
  bindingMutation,
  columnObject,
  createModelVersion,
  exampleRuleSet,
  importRuleSetMutation,
  publishMutation,
  runCheckMutation,
  wallObject
} from '@/modules/coordination/tests/coordinationHelpers'

const runQuery = gql`
  query ($projectId: String!, $runId: String!) {
    project(id: $projectId) {
      coordination {
        checkRun(id: $runId) {
          id
          status
          trigger
          error
          summary {
            elements
            applicable
            passed
            warned
            failed
            notApplicable
            unkeyed
            adherence
          }
          requirements {
            requirement {
              code
            }
            applicable
            passed
            adherence
          }
          ruleStats {
            rule {
              code
            }
            applicable
            failed
          }
          failing: elementResults(status: [fail]) {
            totalCount
            items {
              elementKey
              status
              score
            }
          }
          all: elementResults {
            totalCount
          }
          element(elementKey: "col-bad") {
            status
            score
            results {
              rule {
                code
                expected
              }
              status
              actualValue
              message
            }
          }
        }
      }
    }
  }
`

const scopedQuery = gql`
  query ($projectId: String!, $runId: String!, $ruleId: String!) {
    project(id: $projectId) {
      coordination {
        checkRun(id: $runId) {
          failing: elementResults(ruleId: $ruleId, status: [fail]) {
            totalCount
          }
          all: elementResults(ruleId: $ruleId) {
            items {
              elementKey
              status
            }
          }
        }
      }
    }
  }
`

const runsQuery = gql`
  query ($projectId: String!, $ruleSetId: String!) {
    project(id: $projectId) {
      coordination {
        checkRuns(ruleSetId: $ruleSetId, includePreview: true) {
          totalCount
          items {
            id
            trigger
            status
          }
        }
      }
    }
  }
`

const upsertRuleMutation = gql`
  mutation ($ruleSetId: String!, $ruleId: String, $input: JSONObject!) {
    coordinationMutations {
      upsertDraftRule(ruleSetId: $ruleSetId, ruleId: $ruleId, input: $input) {
        id
        code
      }
    }
  }
`

const previewMutation = gql`
  mutation ($ruleSetId: String!, $modelId: String!) {
    coordinationMutations {
      previewDraft(ruleSetId: $ruleSetId, modelId: $modelId) {
        id
        trigger
      }
    }
  }
`

// Nested GraphQL result read loosely by the assertions below
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RunView = Record<string, any>

/**
 * End to end over the run pipeline: import -> publish -> bind -> run ->
 * worker -> results, plus the unkeyed block, dedupe, the version-created
 * listener and draft previews.
 */
describe('Coordination check runs', () => {
  const owner: BasicTestUser = { name: 'coord runner', email: '', id: '' }
  const project: BasicTestStream = {
    name: 'Coord run project',
    isPublic: false,
    ownerId: '',
    id: ''
  }
  const drain = drainCheckRunQueueFactory({ db })

  let apollo: TestApolloServer
  let ruleSetId: string
  let modelId: string
  let versionId: string
  let levelRuleId: string

  const runCheck = async (vars: Record<string, unknown> = {}) => {
    const res = await apollo.execute(runCheckMutation, { ruleSetId, modelId, ...vars })
    expect(res).to.not.haveGraphQLErrors()
    return res.data!.coordinationMutations.runCheck as { id: string; status: string }
  }
  const getRun = async (runId: string) => {
    const res = await apollo.execute(runQuery, { projectId: project.id, runId })
    expect(res).to.not.haveGraphQLErrors()
    return res.data!.project.coordination.checkRun as RunView
  }

  before(async () => {
    await beforeEachContext()
    await createTestUsers([owner])
    await createTestStreams([[project, owner]])
    apollo = await testApolloServer({ authUserId: owner.id })

    const imported = await apollo.execute(importRuleSetMutation, {
      projectId: project.id,
      document: exampleRuleSet
    })
    expect(imported).to.not.haveGraphQLErrors()
    const result = imported.data!.coordinationMutations.importRuleSet
    expect(result.createdRequirements).to.deep.equal(['EIR 4.2', 'EIR 5.1'])
    ruleSetId = result.ruleSet.id
    levelRuleId = result.ruleSet.draft.rules.find(
      (r: { code: string }) => r.code === 'EIR-STR-031'
    ).id

    const published = await apollo.execute(publishMutation, { ruleSetId })
    expect(published).to.not.haveGraphQLErrors()
    expect(published.data!.coordinationMutations.publishRuleSet).to.include({
      version: 1,
      status: 'published'
    })

    const version = await createModelVersion({
      project,
      owner,
      elements: [
        columnObject('col-ok', 'C30'),
        columnObject('col-bad', 'C25'),
        wallObject('wall-1'),
        columnObject(null, 'C30')
      ]
    })
    modelId = version.modelId
    versionId = version.versionId
  })

  it('blocks a run when too many elements lack applicationId', async () => {
    const run = await runCheck()
    await drain()
    const done = await getRun(run.id)
    expect(done.status).to.equal('blocked')
    expect(done.summary.unkeyed).to.equal(1)
    expect(done.summary.elements).to.equal(4)
    expect(done.all.totalCount).to.equal(0)
  })

  it('evaluates every element and aggregates by rule and requirement', async () => {
    const binding = await apollo.execute(bindingMutation, {
      ruleSetId,
      modelId,
      autoRun: false,
      pct: 50
    })
    expect(binding).to.not.haveGraphQLErrors()

    const run = await runCheck({ versionId })
    await drain()
    const done = await getRun(run.id)

    expect(done.status).to.equal('succeeded')
    expect(done.summary).to.deep.include({
      elements: 4,
      applicable: 2,
      passed: 1,
      warned: 0,
      failed: 1,
      notApplicable: 1,
      unkeyed: 1
    })
    // col-ok scores 1, col-bad 1/3 (passes only the weight-1 rule)
    expect(done.summary.adherence).to.be.closeTo((1 + 1 / 3) / 2, 1e-9)

    const reqs = Object.fromEntries(
      done.requirements.map((r: { requirement: { code: string }; passed: number }) => [
        r.requirement.code,
        r.passed
      ])
    )
    expect(reqs).to.deep.equal({ 'EIR 4.2': 1, 'EIR 5.1': 2 })

    expect(done.failing.totalCount).to.equal(1)
    expect(done.failing.items[0]).to.include({ elementKey: 'col-bad', status: 'fail' })

    expect(done.element.status).to.equal('fail')
    const concrete = done.element.results.find(
      (r: { rule: { code: string } }) => r.rule.code === 'EIR-STR-012'
    )
    expect(concrete).to.deep.include({ status: 'fail', actualValue: ['C25'] })
    expect(concrete.rule.expected).to.equal(
      '*.Classe do Concreto está em C30, C35, C40'
    )
  })

  it('scopes element status to the filtered rule', async () => {
    const run = await runCheck({ versionId })
    await drain()
    const scoped = await apollo.execute(scopedQuery, {
      projectId: project.id,
      runId: run.id,
      ruleId: levelRuleId
    })
    expect(scoped).to.not.haveGraphQLErrors()
    const results = scoped.data!.project.coordination.checkRun
    // col-bad fails the concrete rule but has a level: it passes this rule
    expect(results.failing.totalCount).to.equal(0)
    expect(results.all.items).to.deep.include({ elementKey: 'col-bad', status: 'pass' })
  })

  it('returns the queued run instead of queueing a duplicate', async () => {
    const first = await runCheck({ versionId })
    const second = await runCheck({ versionId })
    expect(second.id).to.equal(first.id)
    await drain()
  })

  it('queues a run automatically when a bound model gets a new version', async () => {
    await apollo.execute(bindingMutation, {
      ruleSetId,
      modelId,
      autoRun: true,
      pct: 50
    })
    const before = await apollo.execute(runsQuery, { projectId: project.id, ruleSetId })
    const countBefore = before.data!.project.coordination.checkRuns.totalCount

    await createModelVersion({
      project,
      owner,
      branchId: modelId,
      elements: [columnObject('col-ok', 'C35')]
    })

    const after = await apollo.execute(runsQuery, { projectId: project.id, ruleSetId })
    const runs = after.data!.project.coordination.checkRuns
    expect(runs.totalCount).to.equal(countBefore + 1)
    expect(runs.items[0]).to.include({ trigger: 'version_created', status: 'queued' })
    await drain()
    await apollo.execute(bindingMutation, {
      ruleSetId,
      modelId,
      autoRun: false,
      pct: 50
    })
  })

  it('edits only the draft and previews it without touching the published version', async () => {
    const created = await apollo.execute(upsertRuleMutation, {
      ruleSetId,
      input: {
        code: 'EIR-STR-099',
        name: 'Paredes com categoria',
        severity: 'warning',
        weight: 1,
        where: [{ path: 'properties.category', op: 'equals', value: 'Walls' }],
        check: [{ path: '*.Fire Rating', op: 'exists' }]
      }
    })
    expect(created).to.not.haveGraphQLErrors()

    const preview = await apollo.execute(previewMutation, { ruleSetId, modelId })
    expect(preview).to.not.haveGraphQLErrors()
    const previewRun = preview.data!.coordinationMutations.previewDraft
    expect(previewRun.trigger).to.equal('preview')
    await drain()
    const done = await getRun(previewRun.id)
    expect(done.status).to.equal('succeeded')

    // The published run (non-preview listing) is unaffected by the draft
    const published = await apollo.execute(runCheckMutation, {
      ruleSetId,
      modelId,
      versionId
    })
    expect(published).to.not.haveGraphQLErrors()
    await drain()
    const publishedRun = await getRun(published.data!.coordinationMutations.runCheck.id)
    expect(
      publishedRun.ruleStats.map((s: { rule: { code: string } }) => s.rule.code)
    ).to.not.include('EIR-STR-099')
  })

  it('rejects an invalid rule with a clear message', async () => {
    const res = await apollo.execute(upsertRuleMutation, {
      ruleSetId,
      input: {
        code: 'BAD',
        name: 'Regex perigosa',
        severity: 'error',
        weight: 1,
        check: [{ path: '*.X', op: 'regex', value: '(a+)+$' }]
      }
    })
    expect(res).to.haveGraphQLErrors()
    expect(res.errors?.[0].message).to.match(/nested quantifiers/)
  })
})
