import { BadRequestError } from '@/modules/shared/errors'
import type { AssetNamingConfig } from '@/modules/facilities/helpers/types'

export const DEFAULT_ASSET_NAMING_CONFIG: AssetNamingConfig = {
  tagTemplate: '{tag}',
  nameTemplate: '{name}',
  ifcClassProperty: 'IfcType',
  propertyMappings: {}
}

export function validateAssetNamingConfig(value: unknown): AssetNamingConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestError('Naming configuration must be an object')
  }
  const input = value as Record<string, unknown>
  const tagTemplate = input.tagTemplate
  const nameTemplate = input.nameTemplate
  const ifcClassProperty = input.ifcClassProperty
  const propertyMappings = input.propertyMappings
  if (
    typeof tagTemplate !== 'string' ||
    tagTemplate.length > 250 ||
    typeof nameTemplate !== 'string' ||
    nameTemplate.length > 250 ||
    typeof ifcClassProperty !== 'string' ||
    ifcClassProperty.length > 120 ||
    !propertyMappings ||
    typeof propertyMappings !== 'object' ||
    Array.isArray(propertyMappings)
  ) {
    throw new BadRequestError('Naming configuration contains invalid fields')
  }
  const entries = Object.entries(propertyMappings as Record<string, unknown>)
  if (entries.length > 20)
    throw new BadRequestError('At most 20 property mappings are allowed')
  const reservedTokens = new Set(['tag', 'name', 'groupCode', 'familyCode', 'typeCode'])
  const normalizedMappings: Record<string, string> = {}
  for (const [token, property] of entries) {
    if (
      !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(token) ||
      reservedTokens.has(token) ||
      typeof property !== 'string' ||
      !property.trim() ||
      property.length > 120
    ) {
      throw new BadRequestError(
        'Property mappings must use valid tokens and property names'
      )
    }
    normalizedMappings[token] = property.trim()
  }
  const allowedTokens = new Set([
    'tag',
    'name',
    'groupCode',
    'familyCode',
    'typeCode',
    ...Object.keys(normalizedMappings)
  ])
  const templates = [tagTemplate, nameTemplate]
  for (const template of templates) {
    const tokens = template.match(/\{([^{}]+)\}/g) ?? []
    if (
      tokens.some((token) => !allowedTokens.has(token.slice(1, -1))) ||
      /[{}]/.test(template.replace(/\{[^{}]+\}/g, ''))
    ) {
      throw new BadRequestError('Templates contain unknown or malformed tokens')
    }
  }
  return {
    tagTemplate,
    nameTemplate,
    ifcClassProperty: ifcClassProperty.trim(),
    propertyMappings: normalizedMappings
  }
}

export function validateIfcClasses(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 20 ||
    value.some((item) => typeof item !== 'string')
  ) {
    throw new BadRequestError('IFC classes must be a list of at most 20 names')
  }
  const classes = [
    ...new Set((value as string[]).map((item) => item.trim()).filter(Boolean))
  ]
  if (classes.some((item) => item.length > 80))
    throw new BadRequestError('IFC class names must not exceed 80 characters')
  return classes
}
