export {
  EMAIL_BRAND,
  EMAIL_LOCALES,
  escapeHtml,
  headerText,
  resolveEmailLocale,
  safeEmailUrl,
} from './brand';
export type { EmailLocale } from './brand';
export { renderEmailHtml, renderEmailText } from './layout';
export type {
  EmailCategory,
  EmailContent,
  EmailDetail,
  EmailItem,
  EmailRenderContext,
  RenderedEmail,
} from './layout';
export {
  EMAIL_TEMPLATE_IDS,
  EMAIL_TEMPLATES,
  emailTemplateCatalogue,
  isEmailTemplateId,
} from './catalog';
export type {
  EmailTemplateDefinition,
  EmailTemplateId,
  TemplateVariables,
} from './catalog';
export { EmailTemplateError, renderEmailTemplate } from './render';
export type { RenderEmailOptions } from './render';
export { createUnsubscribeToken, verifyUnsubscribeToken } from './unsubscribe-token';
