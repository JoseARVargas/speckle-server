import { expect } from 'chai'
import type { EmailTemplateServerInfo } from '@/modules/emails/domain/operations'
import { renderEmail } from '@/modules/emails/services/emailRendering'
import { buildCoreInviteEmailContentsFactory } from '@/modules/serverinvites/services/coreEmailContents'
import type { ServerInviteRecord } from '@/modules/serverinvites/domain/types'
import type { ServerInfo, StreamRecord } from '@/modules/core/helpers/types'

/**
 * Fork-only: per-server email branding (EMAIL_BRAND_*). Without the env vars
 * the upstream Speckle emails must stay exactly as they are.
 */

const BRAND_ENV = {
  EMAIL_BRAND_NAME: 'OFFICIO Coordenação BIM',
  EMAIL_BRAND_LOGO_URL: 'https://bim.officio.net.br/brand/officio-tecnologia-gray.png',
  EMAIL_BRAND_SITE_URL: 'https://bim.officio.net.br',
  EMAIL_BRAND_FOOTER_TEXT: 'OFFICIO Tecnologia'
}

const server: EmailTemplateServerInfo = {
  name: 'OFFICIO Coordenação BIM',
  canonicalUrl: 'https://speckle.officio.net.br',
  company: 'OFFICIO',
  adminContact: 'admin@officio.net.br'
}

const template = {
  mjml: { bodyStart: '<mj-text>corpo</mj-text>' },
  text: { bodyStart: 'corpo' },
  cta: { title: 'Aceitar', url: 'https://bim.officio.net.br/x' }
}

const inviteFor = (resourceType: 'server' | 'project', message?: string) =>
  ({
    id: 'inv1',
    target: 'convidado@exemplo.com',
    inviterId: 'u1',
    createdAt: new Date(),
    updatedAt: new Date(),
    message: message ?? null,
    token: 'tok123',
    resource: { resourceType, resourceId: 'p1', role: null, primary: true }
  } as unknown as ServerInviteRecord)

const buildInvite = buildCoreInviteEmailContentsFactory({
  getStream: async () => ({ id: 'p1', name: 'Teatro <b>Cidade</b>' } as StreamRecord)
})

const inviter = { id: 'u1', name: 'José <i>Vargas</i>' } as never
const serverInfo = { ...server } as unknown as ServerInfo

describe('Email branding (EMAIL_BRAND_*) @emails', () => {
  const setBrand = (on: boolean) => {
    for (const [key, value] of Object.entries(BRAND_ENV)) {
      if (on) process.env[key] = value
      else delete process.env[key]
    }
  }
  afterEach(() => setBrand(false))

  it('without brand env keeps the upstream Speckle header, footer and subjects', async () => {
    setBrand(false)
    const { html, text } = await renderEmail(template, server)
    expect(html).to.contain('speckle-email-logo.png')
    expect(html).to.contain('https://speckle.systems')
    expect(text).to.contain('deployed and managed by')

    const { subject } = await buildInvite({
      invite: inviteFor('server'),
      serverInfo,
      inviter
    })
    expect(subject).to.equal('Speckle Invitation from José <i>Vargas</i>')
  })

  it('with brand env renders the brand logo, pt-BR footer and no Speckle links', async () => {
    setBrand(true)
    const { html, text } = await renderEmail(template, server)
    expect(html).to.contain(BRAND_ENV.EMAIL_BRAND_LOGO_URL)
    expect(html).to.contain('Enviado por OFFICIO Coordenação BIM')
    expect(html).to.contain(BRAND_ENV.EMAIL_BRAND_FOOTER_TEXT)
    expect(html).to.not.contain('speckle.systems')
    expect(html).to.not.contain('speckle-email-logo.png')
    expect(text).to.contain('Enviado por OFFICIO Coordenação BIM')
    expect(text).to.not.contain('deployed and managed by')
  })

  it('falls back to a text header when the brand has no logo', async () => {
    setBrand(true)
    delete process.env.EMAIL_BRAND_LOGO_URL
    const { html } = await renderEmail(template, server)
    expect(html).to.contain('OFFICIO Coordenação BIM')
    expect(html).to.not.contain('speckle-email-logo.png')
  })

  it('brands server and project invites in pt-BR', async () => {
    setBrand(true)
    const serverInvite = await buildInvite({
      invite: inviteFor('server'),
      serverInfo,
      inviter
    })
    expect(serverInvite.subject).to.equal(
      'Convite para OFFICIO Coordenação BIM de José <i>Vargas</i>'
    )
    expect(serverInvite.emailParams.cta?.title).to.equal('Aceitar o convite')

    const projectInvite = await buildInvite({
      invite: inviteFor('project', 'Bem-vindo'),
      serverInfo,
      inviter
    })
    expect(projectInvite.subject).to.equal(
      'José <i>Vargas</i> compartilhou o projeto "Teatro <b>Cidade</b>" em OFFICIO Coordenação BIM'
    )
    expect(projectInvite.emailParams.cta?.url).to.contain('token=tok123')
  })

  it('never executes EJS from user content (upstream SSTI, fixed in emailRendering)', async () => {
    setBrand(false)
    const build = buildCoreInviteEmailContentsFactory({
      getStream: async () =>
        ({ id: 'p1', name: 'Proj <%= process.version %>' } as StreamRecord)
    })
    const { emailParams } = await build({
      invite: inviteFor('project'),
      serverInfo,
      inviter: { id: 'u1', name: 'Nome <%= 7*7 %>' } as never
    })
    const { html } = await renderEmail(emailParams, server)
    expect(html).to.not.contain('Nome 49')
    expect(html).to.not.contain(process.version)
    expect(html).to.contain('Nome &lt;%= 7*7 %&gt;')

    // any sender's body, not only invites
    const generic = await renderEmail(
      {
        mjml: { bodyStart: '<mj-text><%= 6*7 %></mj-text>' },
        text: { bodyStart: 'x' }
      },
      server
    )
    expect(generic.html).to.not.contain('42')
  })

  it('escapes user-controlled names and messages in the branded HTML body', async () => {
    setBrand(true)
    const { emailParams } = await buildInvite({
      invite: inviteFor('project', '<script>x</script> <%= 7*7 %>'),
      serverInfo,
      inviter
    })
    const { html } = await renderEmail(emailParams, server)
    expect(html).to.contain('José &lt;i&gt;Vargas&lt;/i&gt;')
    expect(html).to.contain('Teatro &lt;b&gt;Cidade&lt;/b&gt;')
    expect(html).to.not.contain('<script>')
    // the body goes through a second EJS render: an EJS tag in user input must stay inert
    expect(html).to.not.contain('49')
    expect(html).to.contain('&lt;%= 7*7 %&gt;')
  })
})
