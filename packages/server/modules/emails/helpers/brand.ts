import type { EmailBrand } from '@/modules/shared/helpers/envHelper'

/**
 * Fork-only: pt-BR copy for branded servers (EMAIL_BRAND_NAME set). Kept in
 * one place so each sender only swaps strings when a brand is configured and
 * the upstream (Speckle) wording stays untouched otherwise.
 *
 * Every user-controlled value (person and project names, invite messages)
 * is HTML-escaped before it goes into the MJML body.
 */

export const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const text = (body: string) =>
  `<mj-text align="center" line-height="2">${body}</mj-text>`

const ignoreNotice =
  'Se você não conhece quem enviou o convite, pode ignorar este e-mail.'

const quotedMessage = (inviterName: string, message: string | null | undefined) =>
  message ? `${inviterName} escreveu: "${message}"` : ''

export const brandEmailCopy = {
  acceptInvite: 'Aceitar o convite',

  serverInvite: (p: {
    brand: EmailBrand
    inviterName: string
    message?: string | null
  }) => {
    const inviter = escapeHtml(p.inviterName)
    const brand = escapeHtml(p.brand.name)
    const message = p.message ? escapeHtml(p.message) : null
    return {
      subject: `Convite para ${p.brand.name} de ${p.inviterName}`,
      mjml: {
        bodyStart: text(
          `Olá!<br /><br />${inviter} convidou você para entrar em <b>${brand}</b>.${
            message ? `<br /><br /><em>${quotedMessage(inviter, message)}</em>` : ''
          }`
        ),
        bodyEnd: text(ignoreNotice)
      },
      text: {
        bodyStart: `Olá!\n\n${p.inviterName} convidou você para entrar em ${
          p.brand.name
        }.\n\n${quotedMessage(p.inviterName, p.message)}`,
        bodyEnd: ignoreNotice
      }
    }
  },

  projectInvite: (p: {
    brand: EmailBrand
    inviterName: string
    projectName: string
    message?: string | null
  }) => {
    const inviter = escapeHtml(p.inviterName)
    const project = escapeHtml(p.projectName)
    const message = p.message ? escapeHtml(p.message) : null
    return {
      subject: `${p.inviterName} compartilhou o projeto "${p.projectName}" em ${p.brand.name}`,
      mjml: {
        bodyStart: text(
          `Olá!<br /><br />${inviter} convidou você para colaborar no projeto <b>${project}</b> em ${escapeHtml(
            p.brand.name
          )}.${
            message ? `<br /><br /><em>${quotedMessage(inviter, message)}</em>` : ''
          }`
        ),
        bodyEnd: text(ignoreNotice)
      },
      text: {
        bodyStart: `Olá!\n\n${p.inviterName} convidou você para colaborar no projeto "${
          p.projectName
        }" em ${p.brand.name}.\n\n${quotedMessage(p.inviterName, p.message)}`,
        bodyEnd: ignoreNotice
      }
    }
  },

  emailVerification: (p: {
    brand: EmailBrand
    code: string
    timeoutMinutes: number
  }) => ({
    subject: `Verificação de e-mail – ${p.brand.name}`,
    mjml: {
      bodyStart: `<mj-text align="center" line-height="2" padding-top="0" padding-bottom="5px">Você criou uma conta em ${escapeHtml(
        p.brand.name
      )} ou pediu para verificar seu e-mail. Para concluir, use o código abaixo.</mj-text>
  <mj-text align="center" font-size="32px" font-weight="bold" padding-bottom="5px" line-height="2">${escapeHtml(
    p.code
  )}</mj-text>
  <mj-text align="center" line-height="2">O código vale por ${
    p.timeoutMinutes
  } minutos. Não compartilhe este código com ninguém.</mj-text>
  <mj-text align="center" line-height="2">Se você não fez este pedido, ignore este e-mail.</mj-text>`
    }
  }),

  passwordReset: (p: { brand: EmailBrand }) => ({
    subject: `Redefinição de senha – ${p.brand.name}`,
    cta: 'Redefinir a senha',
    mjml: {
      bodyStart: text(
        `Olá,<br /><br />Você pediu há pouco para redefinir a senha da sua conta em ${escapeHtml(
          p.brand.name
        )}. Use o botão abaixo para concluir:`
      ),
      bodyEnd: text(
        'O link vale por <strong>1 hora</strong>. Se você não pediu a redefinição, ignore este e-mail: nada vai mudar e sua conta continua segura.'
      )
    },
    text: {
      bodyStart: `Olá,\n\nVocê pediu há pouco para redefinir a senha da sua conta em ${p.brand.name}. Use o link abaixo para concluir:`,
      bodyEnd:
        'O link vale por 1 hora. Se você não pediu a redefinição, ignore este e-mail: nada vai mudar e sua conta continua segura.'
    }
  }),

  weeklyDigestSubject: (brand: EmailBrand) => `Resumo semanal – ${brand.name}`
}
