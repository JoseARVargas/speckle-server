import { expect } from 'chai'
import {
  DEFAULT_ASSET_NAMING_CONFIG,
  validateAssetNamingConfig
} from '@/modules/facilities/services/assetNaming'

const config = (overrides: Record<string, unknown>) => ({
  tagTemplate: '{tag}',
  nameTemplate: '{name}',
  ifcClassProperty: 'IfcType',
  propertyMappings: {},
  ...overrides
})

describe('Asset naming config @facilities', () => {
  it('defaults new facilities to a classification-based sequential tag', () => {
    expect(DEFAULT_ASSET_NAMING_CONFIG.tagTemplate).to.equal(
      '{groupCode}-{familyCode}-{typeCode}-{seq3}'
    )
    expect(validateAssetNamingConfig(DEFAULT_ASSET_NAMING_CONFIG)).to.deep.equal(
      DEFAULT_ASSET_NAMING_CONFIG
    )
  })

  it('accepts sequence tokens in the tag template', () => {
    for (const tagTemplate of ['{typeCode}-{seq}', 'AC-{seq3}']) {
      expect(validateAssetNamingConfig(config({ tagTemplate })).tagTemplate).to.equal(
        tagTemplate
      )
    }
  })

  it('rejects sequence tokens in the name template', () => {
    expect(() =>
      validateAssetNamingConfig(config({ nameTemplate: '{name} {seq}' }))
    ).to.throw('unknown or malformed tokens')
  })

  it('does not let a property mapping take over a sequence token', () => {
    expect(() =>
      validateAssetNamingConfig(config({ propertyMappings: { seq3: 'Pset.Number' } }))
    ).to.throw('valid tokens')
  })

  it('still rejects unknown tokens', () => {
    expect(() => validateAssetNamingConfig(config({ tagTemplate: '{seq4}' }))).to.throw(
      'unknown or malformed tokens'
    )
  })
})
