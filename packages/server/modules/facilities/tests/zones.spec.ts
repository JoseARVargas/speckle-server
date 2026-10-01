import { db } from '@/db/knex'
import { ensureFacilityFactory, newId } from '@/modules/facilities/services/facilities'
import { insertFloorFactory } from '@/modules/facilities/repositories/facilities'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { createTestStreams } from '@/test/speckle-helpers/streamHelper'
import { expect } from 'chai'
import gql from 'graphql-tag'

const createZoneMutation = gql`
  mutation ($input: CreateZoneInput!) {
    facilityMutations {
      createZone(input: $input) {
        id
        floorId
        name
      }
    }
  }
`

const createSpaceMutation = gql`
  mutation ($input: CreateSpaceInput!) {
    facilityMutations {
      createSpace(input: $input) {
        id
        floorId
        zoneId
      }
    }
  }
`

const updateSpaceMutation = gql`
  mutation ($input: UpdateSpaceInput!) {
    facilityMutations {
      updateSpace(input: $input) {
        id
        floorId
        zoneId
      }
    }
  }
`

/**
 * Covers the Zone level added between Floor and Space: a Zone must belong
 * to a Floor of the same facility, and a Space's zoneId must point at a
 * Zone under its own floorId - see .ai/plans/2026-10-01-hierarquia-espacial-zonas.md.
 */
describe('Zones (Floor -> Zone -> Space)', () => {
  const owner: BasicTestUser = { name: 'facility owner', email: '', id: '' }
  const outsider: BasicTestUser = { name: 'outsider', email: '', id: '' }
  const projectA: BasicTestStream = {
    name: 'Zone test project A',
    isPublic: false,
    ownerId: '',
    id: ''
  }
  const projectB: BasicTestStream = {
    name: 'Zone test project B',
    isPublic: false,
    ownerId: '',
    id: ''
  }

  let ownerApollo: TestApolloServer
  let outsiderApollo: TestApolloServer
  let floorA: string
  let floorA2: string
  let floorB: string

  before(async () => {
    await beforeEachContext()
    await createTestUsers([owner, outsider])
    await createTestStreams([
      [projectA, owner],
      [projectB, owner]
    ])

    const facilityA = await ensureFacilityFactory({ db })({ projectId: projectA.id })
    const facilityB = await ensureFacilityFactory({ db })({ projectId: projectB.id })
    const now = new Date()

    floorA = newId()
    await insertFloorFactory({ db })({
      id: floorA,
      projectId: projectA.id,
      facilityId: facilityA.id,
      name: 'Floor A',
      elevationZ: null,
      createdAt: now,
      updatedAt: now
    })

    floorA2 = newId()
    await insertFloorFactory({ db })({
      id: floorA2,
      projectId: projectA.id,
      facilityId: facilityA.id,
      name: 'Floor A2',
      elevationZ: null,
      createdAt: now,
      updatedAt: now
    })

    floorB = newId()
    await insertFloorFactory({ db })({
      id: floorB,
      projectId: projectB.id,
      facilityId: facilityB.id,
      name: 'Floor B',
      elevationZ: null,
      createdAt: now,
      updatedAt: now
    })

    ownerApollo = await testApolloServer({ authUserId: owner.id })
    outsiderApollo = await testApolloServer({ authUserId: outsider.id })
  })

  it('creates a zone under a floor of the same facility', async () => {
    const res = await ownerApollo.execute(createZoneMutation, {
      input: { projectId: projectA.id, floorId: floorA, name: 'Ala Norte' }
    })
    expect(res).to.not.haveGraphQLErrors()
    expect(res.data?.facilityMutations.createZone.floorId).to.equal(floorA)
  })

  it("rejects a zone whose floor belongs to another project's facility", async () => {
    const res = await ownerApollo.execute(createZoneMutation, {
      input: { projectId: projectA.id, floorId: floorB, name: 'Invalid zone' }
    })
    expect(res).to.haveGraphQLErrors()
  })

  it('rejects a user without manage access to the facility', async () => {
    const res = await outsiderApollo.execute(createZoneMutation, {
      input: { projectId: projectA.id, floorId: floorA, name: 'Not allowed' }
    })
    expect(res).to.haveGraphQLErrors()
  })

  it('creates a space with a zone that belongs to the chosen floor', async () => {
    const zoneRes = await ownerApollo.execute(createZoneMutation, {
      input: { projectId: projectA.id, floorId: floorA, name: 'Ala Sul' }
    })
    expect(zoneRes).to.not.haveGraphQLErrors()
    const zoneId = zoneRes.data?.facilityMutations.createZone.id as string

    const spaceRes = await ownerApollo.execute(createSpaceMutation, {
      input: { projectId: projectA.id, name: 'Sala 1', floorId: floorA, zoneId }
    })
    expect(spaceRes).to.not.haveGraphQLErrors()
    expect(spaceRes.data?.facilityMutations.createSpace.zoneId).to.equal(zoneId)
  })

  it("rejects a space whose zone doesn't belong to its own floor", async () => {
    const zoneRes = await ownerApollo.execute(createZoneMutation, {
      input: { projectId: projectA.id, floorId: floorA, name: 'Zone on Floor A' }
    })
    const zoneId = zoneRes.data?.facilityMutations.createZone.id as string

    const res = await ownerApollo.execute(createSpaceMutation, {
      input: { projectId: projectA.id, name: 'Sala errada', floorId: floorA2, zoneId }
    })
    expect(res).to.haveGraphQLErrors()
  })

  it('rejects a zone on a space with no floor', async () => {
    const zoneRes = await ownerApollo.execute(createZoneMutation, {
      input: { projectId: projectA.id, floorId: floorA, name: 'Orphan zone attempt' }
    })
    const zoneId = zoneRes.data?.facilityMutations.createZone.id as string

    const res = await ownerApollo.execute(createSpaceMutation, {
      input: { projectId: projectA.id, name: 'Sem pavimento', zoneId }
    })
    expect(res).to.haveGraphQLErrors()
  })

  it('allows clearing a space zone on update', async () => {
    const zoneRes = await ownerApollo.execute(createZoneMutation, {
      input: { projectId: projectA.id, floorId: floorA, name: 'Zone to clear' }
    })
    const zoneId = zoneRes.data?.facilityMutations.createZone.id as string
    const spaceRes = await ownerApollo.execute(createSpaceMutation, {
      input: { projectId: projectA.id, name: 'Sala 2', floorId: floorA, zoneId }
    })
    const spaceId = spaceRes.data?.facilityMutations.createSpace.id as string

    const res = await ownerApollo.execute(updateSpaceMutation, {
      input: { id: spaceId, zoneId: null }
    })
    expect(res).to.not.haveGraphQLErrors()
    expect(res.data?.facilityMutations.updateSpace.zoneId).to.equal(null)
  })

  it('rejects updating a space to a zone from a different floor', async () => {
    const zoneOnA = await ownerApollo.execute(createZoneMutation, {
      input: {
        projectId: projectA.id,
        floorId: floorA,
        name: 'Zone on A for update test'
      }
    })
    const zoneOnA2 = await ownerApollo.execute(createZoneMutation, {
      input: {
        projectId: projectA.id,
        floorId: floorA2,
        name: 'Zone on A2 for update test'
      }
    })
    const zoneOnA2Id = zoneOnA2.data?.facilityMutations.createZone.id as string
    const spaceRes = await ownerApollo.execute(createSpaceMutation, {
      input: {
        projectId: projectA.id,
        name: 'Sala 3',
        floorId: floorA,
        zoneId: zoneOnA.data?.facilityMutations.createZone.id as string
      }
    })
    const spaceId = spaceRes.data?.facilityMutations.createSpace.id as string

    const res = await ownerApollo.execute(updateSpaceMutation, {
      input: { id: spaceId, zoneId: zoneOnA2Id }
    })
    expect(res).to.haveGraphQLErrors()
  })
})
