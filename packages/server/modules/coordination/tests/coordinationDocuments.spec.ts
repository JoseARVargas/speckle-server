import { expect } from 'chai'
import request from 'supertest'
import gql from 'graphql-tag'
import { db } from '@/db/knex'
import { Roles, Scopes } from '@/modules/core/helpers/mainConstants'
import { createTokenFactory } from '@/modules/core/services/tokens'
import {
  storeApiTokenFactory,
  storeTokenScopesFactory,
  storeTokenResourceAccessDefinitionsFactory
} from '@/modules/core/repositories/tokens'
import { BlobStorage } from '@/modules/blobstorage/repositories'
import { DEFAULT_CDE_CONFIG } from '@/modules/coordination/helpers/cdeTypes'
import { detectDocumentType } from '@/modules/coordination/services/coordinationDocuments'
import type { BasicTestUser } from '@/test/authHelper'
import { createTestUsers } from '@/test/authHelper'
import type { TestApolloServer } from '@/test/graphqlHelper'
import { testApolloServer } from '@/test/graphqlHelper'
import { beforeEachContext } from '@/test/hooks'
import type { BasicTestStream } from '@/test/speckle-helpers/streamHelper'
import { addToStream, createTestStreams } from '@/test/speckle-helpers/streamHelper'

/**
 * Document deliverables: a file uploaded to blob storage becomes a revision in
 * the ISO 19650 CDE flow (plan
 * speckle-digitaltwin-console/.ai/plans/2026-10-08-documentos-entregaveis-coordenacao.md).
 */

const createToken = createTokenFactory({
  storeApiToken: storeApiTokenFactory({ db }),
  storeTokenScopes: storeTokenScopesFactory({ db }),
  storeTokenResourceAccessDefinitions: storeTokenResourceAccessDefinitionsFactory({
    db
  })
})

const PDF = (marker: string) => Buffer.from(`%PDF-1.7\n% ${marker}\n%%EOF\n`)

const REVISION_FIELDS = `
  id fileName fileSize contentType extension viewable sha256 createdByName
  current { stage stateCode suitability revision action kind documentRevisionId versionId }
  history { action }
`

const addRevision = gql`
  mutation ($deliverableId: String!, $blobId: String!) {
    coordinationMutations {
      addDocumentRevision(deliverableId: $deliverableId, blobId: $blobId) { ${REVISION_FIELDS} }
    }
  }
`
const transition = gql`
  mutation ($revisionId: String!, $input: JSONObject!) {
    coordinationMutations {
      transitionDocumentRevision(revisionId: $revisionId, input: $input) {
        stage
        suitability
        revision
        action
        kind
      }
    }
  }
`
const deleteRevision = gql`
  mutation ($revisionId: String!) {
    coordinationMutations {
      deleteDocumentRevision(revisionId: $revisionId)
    }
  }
`
const deliverableQuery = gql`
  query ($projectId: String!, $id: String!) {
    project(id: $projectId) {
      coordination {
        deliverable(id: $id) {
          status
          documentRevisions { ${REVISION_FIELDS} }
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

describe('Coordination document deliverables @coordination', () => {
  describe('file type detection', () => {
    it('trusts the bytes, not the extension', () => {
      expect(detectDocumentType('a.pdf', PDF('x'))?.contentType).to.equal(
        'application/pdf'
      )
      expect(detectDocumentType('a.PDF', PDF('x'))?.extension).to.equal('pdf')
      expect(detectDocumentType('a.pdf', Buffer.from('<html>oi</html>'))).to.equal(null)
      expect(
        detectDocumentType('a.dwg', Buffer.from('AC1032\0\0'))?.extension
      ).to.equal('dwg')
      expect(detectDocumentType('a.dwg', PDF('x'))).to.equal(null)
      expect(
        detectDocumentType('a.dxf', Buffer.from('  0\r\nSECTION\r\n  2\r\nHEADER'))
      ).to.not.equal(null)
      expect(
        detectDocumentType('a.dxf', Buffer.from('999\nexportado\n0\nSECTION\n'))
      ).to.not.equal(null)
      expect(
        detectDocumentType('a.xlsx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]))
      ).to.not.equal(null)
      expect(detectDocumentType('a.exe', Buffer.from('MZ'))).to.equal(null)
      expect(detectDocumentType('semextensao', PDF('x'))).to.equal(null)
    })
  })

  describe('API', () => {
    const owner: BasicTestUser = { name: 'docs owner', email: '', id: '' }
    const author: BasicTestUser = { name: 'docs author', email: '', id: '' }
    const outsider: BasicTestUser = { name: 'docs outsider', email: '', id: '' }
    const project: BasicTestStream = {
      name: 'Documentos',
      isPublic: false,
      ownerId: '',
      id: ''
    }
    const other: BasicTestStream = {
      name: 'Outro',
      isPublic: false,
      ownerId: '',
      id: ''
    }

    let app: Express.Application
    let token: string
    let ownerApi: TestApolloServer
    let authorApi: TestApolloServer
    let outsiderApi: TestApolloServer
    let drawingId: string
    let modelDeliverableId: string
    let firstRevisionId: string

    const upload = async (projectId: string, name: string, content: Buffer) => {
      const res = await request(app)
        .post(`/api/stream/${projectId}/blob`)
        .set('Authorization', `Bearer ${token}`)
        .attach('file', content, name)
      expect(res.status).to.equal(201)
      return res.body.uploadResults[0].blobId as string
    }
    const blobExists = async (blobId: string) =>
      !!(await db(BlobStorage.name).where({ id: blobId }).first())
    type RevisionView = { id: string; current: Record<string, unknown> }
    const deliverable = async (): Promise<{
      status: string
      documentRevisions: RevisionView[]
    }> => {
      const res = await ownerApi.execute(deliverableQuery, {
        projectId: project.id,
        id: drawingId
      })
      expect(res).to.not.haveGraphQLErrors()
      return res.data!.project.coordination.deliverable as {
        status: string
        documentRevisions: RevisionView[]
      }
    }

    before(async () => {
      ;({ app } = await beforeEachContext())
      await createTestUsers([owner, author, outsider])
      await createTestStreams([
        [project, owner],
        [other, owner]
      ])
      await addToStream(project, author, Roles.Stream.Contributor, { owner })
      ;({ token } = await createToken({
        userId: owner.id,
        name: 'docs token',
        scopes: [Scopes.Streams.Write, Scopes.Streams.Read]
      }))
      ownerApi = await testApolloServer({ authUserId: owner.id })
      authorApi = await testApolloServer({ authUserId: author.id })
      outsiderApi = await testApolloServer({ authUserId: outsider.id })

      // the Model Check gate is on: documents must skip it
      const config = await ownerApi.execute(
        gql`
          mutation ($projectId: String!, $config: JSONObject!) {
            coordinationMutations {
              setCdeConfig(projectId: $projectId, config: $config)
            }
          }
        `,
        {
          projectId: project.id,
          config: { ...DEFAULT_CDE_CONFIG, requireAdherenceToPublish: true }
        }
      )
      expect(config).to.not.haveGraphQLErrors()

      await ownerApi.execute(
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
            type: [{ code: 'DR' }, { code: 'M3' }],
            role: [{ code: 'A' }]
          }
        }
      )
      const base = {
        project: 'P',
        originator: 'O',
        volume: 'ZZ',
        level: 'ZZ',
        role: 'A'
      }
      const drawing = await ownerApi.execute(createDeliverable, {
        projectId: project.id,
        input: { ...base, type: 'DR', kind: 'drawing', title: 'Planta térreo' }
      })
      expect(drawing).to.not.haveGraphQLErrors()
      drawingId = drawing.data!.coordinationMutations.createDeliverable.id
      const model = await ownerApi.execute(createDeliverable, {
        projectId: project.id,
        input: { ...base, type: 'M3', kind: 'model', title: 'Modelo' }
      })
      modelDeliverableId = model.data!.coordinationMutations.createDeliverable.id
    })

    it('refuses files for a model deliverable, from another project or not what they claim', async () => {
      const ok = await upload(project.id, 'planta.pdf', PDF('model'))
      const forModel = await ownerApi.execute(addRevision, {
        deliverableId: modelDeliverableId,
        blobId: ok
      })
      expect(forModel).to.haveGraphQLErrors('aba Modelos')

      const foreign = await upload(other.id, 'alheia.pdf', PDF('foreign'))
      const fromOther = await ownerApi.execute(addRevision, {
        deliverableId: drawingId,
        blobId: foreign
      })
      expect(fromOther).to.haveGraphQLErrors('Arquivo não encontrado neste projeto')

      const fake = await upload(
        project.id,
        'falso.pdf',
        Buffer.from('<script>x</script>')
      )
      const disguised = await ownerApi.execute(addRevision, {
        deliverableId: drawingId,
        blobId: fake
      })
      expect(disguised).to.haveGraphQLErrors('diferente da extensão')
      expect(await blobExists(fake)).to.equal(false)
    })

    it('blocks users who cannot manage the project', async () => {
      const blobId = await upload(project.id, 'x.pdf', PDF('outsider'))
      const res = await outsiderApi.execute(addRevision, {
        deliverableId: drawingId,
        blobId
      })
      expect(res).to.haveGraphQLErrors()
    })

    it('registers a PDF as a WIP revision with its hash and moves the MIDP status', async () => {
      const blobId = await upload(project.id, 'planta-r1.pdf', PDF('r1'))
      const res = await authorApi.execute(addRevision, {
        deliverableId: drawingId,
        blobId
      })
      expect(res).to.not.haveGraphQLErrors()
      const revision = res.data!.coordinationMutations.addDocumentRevision
      firstRevisionId = revision.id
      expect(revision).to.deep.include({
        fileName: 'planta-r1.pdf',
        contentType: 'application/pdf',
        viewable: true,
        createdByName: 'docs author'
      })
      expect(revision.sha256).to.match(/^[0-9a-f]{64}$/)
      expect(revision.current).to.deep.include({
        stage: 'wip',
        action: 'created',
        kind: 'system',
        documentRevisionId: revision.id,
        versionId: null
      })
      expect((await deliverable()).status).to.equal('in_progress')

      const again = await upload(project.id, 'copia.pdf', PDF('r1'))
      const duplicate = await authorApi.execute(addRevision, {
        deliverableId: drawingId,
        blobId: again
      })
      expect(duplicate).to.haveGraphQLErrors('já foi enviado')
    })

    it('runs the CDE flow with P/C revisions, without the Model Check gate', async () => {
      const shared = await authorApi.execute(transition, {
        revisionId: firstRevisionId,
        input: { toStateCode: 'SHARED', suitability: 'S2' }
      })
      expect(shared).to.not.haveGraphQLErrors()
      expect(
        shared.data!.coordinationMutations.transitionDocumentRevision
      ).to.deep.include({
        stage: 'shared',
        suitability: 'S2',
        revision: 'P01',
        action: 'shared'
      })
      expect((await deliverable()).status).to.equal('in_review')

      // the author doesn't approve; the owner (only approver) does
      const byAuthor = await authorApi.execute(transition, {
        revisionId: firstRevisionId,
        input: { toStateCode: 'PUBLISHED', suitability: 'A1' }
      })
      expect(byAuthor).to.haveGraphQLErrors()

      const published = await ownerApi.execute(transition, {
        revisionId: firstRevisionId,
        input: { toStateCode: 'PUBLISHED', suitability: 'A1' }
      })
      expect(published).to.not.haveGraphQLErrors()
      expect(
        published.data!.coordinationMutations.transitionDocumentRevision
      ).to.deep.include({ revision: 'C01', kind: 'manual', action: 'published' })
      expect((await deliverable()).status).to.equal('published')
    })

    it('archives the previous publication and keeps shared revisions in the record', async () => {
      const blobId = await upload(project.id, 'planta-r2.pdf', PDF('r2'))
      const added = await authorApi.execute(addRevision, {
        deliverableId: drawingId,
        blobId
      })
      const secondId = added.data!.coordinationMutations.addDocumentRevision.id
      await authorApi.execute(transition, {
        revisionId: secondId,
        input: { toStateCode: 'SHARED', suitability: 'S3' }
      })
      const published = await ownerApi.execute(transition, {
        revisionId: secondId,
        input: { toStateCode: 'PUBLISHED', suitability: 'A2' }
      })
      expect(
        published.data!.coordinationMutations.transitionDocumentRevision.revision
      ).to.equal('C02')

      const revisions = (await deliverable()).documentRevisions
      expect(revisions.map((r: { id: string }) => r.id)).to.deep.equal([
        secondId,
        firstRevisionId
      ])
      expect(revisions[1].current).to.deep.include({
        stage: 'archived',
        kind: 'system'
      })

      const removeShared = await ownerApi.execute(deleteRevision, {
        revisionId: firstRevisionId
      })
      expect(removeShared).to.haveGraphQLErrors('nunca saiu do WIP')
    })

    it('protects revision files from the generic blob delete and removes WIP ones on request', async () => {
      const revisions = (await db('coord_document_revisions').where({
        deliverableId: drawingId
      })) as { id: string; blobId: string }[]
      const rest = await request(app)
        .delete(`/api/stream/${project.id}/blob/${revisions[0].blobId}`)
        .set('Authorization', `Bearer ${token}`)
      expect(rest.status).to.equal(409)

      const blobId = await upload(project.id, 'rascunho.pdf', PDF('wip'))
      const added = await authorApi.execute(addRevision, {
        deliverableId: drawingId,
        blobId
      })
      const wipId = added.data!.coordinationMutations.addDocumentRevision.id
      const removed = await authorApi.execute(deleteRevision, { revisionId: wipId })
      expect(removed).to.not.haveGraphQLErrors()
      expect(await blobExists(blobId)).to.equal(false)
      expect((await deliverable()).status).to.equal('published')
    })

    it('refuses a manual status once the document has CDE states, and cleans files with the deliverable', async () => {
      const manual = await ownerApi.execute(
        gql`
          mutation ($id: String!) {
            coordinationMutations {
              setDeliverableStatus(id: $id, status: "blocked") {
                id
              }
            }
          }
        `,
        { id: drawingId }
      )
      expect(manual).to.haveGraphQLErrors('revisões do documento')

      const blobIds = (
        (await db('coord_document_revisions').where({ deliverableId: drawingId })) as {
          blobId: string
        }[]
      ).map((r) => r.blobId)
      const deleted = await ownerApi.execute(
        gql`
          mutation ($id: String!) {
            coordinationMutations {
              deleteDeliverable(id: $id)
            }
          }
        `,
        { id: drawingId }
      )
      expect(deleted).to.not.haveGraphQLErrors()
      for (const blobId of blobIds) expect(await blobExists(blobId)).to.equal(false)
    })
  })
})
