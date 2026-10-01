import { expect } from 'chai'
import gql from 'graphql-tag'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { createTestStreams } from '@/test/speckle-helpers/streamHelper'
import {
  createModelVersion,
  exampleRuleSet,
  importRuleSetMutation,
  publishMutation,
  runCheckMutation
} from '@/modules/facilities/tests/coordinationHelpers'

const ruleSetQuery = gql`
  query ($projectId: String!, $ruleSetId: String!) {
    project(id: $projectId) {
      coordination {
        ruleSet(id: $ruleSetId) {
          id
        }
        ruleSets {
          id
        }
      }
    }
  }
`

const createMilestoneMutation = gql`
  mutation ($projectId: String!, $name: String!) {
    coordinationMutations {
      createMilestone(projectId: $projectId, input: { name: $name }) {
        id
      }
    }
  }
`

const createSourceMutation = gql`
  mutation ($projectId: String!) {
    coordinationMutations {
      createRequirementSource(
        projectId: $projectId
        input: { kind: EIR, title: "EIR" }
      ) {
        id
      }
    }
  }
`

const createRequirementMutation = gql`
  mutation ($projectId: String!, $sourceId: String!, $milestoneId: String) {
    coordinationMutations {
      createRequirement(
        projectId: $projectId
        input: {
          sourceId: $sourceId
          milestoneId: $milestoneId
          code: "EIR 9.9"
          title: "X"
        }
      ) {
        id
      }
    }
  }
`

const deleteRuleSetMutation = gql`
  mutation ($id: String!) {
    coordinationMutations {
      deleteRuleSet(id: $id)
    }
  }
`

/**
 * Authorization of the coordination module: reads only through the caller's
 * own project, mutations gated on the stored record's project, and ids from
 * other projects refused - see
 * speckle-digitaltwin-console/.ai/plans/2026-10-01-coordenacao-bim-model-check.md.
 */
describe('Coordination access control', () => {
  const owner: BasicTestUser = { name: 'coord owner', email: '', id: '' }
  const outsider: BasicTestUser = { name: 'coord outsider', email: '', id: '' }
  const projectA: BasicTestStream = {
    name: 'Coord access A',
    isPublic: false,
    ownerId: '',
    id: ''
  }
  const projectB: BasicTestStream = {
    name: 'Coord access B',
    isPublic: false,
    ownerId: '',
    id: ''
  }

  let ownerApollo: TestApolloServer
  let outsiderApollo: TestApolloServer
  let ruleSetA: string
  let ruleSetB: string

  before(async () => {
    await beforeEachContext()
    await createTestUsers([owner, outsider])
    await createTestStreams([
      [projectA, owner],
      [projectB, owner]
    ])
    ownerApollo = await testApolloServer({ authUserId: owner.id })
    outsiderApollo = await testApolloServer({ authUserId: outsider.id })

    const a = await ownerApollo.execute(importRuleSetMutation, {
      projectId: projectA.id,
      document: exampleRuleSet
    })
    expect(a).to.not.haveGraphQLErrors()
    ruleSetA = a.data!.coordinationMutations.importRuleSet.ruleSet.id
    const b = await ownerApollo.execute(importRuleSetMutation, {
      projectId: projectB.id,
      document: exampleRuleSet
    })
    expect(b).to.not.haveGraphQLErrors()
    ruleSetB = b.data!.coordinationMutations.importRuleSet.ruleSet.id
  })

  it('does not resolve a rule set of another project through this project', async () => {
    const res = await ownerApollo.execute(ruleSetQuery, {
      projectId: projectA.id,
      ruleSetId: ruleSetB
    })
    expect(res).to.not.haveGraphQLErrors()
    expect(res.data?.project.coordination.ruleSet).to.equal(null)
    expect(
      res.data?.project.coordination.ruleSets.map((r: { id: string }) => r.id)
    ).to.deep.equal([ruleSetA])
  })

  it('denies reads to a user without access to the project', async () => {
    const res = await outsiderApollo.execute(ruleSetQuery, {
      projectId: projectA.id,
      ruleSetId: ruleSetA
    })
    expect(res).to.haveGraphQLErrors()
  })

  it('denies mutations to a user without access to the project', async () => {
    const imported = await outsiderApollo.execute(importRuleSetMutation, {
      projectId: projectA.id,
      document: exampleRuleSet
    })
    expect(imported).to.haveGraphQLErrors()
    const deleted = await outsiderApollo.execute(deleteRuleSetMutation, {
      id: ruleSetA
    })
    expect(deleted).to.haveGraphQLErrors()
    const published = await outsiderApollo.execute(publishMutation, {
      ruleSetId: ruleSetA
    })
    expect(published).to.haveGraphQLErrors()
  })

  it("rejects a requirement pointing at another project's milestone", async () => {
    const milestoneB = await ownerApollo.execute(createMilestoneMutation, {
      projectId: projectB.id,
      name: 'Marco B'
    })
    expect(milestoneB).to.not.haveGraphQLErrors()
    const sourceA = await ownerApollo.execute(createSourceMutation, {
      projectId: projectA.id
    })
    expect(sourceA).to.not.haveGraphQLErrors()
    const res = await ownerApollo.execute(createRequirementMutation, {
      projectId: projectA.id,
      sourceId: sourceA.data!.coordinationMutations.createRequirementSource.id,
      milestoneId: milestoneB.data!.coordinationMutations.createMilestone.id
    })
    expect(res).to.haveGraphQLErrors()
  })

  it('rejects running a check on a model or version of another project', async () => {
    await ownerApollo.execute(publishMutation, { ruleSetId: ruleSetA })
    const versionB = await createModelVersion({
      project: projectB,
      owner,
      elements: []
    })
    const wrongModel = await ownerApollo.execute(runCheckMutation, {
      ruleSetId: ruleSetA,
      modelId: versionB.modelId
    })
    expect(wrongModel).to.haveGraphQLErrors()

    const versionA = await createModelVersion({
      project: projectA,
      owner,
      elements: []
    })
    const wrongVersion = await ownerApollo.execute(runCheckMutation, {
      ruleSetId: ruleSetA,
      modelId: versionA.modelId,
      versionId: versionB.versionId
    })
    expect(wrongVersion).to.haveGraphQLErrors()
  })
})
