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
import type { BasicTestBranch } from '@/test/speckle-helpers/branchHelper'
import { createTestBranch } from '@/test/speckle-helpers/branchHelper'
import { CoordClashRaw, CoordClashRuns, FileUploads } from '@/modules/core/dbSchema'
import { BlobStorage } from '@/modules/blobstorage/repositories'
import {
  clashFingerprint,
  carriedStatus,
  drainClashQueueFactory
} from '@/modules/coordination/services/coordinationClash'
import {
  columnObject,
  createModelVersion,
  wallObject
} from '@/modules/coordination/tests/coordinationHelpers'

/**
 * Clash detection, Node side: tests, gates, enqueue, element selection,
 * post-processing (ignore rules, fingerprint, status carry-over). The
 * Python geometry step is simulated by writing coord_clash_raw directly.
 */

const createTestMutation = gql`
  mutation ($projectId: String!, $input: JSONObject!) {
    coordinationMutations {
      createClashTest(projectId: $projectId, input: $input) {
        id
        name
        type
        groupB
      }
    }
  }
`

const runTestMutation = gql`
  mutation ($id: String!) {
    coordinationMutations {
      runClashTest(id: $id) {
        id
        status
      }
    }
  }
`

const setStatusMutation = gql`
  mutation ($ids: [String!]!, $status: String!, $comment: String) {
    coordinationMutations {
      setClashStatus(ids: $ids, status: $status, comment: $comment)
    }
  }
`

const assignMutation = gql`
  mutation ($ids: [String!]!, $assignee: String) {
    coordinationMutations {
      assignClashes(ids: $ids, assignee: $assignee)
    }
  }
`

const runQuery = gql`
  query ($projectId: String!, $runId: String!) {
    project(id: $projectId) {
      coordination {
        clashRun(id: $runId) {
          status
          error
          countA
          countB
          rawCount
          ignoredCount
          clashCount
          statusCounts {
            status
            count
          }
          clashes {
            id
            keyA
            keyB
            distanceMm
            status
            comment
            speckleObjectIdA
          }
        }
      }
    }
  }
`

/** Marks a version as coming from an imported IFC (as the importer leaves it). */
async function markIfcUpload(projectId: string, versionId: string, userId: string) {
  const id = Math.random().toString(36).slice(2, 12)
  await db(FileUploads.name).insert({
    id,
    streamId: projectId,
    branchName: 'x',
    userId,
    fileName: `${id}.ifc`,
    fileType: 'ifc',
    fileSize: 100,
    uploadComplete: true,
    convertedStatus: 2,
    convertedCommitId: versionId,
    convertedLastUpdate: new Date()
  })
  await db(BlobStorage.name).insert({
    id,
    streamId: projectId,
    userId,
    objectKey: `assets/${projectId}/${id}`,
    fileName: `${id}.ifc`,
    fileType: 'ifc',
    fileSize: 100,
    uploadStatus: 1
  })
}

describe('Coordination clash @coordination', () => {
  const owner: BasicTestUser = { name: 'clash owner', email: '', id: '' }
  const outsider: BasicTestUser = { name: 'clash outsider', email: '', id: '' }
  const project: BasicTestStream = {
    name: 'Clash project',
    isPublic: false,
    ownerId: '',
    id: ''
  }
  const other: BasicTestStream = { name: 'Other', isPublic: false, ownerId: '', id: '' }
  const structure: BasicTestBranch = {
    name: 'estrutura',
    streamId: '',
    authorId: '',
    id: ''
  }
  const architecture: BasicTestBranch = {
    name: 'arquitetura',
    streamId: '',
    authorId: '',
    id: ''
  }
  let apollo: TestApolloServer
  let testId: string

  const versions = async (round: number) => {
    const a = await createModelVersion({
      project,
      owner,
      branchId: structure.id,
      elements: [columnObject('COL-1', 'C30'), columnObject(`COL-2`, 'C30')]
    })
    const b = await createModelVersion({
      project,
      owner,
      branchId: architecture.id,
      elements: [
        wallObject('WALL-1'),
        {
          ...wallObject('WALL-2'),
          properties: { category: 'Walls', Comments: 'PASSAGEM PREVISTA' }
        },
        // not a wall: outside group B
        columnObject(`OTHER-${round}`, 'C30')
      ]
    })
    await markIfcUpload(project.id, a.versionId, owner.id)
    await markIfcUpload(project.id, b.versionId, owner.id)
    return { a, b }
  }

  /** Simulates the Python worker: raw pairs, then geometry_done. */
  const simulateGeometry = async (runId: string) => {
    await db(CoordClashRaw.name).insert([
      {
        runId,
        keyA: 'COL-1',
        keyB: 'WALL-1',
        distanceMm: -30,
        clashType: 'collision',
        point: [1, 2, 3]
      },
      {
        runId,
        keyA: 'COL-2',
        keyB: 'WALL-1',
        distanceMm: -5,
        clashType: 'pierce',
        relation: 'connected'
      },
      { runId, keyA: 'COL-1', keyB: 'WALL-2', distanceMm: -80, clashType: 'pierce' }
    ])
    await db(CoordClashRuns.name).where({ id: runId }).update({
      status: 'geometry_done',
      attempt: 1,
      geometrySeconds: 1.5,
      peakRssMb: 300
    })
  }

  before(async () => {
    await beforeEachContext()
    await createTestUsers([owner, outsider])
    await createTestStreams([
      [project, owner],
      [other, outsider]
    ])
    await createTestBranch({ branch: structure, stream: project, owner })
    await createTestBranch({ branch: architecture, stream: project, owner })
    apollo = await testApolloServer({ authUserId: owner.id })
  })

  const validInput = () => ({
    name: 'Estrutura x Arquitetura',
    type: 'hard',
    groupA: {
      modelId: structure.id,
      where: [
        { path: 'properties.category', op: 'equals', value: 'Structural Columns' }
      ]
    },
    groupB: {
      modelId: architecture.id,
      where: [{ path: 'properties.category', op: 'equals', value: 'Walls' }]
    },
    ignore: {
      plannedOpening: {
        path: 'properties.Comments',
        op: 'equals',
        value: 'PASSAGEM PREVISTA'
      }
    }
  })

  it('validates tests and gates writes on publish rights', async () => {
    const clearance = await apollo.execute(createTestMutation, {
      projectId: project.id,
      input: { ...validInput(), type: 'clearance' }
    })
    expect(clearance.errors?.[0].message).to.match(/folga mínima/)

    const foreignModel = await apollo.execute(createTestMutation, {
      projectId: project.id,
      input: { ...validInput(), groupA: { modelId: 'nope123456', where: [] } }
    })
    expect(foreignModel.errors?.[0].message).to.match(/não pertence/)

    const asOutsider = await testApolloServer({ authUserId: outsider.id })
    const denied = await asOutsider.execute(createTestMutation, {
      projectId: project.id,
      input: validInput()
    })
    expect(denied).to.haveGraphQLErrors()

    const res = await apollo.execute(createTestMutation, {
      projectId: project.id,
      input: validInput()
    })
    expect(res).to.not.haveGraphQLErrors()
    testId = res.data!.coordinationMutations.createClashTest.id
  })

  it('refuses to run when a model version did not come from an IFC upload', async () => {
    await createModelVersion({ project, owner, branchId: structure.id, elements: [] })
    await createModelVersion({
      project,
      owner,
      branchId: architecture.id,
      elements: []
    })
    const res = await apollo.execute(runTestMutation, { id: testId })
    expect(res).to.haveGraphQLErrors()
    expect(res.errors?.[0].message).to.match(/IFC original/)
  })

  let firstRunId: string

  it('selects the groups, applies ignore rules and stores fingerprinted clashes', async () => {
    await versions(1)
    const queued = await apollo.execute(runTestMutation, { id: testId })
    expect(queued).to.not.haveGraphQLErrors()
    firstRunId = queued.data!.coordinationMutations.runClashTest.id

    // a second click while it is in flight returns the same run
    const again = await apollo.execute(runTestMutation, { id: testId })
    expect(again.data!.coordinationMutations.runClashTest.id).to.equal(firstRunId)

    await drainClashQueueFactory({ db })()
    const selected = await db(CoordClashRuns.name).where({ id: firstRunId }).first()
    expect(selected).to.include({ status: 'geometry', countA: 2, countB: 2 })

    await simulateGeometry(firstRunId)
    await drainClashQueueFactory({ db })()

    const res = await apollo.execute(runQuery, {
      projectId: project.id,
      runId: firstRunId
    })
    expect(res).to.not.haveGraphQLErrors()
    const run = res.data!.project.coordination.clashRun
    // COL-2 x WALL-1 is connected (ignored); WALL-2 is a planned opening (ignored)
    expect(run).to.include({
      status: 'succeeded',
      rawCount: 3,
      ignoredCount: 2,
      clashCount: 1
    })
    expect(run.clashes).to.have.length(1)
    expect(run.clashes[0]).to.include({
      keyA: 'COL-1',
      keyB: 'WALL-1',
      distanceMm: -30,
      status: 'new'
    })
    expect(run.clashes[0].speckleObjectIdA).to.be.a('string')
    expect(run.statusCounts).to.deep.equal([{ status: 'new', count: 1 }])

    const triaged = await apollo.execute(setStatusMutation, {
      ids: [run.clashes[0].id],
      status: 'reviewed',
      comment: 'Furo a confirmar com a estrutura'
    })
    expect(triaged.data!.coordinationMutations.setClashStatus).to.equal(1)
  })

  it('carries status and comment over to the next run by fingerprint', async () => {
    await versions(2)
    const queued = await apollo.execute(runTestMutation, { id: testId })
    const runId = queued.data!.coordinationMutations.runClashTest.id
    expect(runId).to.not.equal(firstRunId)
    await drainClashQueueFactory({ db })()
    await simulateGeometry(runId)
    await drainClashQueueFactory({ db })()

    const res = await apollo.execute(runQuery, { projectId: project.id, runId })
    const [clash] = res.data!.project.coordination.clashRun.clashes
    expect(clash).to.include({
      status: 'reviewed',
      comment: 'Furo a confirmar com a estrutura'
    })
  })

  it('gates status changes and assignments', async () => {
    const res = await apollo.execute(runQuery, {
      projectId: project.id,
      runId: firstRunId
    })
    const ids = res.data!.project.coordination.clashRun.clashes.map(
      (c: { id: string }) => c.id
    )

    const asOutsider = await testApolloServer({ authUserId: outsider.id })
    const denied = await asOutsider.execute(setStatusMutation, {
      ids,
      status: 'approved'
    })
    expect(denied).to.haveGraphQLErrors()

    const badStatus = await apollo.execute(setStatusMutation, {
      ids,
      status: 'deleted'
    })
    expect(badStatus.errors?.[0].message).to.match(/Status de clash inválido/)

    const notMember = await apollo.execute(assignMutation, {
      ids,
      assignee: outsider.id
    })
    expect(notMember.errors?.[0].message).to.match(/colaborador do projeto/)

    const assigned = await apollo.execute(assignMutation, { ids, assignee: owner.id })

    const team = await apollo.execute(
      gql`
        query ($projectId: String!) {
          project(id: $projectId) {
            coordination {
              clashAssignees {
                id
                name
              }
            }
          }
        }
      `,
      { projectId: project.id }
    )
    // only collaborators of this project (the outsider owns another one)
    expect(team.data!.project.coordination.clashAssignees).to.deep.equal([
      { id: owner.id, name: owner.name }
    ])
    expect(assigned.data!.coordinationMutations.assignClashes).to.equal(1)
  })

  it('fingerprint ignores pair order; carry-over reopens resolved clashes', () => {
    expect(clashFingerprint('A', 'B', 't')).to.equal(clashFingerprint('B', 'A', 't'))
    expect(clashFingerprint('A', 'B', 't')).to.not.equal(
      clashFingerprint('A', 'B', 'u')
    )
    expect(carriedStatus(undefined)).to.equal('new')
    expect(carriedStatus('new')).to.equal('active')
    expect(carriedStatus('resolved')).to.equal('active')
    expect(carriedStatus('approved')).to.equal('approved')
  })
})
