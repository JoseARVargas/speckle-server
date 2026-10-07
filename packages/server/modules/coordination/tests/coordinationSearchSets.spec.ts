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
import {
  CoordClashRuns,
  CoordPropertyIndex,
  FileUploads
} from '@/modules/core/dbSchema'
import { BlobStorage } from '@/modules/blobstorage/repositories'
import {
  columnObject,
  createModelVersion,
  wallObject
} from '@/modules/coordination/tests/coordinationHelpers'

/**
 * Phase 2a: property index (autocomplete, cached per version), Search Sets
 * (CRUD, preview) and their use in clash groups.
 */

const propertiesQuery = gql`
  query ($projectId: String!, $modelId: String!) {
    project(id: $projectId) {
      coordination {
        modelProperties(modelId: $modelId) {
          versionId
          elementCount
          truncated
          paths {
            path
            count
            samples
          }
          ifcTypes {
            type
            count
          }
        }
      }
    }
  }
`

const previewQuery = gql`
  query ($projectId: String!, $modelId: String!, $where: [JSONObject!]!) {
    project(id: $projectId) {
      coordination {
        searchSetPreview(modelId: $modelId, where: $where) {
          elementCount
          matchCount
          objectIds
          sample {
            elementKey
            name
            ifcType
          }
        }
      }
    }
  }
`

const createMutation = gql`
  mutation ($projectId: String!, $input: JSONObject!) {
    coordinationMutations {
      createSearchSet(projectId: $projectId, input: $input) {
        id
        name
        modelId
        where
      }
    }
  }
`

const updateMutation = gql`
  mutation ($id: String!, $input: JSONObject!) {
    coordinationMutations {
      updateSearchSet(id: $id, input: $input) {
        id
        where
      }
    }
  }
`

const deleteMutation = gql`
  mutation ($id: String!) {
    coordinationMutations {
      deleteSearchSet(id: $id)
    }
  }
`

const createClashTestMutation = gql`
  mutation ($projectId: String!, $input: JSONObject!) {
    coordinationMutations {
      createClashTest(projectId: $projectId, input: $input) {
        id
      }
    }
  }
`

const runClashTestMutation = gql`
  mutation ($id: String!) {
    coordinationMutations {
      runClashTest(id: $id) {
        id
      }
    }
  }
`

const columns = {
  path: 'properties.category',
  op: 'equals',
  value: 'Structural Columns'
}

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

describe('Coordination search sets @coordination', () => {
  const owner: BasicTestUser = { name: 'search owner', email: '', id: '' }
  const outsider: BasicTestUser = { name: 'search outsider', email: '', id: '' }
  const project: BasicTestStream = {
    name: 'Search sets project',
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
  let outsiderApollo: TestApolloServer
  let versionA: string

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
    outsiderApollo = await testApolloServer({ authUserId: outsider.id })

    const a = await createModelVersion({
      project,
      owner,
      branchId: structure.id,
      elements: [
        { ...columnObject('COL-1', 'C30'), ifcType: 'IfcColumn' },
        { ...columnObject('COL-2', 'C35'), ifcType: 'IfcColumn' },
        { ...wallObject('WALL-9'), ifcType: 'IfcWall' }
      ]
    })
    versionA = a.versionId
    const b = await createModelVersion({
      project,
      owner,
      branchId: architecture.id,
      elements: [wallObject('WALL-1')]
    })
    await markIfcUpload(project.id, a.versionId, owner.id)
    await markIfcUpload(project.id, b.versionId, owner.id)
  })

  it('indexes the property paths of a version once', async () => {
    const res = await apollo.execute(propertiesQuery, {
      projectId: project.id,
      modelId: structure.id
    })
    expect(res.errors).to.be.undefined
    const index = res.data!.project.coordination.modelProperties
    expect(index.versionId).to.equal(versionA)
    expect(index.elementCount).to.equal(3)
    expect(index.truncated).to.equal(false)
    const byPath = Object.fromEntries(
      (index.paths as { path: string; count: number; samples: string[] }[]).map((p) => [
        p.path,
        p
      ])
    )
    expect(byPath['properties.category'].count).to.equal(3)
    expect(byPath['properties.category'].samples).to.have.members([
      'Structural Columns',
      'Walls'
    ])
    const concrete = byPath['properties.Parameters.Type.Classe do Concreto']
    expect(concrete.count).to.equal(2)
    expect(concrete.samples).to.have.members(['C30', 'C35'])
    // identity fields are not offered as properties
    expect(byPath.id).to.equal(undefined)
    expect(index.ifcTypes).to.deep.equal([
      { type: 'IfcColumn', count: 2 },
      { type: 'IfcWall', count: 1 }
    ])

    const stored = await db(CoordPropertyIndex.name).where({ versionId: versionA })
    expect(stored).to.have.length(1)
    const again = await apollo.execute(propertiesQuery, {
      projectId: project.id,
      modelId: structure.id
    })
    expect(again.data!.project.coordination.modelProperties.elementCount).to.equal(3)
    expect(
      await db(CoordPropertyIndex.name).where({ versionId: versionA })
    ).to.have.length(1)
  })

  it('previews how many elements match', async () => {
    const res = await apollo.execute(previewQuery, {
      projectId: project.id,
      modelId: structure.id,
      where: [columns]
    })
    expect(res.errors).to.be.undefined
    const preview = res.data!.project.coordination.searchSetPreview
    expect(preview.elementCount).to.equal(3)
    expect(preview.matchCount).to.equal(2)
    expect(
      preview.sample.map((s: { elementKey: string }) => s.elementKey).sort()
    ).to.deep.equal(['COL-1', 'COL-2'])
    expect(preview.sample[0].ifcType).to.equal('IfcColumn')
    expect(preview.objectIds).to.have.length(2)

    const empty = await apollo.execute(previewQuery, {
      projectId: project.id,
      modelId: structure.id,
      where: []
    })
    expect(empty.errors?.[0].message).to.contain('ao menos uma condição')
  })

  it('creates, renames and protects Search Sets', async () => {
    const created = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { name: 'Pilares', modelId: structure.id, where: [columns] }
    })
    expect(created.errors).to.be.undefined
    const set = created.data!.coordinationMutations.createSearchSet
    expect(set.where).to.deep.equal([columns])

    const duplicate = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { name: 'Pilares', where: [columns] }
    })
    expect(duplicate.errors?.[0].message).to.contain('Já existe um Search Set')

    const foreignModel = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { name: 'x', modelId: 'nope000000', where: [columns] }
    })
    expect(foreignModel.errors).to.not.be.undefined

    const denied = await outsiderApollo.execute(createMutation, {
      projectId: project.id,
      input: { name: 'invasor', where: [columns] }
    })
    expect(denied.errors).to.not.be.undefined
    const deniedUpdate = await outsiderApollo.execute(updateMutation, {
      id: set.id,
      input: { name: 'Pilares', where: [columns] }
    })
    expect(deniedUpdate.errors).to.not.be.undefined
  })

  it('expands the Search Set into the clash run and keeps it frozen', async () => {
    const created = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { name: 'Pilares C30', modelId: structure.id, where: [columns] }
    })
    const set = created.data!.coordinationMutations.createSearchSet

    // a set of another model can't be used in group A
    const wrongModel = await apollo.execute(createClashTestMutation, {
      projectId: project.id,
      input: {
        name: 'errado',
        type: 'hard',
        groupA: { modelId: architecture.id, searchSetId: set.id, where: [] },
        groupB: { modelId: structure.id, where: [] }
      }
    })
    expect(wrongModel.errors?.[0].message).to.contain('é de outro modelo')

    const test = await apollo.execute(createClashTestMutation, {
      projectId: project.id,
      input: {
        name: 'Pilares x Arquitetura',
        type: 'hard',
        groupA: {
          modelId: structure.id,
          searchSetId: set.id,
          where: [
            {
              path: '*.Classe do Concreto',
              match: 'suffix',
              op: 'equals',
              value: 'C30'
            }
          ]
        },
        groupB: { modelId: architecture.id, where: [] }
      }
    })
    expect(test.errors).to.be.undefined
    const testId = test.data!.coordinationMutations.createClashTest.id

    const run = await apollo.execute(runClashTestMutation, { id: testId })
    expect(run.errors).to.be.undefined
    const runId = run.data!.coordinationMutations.runClashTest.id
    const stored = await db(CoordClashRuns.name).where({ id: runId }).first()
    const where = stored.settings.groupA.where as { path: string }[]
    expect(where.map((c) => c.path)).to.deep.equal([
      'properties.category',
      '*.Classe do Concreto'
    ])

    // editing the set later doesn't touch the queued run
    await apollo.execute(updateMutation, {
      id: set.id,
      input: {
        name: 'Pilares C30',
        modelId: structure.id,
        where: [{ path: 'properties.category', op: 'equals', value: 'Walls' }]
      }
    })
    const after = await db(CoordClashRuns.name).where({ id: runId }).first()
    expect(after.settings.groupA.where[0].value).to.equal('Structural Columns')

    // in use by a clash test: can't be deleted
    const blocked = await apollo.execute(deleteMutation, { id: set.id })
    expect(blocked.errors?.[0].message).to.contain('Pilares x Arquitetura')
  })

  it('deletes an unused Search Set', async () => {
    const created = await apollo.execute(createMutation, {
      projectId: project.id,
      input: { name: 'Temporário', where: [columns] }
    })
    const id = created.data!.coordinationMutations.createSearchSet.id
    const outsiderDelete = await outsiderApollo.execute(deleteMutation, { id })
    expect(outsiderDelete.errors).to.not.be.undefined
    const res = await apollo.execute(deleteMutation, { id })
    expect(res.data!.coordinationMutations.deleteSearchSet).to.equal(true)
  })
})
