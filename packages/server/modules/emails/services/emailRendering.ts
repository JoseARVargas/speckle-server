import type { UserRecord } from '@/modules/core/helpers/types'
import { packageRoot } from '@/bootstrap'
import path from 'path'
import mjml2html from 'mjml'
import * as ejs from 'ejs'
import sanitizeHtml from 'sanitize-html'
import { getEmailBrand } from '@/modules/shared/helpers/envHelper'
import type {
  EmailContent,
  EmailTemplateParams,
  EmailTemplateServerInfo
} from '@/modules/emails/domain/operations'

export const renderEmail = async (
  templateParams: EmailTemplateParams,
  serverInfo: EmailTemplateServerInfo,
  user: UserRecord | null = null
): Promise<EmailContent> => {
  const [html, text] = await Promise.all([
    renderEmailHtml(templateParams, serverInfo, user),
    renderEmailText(templateParams, serverInfo)
  ])
  return {
    text,
    html
  }
}

/** EJS delimiters in content become visible text (&lt;% / %&gt;), never tags. */
export const neutralizeEjs = <T extends string | undefined>(content: T): T =>
  (typeof content === 'string'
    ? content.replace(/<%/g, '&lt;%').replace(/%>/g, '%&gt;')
    : content) as T

const renderEmailHtml = async (
  templateParams: EmailTemplateParams,
  serverInfo: EmailTemplateServerInfo,
  user: UserRecord | null = null
): Promise<string> => {
  const mjmlPath = path.resolve(
    packageRoot,
    'assets/emails/templates/speckleBasicEmailTemplate.mjml.ejs'
  )
  const params = {
    cta: templateParams.cta,
    // i know, the parameter names need reshuffling
    // Fork security fix: the body is embedded in the first EJS pass and the
    // resulting HTML goes through a second ejs.render below, so an EJS tag in
    // user content (a user or project name) would be executed on the server.
    // Neutralize EJS openers in the body; the template's own tags are untouched.
    body: { mjml: neutralizeEjs(templateParams.mjml.bodyStart) },
    bodyEnd: { mjml: neutralizeEjs(templateParams.mjml.bodyEnd) },
    user,
    serverInfo,
    brand: getEmailBrand()
  }
  const fullMjml = await ejs.renderFile(
    mjmlPath,
    { params },
    { cache: false, outputFunctionName: 'print' }
  )
  const fullHtml = mjml2html(fullMjml, {
    filePath: mjmlPath,
    mjmlConfigPath: path.resolve(packageRoot, './assets/emails/config/.mjmlconfig')
  })
  const renderedHtml = ejs.render(fullHtml.html, { params })

  return renderedHtml
}

const renderEmailText = async (
  templateParams: EmailTemplateParams,
  serverInfo: EmailTemplateServerInfo
): Promise<string> => {
  const ejsPath = path.resolve(
    packageRoot,
    'assets/emails/templates/speckleBasicEmailTemplate.txt.ejs'
  )
  const params = {
    cta: templateParams.cta,
    text: {
      bodyStart: templateParams.text.bodyStart,
      bodyEnd: templateParams.text.bodyEnd
    },
    server: serverInfo,
    brand: getEmailBrand()
  }
  const fullText = await ejs.renderFile(
    ejsPath,
    { params },
    { cache: false, outputFunctionName: 'print' }
  )
  return fullText
}

/**
 * Sanitize message that potentially has HTML in it
 */
export function sanitizeMessage(message: string, stripAll: boolean = false): string {
  return sanitizeHtml(message, {
    allowedTags: stripAll ? [] : ['b', 'i', 'em', 'strong']
  })
}
