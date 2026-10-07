import { expect } from 'chai'
import gql from 'graphql-tag'
import { db } from '@/db/knex'
import { Roles } from '@/modules/core/helpers/mainConstants'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { addToStream, createTestStreams } from '@/test/speckle-helpers/streamHelper'
import type { BasicTestBranch } from '@/test/speckle-helpers/branchHelper'
import { createTestBranch } from '@/test/speckle-helpers/branchHelper'
import {
  CoordDeliverableRequirements,
  CoordDeliverables,
  CoordRequirements
} from '@/modules/core/dbSchema'
import { drainCheckRunQueueFactory } from '@/modules/coordination/services/coordinationRunner'
import { DEFAULT_CDE_CONFIG } from '@/modules/coordination/helpers/cdeTypes'
import {
  columnObject,
  createModelVersion,
  exampleRuleSet,
  importRuleSetMutation,
  publishMutation,
  runCheckMutation
} from '@/modules/coordination/tests/coordinationHelpers'

/**
 * ISO 19650 CDE flow per version (plan 2026-10-07-upload-midp-cde): new
 * versions in WIP, sharing with suitability and P revisions, publishing by an
 * approver with C revisions, superseded publications archived, rejection that
 * keeps the previous shared version, derived MIDP status, configurable states
 * and the Model Check criteria.
 */

const STATE_FIELDS = `id versionId stage stateCode suitability revision action kind comment changedBy`

const transitionMutation = gql`
  mutation ($projectId: String!, $versionId: String!, $input: JSONObject!) {
    coordinationMutations {
      transitionVersion(projectId: $projectId, versionId: $versionId, input: $input) {
        ${STATE_FIELDS}
      }
    }
  }
`

const modelCdeQuery = gql`
  query ($projectId: String!, $modelId: String!) {
    project(id: $projectId) {
      coordination {
        modelCde(modelId: $modelId) {
          versionId
          current { ${STATE_FIELDS} }
          history { ${STATE_FIELDS} }
        }
      }
    }
  }
`

const approversMutation = gql`
  mutation ($projectId: String!, $userIds: [String!]!) {
    coordinationMutations {
      setCdeApprovers(projectId: $projectId, userIds: $userIds) {
        userIds
        fallbackToOwners
      }
    }
  }
`

const configMutation = gql`
  mutation ($projectId: String!, $config: JSONObject!) {
    coordinationMutations {
      setCdeConfig(projectId: $projectId, config: $config)
    }
  }
`

const linkModelMutation = gql`
  mutation ($id: String!, $modelId: String) {
    coordinationMutations {
      setDeliverableModel(id: $id, modelId: $modelId) {
        id
        modelId
        status
      }
    }
  }
`

type StateRow = {
  versionId: string
  stage: string
  stateCode: string
  suitability: string | null
  revision: string | null
  action: string
  kind: string
  comment: string | null
}

describe('Coordination CDE states @coordination', () => {
  const owner: BasicTestUser = { name: 'cde owner', email: '', id: '' }
  const author: BasicTestUser = { name: 'cde contributor', email: '', id: '' }
  const approver: BasicTestUser = { name: 'cde approver', email: '', id: '' }
  const reviewer: BasicTestUser = { name: 'cde reviewer', email: '', id: '' }
  const outsider: BasicTestUser = { name: 'cde outsider', email: '', id: '' }
  const project: BasicTestStream = {
    name: 'CDE project',
    isPublic: false,
    ownerId: '',
    id: ''
  }
  const other: BasicTestStream = { name: 'Other', isPublic: false, ownerId: '', id: '' }

  let ownerApi: TestApolloServer
  let authorApi: TestApolloServer
  let approverApi: TestApolloServer
  let reviewerApi: TestApolloServer
  let outsiderApi: TestApolloServer
  const drain = drainCheckRunQueueFactory({ db })
  /** Config the later tests build on (once a custom state is used, it stays). */
  let baseConfig: Record<string, unknown> = DEFAULT_CDE_CONFIG

  const newModel = async (name: string) => {
    const branch: BasicTestBranch = { name, streamId: '', authorId: '', id: '' }
    await createTestBranch({ branch, stream: project, owner })
    return branch.id
  }

  const newVersion = async (modelId: string, concrete = 'C30') =>
    (
      await createModelVersion({
        project,
        owner,
        branchId: modelId,
        elements: [columnObject(`col-${Math.random()}`, concrete)]
      })
    ).versionId

  /** A model deliverable inserted directly (the MIDP API is covered elsewhere). */
  const newDeliverable = async (number: number) => {
    const id = `dl${String(number).padStart(8, '0')}`
    await db(CoordDeliverables.name).insert({
      id,
      projectId: project.id,
      containerName: `PRJ-ORG-ZZ-00-M3-S-${String(number).padStart(4, '0')}`,
      title: `Modelo ${number}`,
      kind: 'model',
      project: 'PRJ',
      originator: 'ORG',
      volume: 'ZZ',
      level: '00',
      type: 'M3',
      role: 'S',
      number,
      status: 'not_started',
      createdAt: new Date(),
      updatedAt: new Date()
    })
    return id
  }

  const deliverableStatus = async (id: string) =>
    (await db(CoordDeliverables.name).where({ id }).first()).status as string

  const cde = async (modelId: string) => {
    const res = await ownerApi.execute(modelCdeQuery, {
      projectId: project.id,
      modelId
    })
    expect(res).to.not.haveGraphQLErrors()
    return res.data!.project!.coordination.modelCde as {
      versionId: string
      current: StateRow
      history: StateRow[]
    }[]
  }
  const current = async (modelId: string, versionId: string) =>
    (await cde(modelId)).find((v) => v.versionId === versionId)!.current

  const transition = (
    api: TestApolloServer,
    versionId: string,
    input: Record<string, unknown>
  ) => api.execute(transitionMutation, { projectId: project.id, versionId, input })

  const share = async (versionId: string, api = authorApi) => {
    const res = await transition(api, versionId, {
      toStateCode: 'SHARED',
      suitability: 'S4'
    })
    expect(res).to.not.haveGraphQLErrors()
    return res.data!.coordinationMutations.transitionVersion as StateRow
  }

  before(async () => {
    await beforeEachContext()
    await createTestUsers([owner, author, approver, reviewer, outsider])
    await createTestStreams([
      [project, owner],
      [other, outsider]
    ])
    await addToStream(project, author, Roles.Stream.Contributor, { owner })
    await addToStream(project, approver, Roles.Stream.Contributor, { owner })
    await addToStream(project, reviewer, Roles.Stream.Reviewer, { owner })
    ownerApi = await testApolloServer({ authUserId: owner.id })
    authorApi = await testApolloServer({ authUserId: author.id })
    approverApi = await testApolloServer({ authUserId: approver.id })
    reviewerApi = await testApolloServer({ authUserId: reviewer.id })
    outsiderApi = await testApolloServer({ authUserId: outsider.id })
  })

  it('puts every new version in WIP and links it to the model deliverable', async () => {
    const modelId = await newModel('wip')
    const deliverableId = await newDeliverable(1)
    const link = await authorApi.execute(linkModelMutation, {
      id: deliverableId,
      modelId
    })
    expect(link).to.not.haveGraphQLErrors()

    const versionId = await newVersion(modelId)
    const state = await current(modelId, versionId)
    expect(state).to.include({
      stage: 'wip',
      stateCode: 'WIP',
      action: 'created',
      kind: 'system'
    })
    expect(await deliverableStatus(deliverableId)).to.equal('in_progress')

    // a model belongs to one deliverable at most
    const second = await newDeliverable(2)
    const dup = await authorApi.execute(linkModelMutation, { id: second, modelId })
    expect(dup.errors?.[0].message).to.match(/já é do entregável/)
  })

  it('shares with a suitability code and numbers P revisions', async () => {
    const modelId = await newModel('share')
    const v1 = await newVersion(modelId)
    const noCode = await transition(authorApi, v1, { toStateCode: 'SHARED' })
    expect(noCode.errors?.[0].message).to.match(/código de adequação/)

    expect(await share(v1)).to.include({
      stage: 'shared',
      suitability: 'S4',
      revision: 'P01'
    })
    const v2 = await newVersion(modelId)
    expect((await share(v2)).revision).to.equal('P02')
  })

  it('lets only contributors and owners move versions', async () => {
    const modelId = await newModel('roles')
    const v1 = await newVersion(modelId)
    const asReviewer = await transition(reviewerApi, v1, {
      toStateCode: 'SHARED',
      suitability: 'S1'
    })
    // refused by the module access gate (canPublish) before the CDE rule
    expect(asReviewer.errors?.[0].message).to.match(
      /role on this project|colaboradores e donos/
    )
    const asOutsider = await transition(outsiderApi, v1, {
      toStateCode: 'SHARED',
      suitability: 'S1'
    })
    expect(asOutsider).to.haveGraphQLErrors()
  })

  it('publishes by the owner while there are no approvers and archives the previous publication', async () => {
    const modelId = await newModel('publish')
    const deliverableId = await newDeliverable(3)
    await authorApi.execute(linkModelMutation, { id: deliverableId, modelId })
    const v1 = await newVersion(modelId)
    await share(v1)

    const byContributor = await transition(approverApi, v1, {
      toStateCode: 'PUBLISHED',
      suitability: 'A1'
    })
    expect(byContributor.errors?.[0].message).to.match(/dono do projeto aprova/)

    const published = await transition(ownerApi, v1, {
      toStateCode: 'PUBLISHED',
      suitability: 'A1'
    })
    expect(published).to.not.haveGraphQLErrors()
    expect(published.data!.coordinationMutations.transitionVersion).to.include({
      stage: 'published',
      revision: 'C01',
      suitability: 'A1'
    })
    expect(await deliverableStatus(deliverableId)).to.equal('published')

    const v2 = await newVersion(modelId)
    await share(v2)
    await transition(ownerApi, v2, { toStateCode: 'PUBLISHED', suitability: 'B' })
    const old = await current(modelId, v1)
    expect(old).to.include({ stage: 'archived', action: 'archived', kind: 'system' })
    expect(old.comment).to.equal('Substituída por C02')
  })

  it('keeps the previous shared version when a later one is rejected', async () => {
    const modelId = await newModel('reject')
    const deliverableId = await newDeliverable(4)
    await authorApi.execute(linkModelMutation, { id: deliverableId, modelId })
    const v1 = await newVersion(modelId)
    const v2 = await newVersion(modelId)
    await share(v1)
    await share(v2)

    const noReason = await transition(ownerApi, v2, { toStateCode: 'WIP' })
    expect(noReason.errors?.[0].message).to.match(/motivo da recusa/)
    const rejected = await transition(ownerApi, v2, {
      toStateCode: 'WIP',
      comment: 'Faltam os pilares do 2º pavimento'
    })
    expect(rejected).to.not.haveGraphQLErrors()

    expect((await current(modelId, v1)).stage).to.equal('shared')
    expect(await current(modelId, v2)).to.include({ stage: 'wip', action: 'rejected' })
    expect(await deliverableStatus(deliverableId)).to.equal('blocked')
    // the rejected P02 is not reused
    expect((await share(v2)).revision).to.equal('P03')
    expect(await deliverableStatus(deliverableId)).to.equal('in_review')
  })

  it('uses the designated approvers and keeps author and approver apart', async () => {
    const notOwner = await authorApi.execute(approversMutation, {
      projectId: project.id,
      userIds: [approver.id]
    })
    expect(notOwner.errors?.[0].message).to.match(/dono do projeto/)
    const notMember = await ownerApi.execute(approversMutation, {
      projectId: project.id,
      userIds: [outsider.id]
    })
    expect(notMember.errors?.[0].message).to.match(/colaborador ou dono/)
    const set = await ownerApi.execute(approversMutation, {
      projectId: project.id,
      userIds: [approver.id, author.id]
    })
    expect(set.data!.coordinationMutations.setCdeApprovers).to.deep.include({
      fallbackToOwners: false
    })

    const modelId = await newModel('approvers')
    const v1 = await newVersion(modelId)
    await share(v1, authorApi)
    const own = await transition(authorApi, v1, {
      toStateCode: 'PUBLISHED',
      suitability: 'A1'
    })
    expect(own.errors?.[0].message).to.match(/não pode aprová-la/)
    const ownerNow = await transition(ownerApi, v1, {
      toStateCode: 'PUBLISHED',
      suitability: 'A1'
    })
    expect(ownerNow.errors?.[0].message).to.match(/aprovador do projeto/)
    const ok = await transition(approverApi, v1, {
      toStateCode: 'PUBLISHED',
      suitability: 'A1'
    })
    expect(ok).to.not.haveGraphQLErrors()

    await ownerApi.execute(approversMutation, { projectId: project.id, userIds: [] })
  })

  it('accepts custom states and protects codes used in the history', async () => {
    const custom = {
      ...DEFAULT_CDE_CONFIG,
      states: [
        DEFAULT_CDE_CONFIG.states[0],
        { code: 'CHECK', label: 'Verificação interna', stage: 'wip', active: true },
        ...DEFAULT_CDE_CONFIG.states.slice(1)
      ]
    }
    const saved = await ownerApi.execute(configMutation, {
      projectId: project.id,
      config: custom
    })
    expect(saved).to.not.haveGraphQLErrors()

    const modelId = await newModel('custom')
    const v1 = await newVersion(modelId)
    const skip = await transition(authorApi, v1, {
      toStateCode: 'SHARED',
      suitability: 'S1'
    })
    expect(skip.errors?.[0].message).to.match(/Conclua os estados de WIP/)
    const check = await transition(authorApi, v1, { toStateCode: 'CHECK' })
    expect(check.data!.coordinationMutations.transitionVersion).to.include({
      stage: 'wip',
      stateCode: 'CHECK',
      action: 'advanced'
    })
    expect((await share(v1)).revision).to.equal('P01')

    // CHECK is in the history now: it can be deactivated, not removed
    const removed = await ownerApi.execute(configMutation, {
      projectId: project.id,
      config: DEFAULT_CDE_CONFIG
    })
    expect(removed.errors?.[0].message).to.match(/CHECK já foi usado/)
    const invalid = await ownerApi.execute(configMutation, {
      projectId: project.id,
      config: { ...DEFAULT_CDE_CONFIG, states: DEFAULT_CDE_CONFIG.states.slice(0, 3) }
    })
    expect(invalid).to.haveGraphQLErrors()
    baseConfig = {
      ...custom,
      states: custom.states.map((s) =>
        s.code === 'CHECK' ? { ...s, active: false } : s
      )
    }
    const deactivated = await ownerApi.execute(configMutation, {
      projectId: project.id,
      config: baseConfig
    })
    expect(deactivated).to.not.haveGraphQLErrors()
  })

  describe('Model Check criteria', () => {
    let ruleSetId: string
    let requirementId: string

    before(async () => {
      const imported = await ownerApi.execute(importRuleSetMutation, {
        projectId: project.id,
        document: exampleRuleSet
      })
      expect(imported).to.not.haveGraphQLErrors()
      ruleSetId = imported.data!.coordinationMutations.importRuleSet.ruleSet.id
      await ownerApi.execute(publishMutation, { ruleSetId })
      const requirement = await db(CoordRequirements.name)
        .where({ projectId: project.id, code: 'EIR 4.2' })
        .first()
      requirementId = requirement.id
      await db(CoordRequirements.name)
        .where({ id: requirementId })
        .update({ targetPct: 100 })
    })

    const checkedModel = async (name: string, number: number) => {
      const modelId = await newModel(name)
      const deliverableId = await newDeliverable(number)
      await authorApi.execute(linkModelMutation, { id: deliverableId, modelId })
      await db(CoordDeliverableRequirements.name).insert({
        deliverableId,
        requirementId
      })
      return { modelId, deliverableId }
    }

    const runOn = async (modelId: string, versionId: string) => {
      const run = await ownerApi.execute(runCheckMutation, {
        ruleSetId,
        modelId,
        versionId
      })
      expect(run).to.not.haveGraphQLErrors()
      await drain()
    }

    const setOptions = (options: Record<string, boolean>) =>
      ownerApi.execute(configMutation, {
        projectId: project.id,
        config: { ...baseConfig, ...options }
      })

    it('requires a justification to publish below target and records an exception', async () => {
      await setOptions({ requireAdherenceToPublish: true })
      const { modelId } = await checkedModel('gate', 10)
      const v1 = await newVersion(modelId, 'C20')
      await runOn(modelId, v1)
      await share(v1)

      const blocked = await transition(ownerApi, v1, {
        toStateCode: 'PUBLISHED',
        suitability: 'A1'
      })
      expect(blocked.errors?.[0].message).to.match(/EIR 4\.2 0% < 100%.*justificativa/)
      const withReason = await transition(ownerApi, v1, {
        toStateCode: 'PUBLISHED',
        suitability: 'A1',
        justification: 'Liberado pela coordenação para o orçamento'
      })
      expect(withReason).to.not.haveGraphQLErrors()
      expect(withReason.data!.coordinationMutations.transitionVersion).to.include({
        kind: 'exception',
        stage: 'published'
      })
      await setOptions({ requireAdherenceToPublish: false })
    })

    it('rejects a shared version below target by itself', async () => {
      await setOptions({ autoRejectBelowTarget: true })
      // run first, then share: rejected right after sharing
      const first = await checkedModel('auto-share', 11)
      const v1 = await newVersion(first.modelId, 'C20')
      await runOn(first.modelId, v1)
      await share(v1)
      const afterShare = await current(first.modelId, v1)
      expect(afterShare).to.include({
        stage: 'wip',
        action: 'rejected',
        kind: 'automatic'
      })
      expect(afterShare.comment).to.match(
        /Model Check abaixo da meta: EIR 4\.2 0% < 100%/
      )
      expect(await deliverableStatus(first.deliverableId)).to.equal('blocked')

      // share first, then the run finishes: rejected when the run ends
      const second = await checkedModel('auto-run', 12)
      const v2 = await newVersion(second.modelId, 'C20')
      await share(v2)
      expect((await current(second.modelId, v2)).stage).to.equal('shared')
      await runOn(second.modelId, v2)
      expect(await current(second.modelId, v2)).to.include({
        stage: 'wip',
        kind: 'automatic'
      })

      // meeting the target: stays shared
      const third = await checkedModel('auto-ok', 13)
      const v3 = await newVersion(third.modelId, 'C30')
      await runOn(third.modelId, v3)
      await share(v3)
      expect((await current(third.modelId, v3)).stage).to.equal('shared')
      await setOptions({ autoRejectBelowTarget: false })
    })
  })
})
