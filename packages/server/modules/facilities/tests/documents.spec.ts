import { expect } from 'chai'
import request from 'supertest'
import gql from 'graphql-tag'
import { db } from '@/db/knex'
import { BlobStorage } from '@/modules/blobstorage/repositories'
import { Scopes } from '@/modules/core/helpers/mainConstants'
import { createTokenFactory } from '@/modules/core/services/tokens'
import {
  storeApiTokenFactory,
  storeTokenScopesFactory,
  storeTokenResourceAccessDefinitionsFactory
} from '@/modules/core/repositories/tokens'
import { ensureFacilityFactory, newId } from '@/modules/facilities/services/facilities'
import { insertAssetFactory } from '@/modules/facilities/repositories/facilities'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { createTestStreams } from '@/test/speckle-helpers/streamHelper'

/**
 * NexTwin documents (facility_documents): the blob must be a completed upload
 * of the same project, linked assets must be of the project, the cursor must
 * follow the list order, and the generic blob REST delete must not remove a
 * document's file (see 2026-10-08-documentos-entregaveis-coordenacao.md, B0).
 */

const createToken = createTokenFactory({
  storeApiToken: storeApiTokenFactory({ db }),
  storeTokenScopes: storeTokenScopesFactory({ db }),
  storeTokenResourceAccessDefinitions: storeTokenResourceAccessDefinitionsFactory({
    db
  })
})

const createDocument = gql`
  mutation ($input: CreateFacilityDocumentInput!) {
    documentMutations {
      create(input: $input) {
        id
        fileName
        fileSize
      }
    }
  }
`

const listDocuments = gql`
  query ($projectId: String!, $cursor: String) {
    project(id: $projectId) {
      facility {
        documents(input: { limit: 2, cursor: $cursor }) {
          totalCount
          cursor
          items {
            id
          }
        }
      }
    }
  }
`

describe('Facilities documents @facilities', () => {
  const owner: BasicTestUser = { name: 'docs owner', email: '', id: '' }
  const project: BasicTestStream = {
    name: 'docs project',
    isPublic: false,
    ownerId: '',
    id: ''
  }
  const other: BasicTestStream = {
    name: 'docs other',
    isPublic: false,
    ownerId: '',
    id: ''
  }

  let app: Express.Application
  let token: string
  let apollo: TestApolloServer
  let blobId: string
  let otherProjectBlobId: string
  let foreignAssetId: string

  const upload = async (projectId: string, name: string) => {
    const res = await request(app)
      .post(`/api/stream/${projectId}/blob`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('%PDF-1.4\n% teste\n'), name)
    expect(res.status).to.equal(201)
    const [result] = res.body.uploadResults
    expect(result.uploadStatus).to.equal(1)
    return result.blobId as string
  }

  before(async () => {
    ;({ app } = await beforeEachContext())
    await createTestUsers([owner])
    await createTestStreams([
      [project, owner],
      [other, owner]
    ])
    ;({ token } = await createToken({
      userId: owner.id,
      name: 'docs token',
      scopes: [Scopes.Streams.Write, Scopes.Streams.Read]
    }))
    apollo = await testApolloServer({ authUserId: owner.id })

    blobId = await upload(project.id, 'planta.pdf')
    otherProjectBlobId = await upload(other.id, 'alheio.pdf')

    const otherFacility = await ensureFacilityFactory({ db })({ projectId: other.id })
    foreignAssetId = newId()
    await insertAssetFactory({ db })({
      id: foreignAssetId,
      projectId: other.id,
      facilityId: otherFacility.id,
      tagNumber: 'AC-99',
      identityCode: `NXT-TEST-${foreignAssetId}`,
      name: 'Alheio',
      assetTypeId: null,
      assetClassId: null,
      spaceId: null,
      state: null,
      tenure: null,
      currentObjectId: null,
      currentVersionId: null,
      installDate: null,
      warrantyStartDate: null,
      serialNumber: null,
      barCode: null,
      extendedAttributes: {},
      createdAt: new Date(),
      updatedAt: new Date()
    })
  })

  const base = () => ({ projectId: project.id, title: 'Planta', fileName: 'x.pdf' })

  it('refuses a blob that does not exist, is of another project or did not finish', async () => {
    const missing = await apollo.execute(createDocument, {
      input: { ...base(), blobId: 'nao-existe' }
    })
    expect(missing).to.haveGraphQLErrors('Arquivo não encontrado neste projeto')

    const foreign = await apollo.execute(createDocument, {
      input: { ...base(), blobId: otherProjectBlobId }
    })
    expect(foreign).to.haveGraphQLErrors('Arquivo não encontrado neste projeto')

    const failedId = newId()
    await db(BlobStorage.name).insert({
      id: failedId,
      streamId: project.id,
      userId: owner.id,
      objectKey: null,
      fileName: 'grande.pdf',
      fileType: 'pdf',
      fileSize: 0,
      uploadStatus: 2,
      uploadError: 'File size limit reached'
    })
    const failed = await apollo.execute(createDocument, {
      input: { ...base(), blobId: failedId }
    })
    expect(failed).to.haveGraphQLErrors('não terminou com sucesso')
  })

  it('refuses an asset of another project', async () => {
    const res = await apollo.execute(createDocument, {
      input: { ...base(), blobId, assetId: foreignAssetId }
    })
    expect(res).to.haveGraphQLErrors('Ativo não pertence a este projeto')
  })

  it('creates the document with the file name and size storage recorded', async () => {
    const res = await apollo.execute(createDocument, { input: { ...base(), blobId } })
    expect(res).to.not.haveGraphQLErrors()
    expect(res.data!.documentMutations.create).to.deep.include({
      fileName: 'planta.pdf'
    })
    expect(res.data!.documentMutations.create.fileSize).to.be.greaterThan(0)
  })

  it("keeps a document's file out of the generic blob delete", async () => {
    const referenced = await request(app)
      .delete(`/api/stream/${project.id}/blob/${blobId}`)
      .set('Authorization', `Bearer ${token}`)
    expect(referenced.status).to.equal(409)

    const loose = await upload(project.id, 'solto.pdf')
    const unreferenced = await request(app)
      .delete(`/api/stream/${project.id}/blob/${loose}`)
      .set('Authorization', `Bearer ${token}`)
    expect(unreferenced.status).to.equal(204)
  })

  it('pages with a cursor that follows the list order', async () => {
    for (const name of ['b.pdf', 'c.pdf']) {
      const id = await upload(project.id, name)
      const res = await apollo.execute(createDocument, {
        input: { ...base(), blobId: id }
      })
      expect(res).to.not.haveGraphQLErrors()
    }
    const first = await apollo.execute(listDocuments, { projectId: project.id })
    expect(first).to.not.haveGraphQLErrors()
    const page1 = first.data!.project.facility.documents
    expect(page1.totalCount).to.equal(3)
    expect(page1.items).to.have.length(2)
    expect(page1.cursor).to.be.a('string')

    const second = await apollo.execute(listDocuments, {
      projectId: project.id,
      cursor: page1.cursor
    })
    const page2 = second.data!.project.facility.documents
    expect(page2.items).to.have.length(1)
    const ids = [...page1.items, ...page2.items].map((d: { id: string }) => d.id)
    expect(new Set(ids).size).to.equal(3)
  })
})
