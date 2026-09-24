import { db } from '@/db/knex'
import { ensureFacilityFactory, newId } from '@/modules/facilities/services/facilities'
import { insertAssetFactory } from '@/modules/facilities/repositories/facilities'
import { insertSensorFactory } from '@/modules/facilities/repositories/sensors'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { createTestStreams } from '@/test/speckle-helpers/streamHelper'
import { expect } from 'chai'
import gql from 'graphql-tag'

const assetQuery = gql`
  query ($id: String!) {
    asset(id: $id) {
      id
    }
  }
`

const sensorQuery = gql`
  query ($id: String!) {
    sensor(id: $id) {
      id
    }
  }
`

/**
 * Query.asset / Query.sensor fetch straight by id, outside the Project field
 * tree, so they must enforce project read access themselves.
 */
describe('Facilities root queries by id', () => {
  const owner: BasicTestUser = { name: 'facility owner', email: '', id: '' }
  const outsider: BasicTestUser = { name: 'outsider', email: '', id: '' }
  const privateProject: BasicTestStream = {
    name: 'private facility project',
    isPublic: false,
    ownerId: '',
    id: ''
  }

  let assetId: string
  let sensorId: string
  let ownerApollo: TestApolloServer
  let outsiderApollo: TestApolloServer

  before(async () => {
    await beforeEachContext()
    await createTestUsers([owner, outsider])
    await createTestStreams([[privateProject, owner]])

    const facility = await ensureFacilityFactory({ db })({
      projectId: privateProject.id
    })
    const now = new Date()

    assetId = newId()
    await insertAssetFactory({ db })({
      id: assetId,
      projectId: privateProject.id,
      facilityId: facility.id,
      tagNumber: 'AC-01',
      identityCode: `PHD-TEST-${assetId}`,
      name: 'Split AC',
      assetTypeId: null,
      spaceId: null,
      currentObjectId: null,
      currentVersionId: null,
      installDate: null,
      warrantyStartDate: null,
      serialNumber: null,
      barCode: null,
      extendedAttributes: {},
      createdAt: now,
      updatedAt: now
    })

    sensorId = newId()
    await insertSensorFactory({ db })({
      id: sensorId,
      projectId: privateProject.id,
      facilityId: facility.id,
      assetId,
      spaceId: null,
      name: 'Room temperature',
      type: 'temperature',
      unit: '°C',
      manufacturer: null,
      model: null,
      serialNumber: null,
      status: 'active',
      apiKeyHash: 'not-a-real-hash',
      lastReadingValue: null,
      lastReadingAt: null,
      createdAt: now,
      updatedAt: now
    })

    ownerApollo = await testApolloServer({ authUserId: owner.id })
    outsiderApollo = await testApolloServer({ authUserId: outsider.id })
  })

  it('lets a project member fetch an asset and a sensor by id', async () => {
    const assetRes = await ownerApollo.execute(assetQuery, { id: assetId })
    expect(assetRes).to.not.haveGraphQLErrors()
    expect(assetRes.data?.asset?.id).to.equal(assetId)

    const sensorRes = await ownerApollo.execute(sensorQuery, { id: sensorId })
    expect(sensorRes).to.not.haveGraphQLErrors()
    expect(sensorRes.data?.sensor?.id).to.equal(sensorId)
  })

  it("blocks a user without access to the asset's project", async () => {
    const res = await outsiderApollo.execute(assetQuery, { id: assetId })
    expect(res).to.haveGraphQLErrors()
    expect(res.data?.asset).to.not.be.ok
  })

  it("blocks a user without access to the sensor's project", async () => {
    const res = await outsiderApollo.execute(sensorQuery, { id: sensorId })
    expect(res).to.haveGraphQLErrors()
    expect(res.data?.sensor).to.not.be.ok
  })

  it('blocks unauthenticated callers', async () => {
    const anonApollo = await testApolloServer()
    const res = await anonApollo.execute(assetQuery, { id: assetId })
    expect(res).to.haveGraphQLErrors()
    expect(res.data?.asset).to.not.be.ok
  })

  it('returns null for an unknown id', async () => {
    const res = await outsiderApollo.execute(assetQuery, { id: 'does-not-exist' })
    expect(res).to.not.haveGraphQLErrors()
    expect(res.data?.asset).to.equal(null)
  })
})
