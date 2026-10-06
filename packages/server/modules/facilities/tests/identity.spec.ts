import { db } from '@/db/knex'
import {
  generateAssetIdentityCodeFactory,
  luhnCheckDigit
} from '@/modules/facilities/services/identity'
import { beforeEachContext } from '@/test/hooks'
import { expect } from 'chai'

describe('Asset identity code @facilities', () => {
  before(async () => {
    await beforeEachContext()
  })

  it('computes the standard Luhn check digit', () => {
    expect(luhnCheckDigit('7992739871')).to.equal(3)
  })

  it('generates NXT-NNNNNN-C codes with a valid check digit', async () => {
    const code = await generateAssetIdentityCodeFactory({ db })()
    const match = /^NXT-(\d{6})-(\d)$/.exec(code)
    expect(match, code).to.not.equal(null)
    expect(Number(match![2])).to.equal(luhnCheckDigit(match![1]))
  })
})
