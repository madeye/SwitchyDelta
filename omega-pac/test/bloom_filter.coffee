chai = require 'chai'
should = chai.should()

describe 'BloomFilter', ->
  BloomFilter = require '../src/bloom_filter'

  describe 'constructor', ->
    it 'should create a filter with correct parameters', ->
      bf = new BloomFilter(100)
      bf.count().should.equal(0)
      bf.bitSize().should.be.above(0)
      bf.hashCount().should.be.above(0)

    it 'should handle expectedItems of 1', ->
      bf = new BloomFilter(1)
      bf.bitSize().should.be.at.least(64)

  describe '#add and #test', ->
    it 'should find items that were added', ->
      bf = new BloomFilter(100)
      bf.add('example.com')
      bf.add('test.org')
      bf.add('foo.bar.baz')
      bf.test('example.com').should.be.true
      bf.test('test.org').should.be.true
      bf.test('foo.bar.baz').should.be.true
      bf.count().should.equal(3)

    it 'should not find items that were never added', ->
      bf = new BloomFilter(100)
      bf.add('example.com')
      bf.test('example.net').should.be.false
      bf.test('notadded.com').should.be.false
      bf.test('').should.be.false

    it 'should work with empty strings', ->
      bf = new BloomFilter(10)
      bf.add('')
      bf.test('').should.be.true

    it 'should work with unicode strings', ->
      bf = new BloomFilter(10)
      bf.add('例え.jp')
      bf.test('例え.jp').should.be.true
      bf.test('other.jp').should.be.false

  describe 'false positive rate', ->
    it 'should maintain FPR below 0.1% for 1000 items', ->
      n = 1000
      bf = new BloomFilter(n, 0.001)

      for i in [0...n]
        bf.add("inserted-domain-#{i}.example.com")

      falsePositives = 0
      testCount = 100000
      for i in [0...testCount]
        if bf.test("never-added-unique-domain-#{i}.test.net")
          falsePositives++

      rate = falsePositives / testCount
      rate.should.be.below(0.003)

    it 'should maintain FPR below 0.1% for 5000 items', ->
      n = 5000
      bf = new BloomFilter(n, 0.001)

      for i in [0...n]
        bf.add("rule-#{i}.proxy.example.com")

      falsePositives = 0
      testCount = 50000
      for i in [0...testCount]
        if bf.test("absent-#{i}.different.org")
          falsePositives++

      rate = falsePositives / testCount
      rate.should.be.below(0.003)

  describe 'zero false negatives', ->
    it 'should never miss an added item', ->
      n = 5000
      bf = new BloomFilter(n, 0.001)
      items = ("domain-#{i}.example.com" for i in [0...n])

      for item in items
        bf.add(item)

      for item in items
        bf.test(item).should.be.true

describe 'BloomFilter integration with profiles', ->
  Profiles = require '../src/profiles'
  Conditions = require '../src/conditions'

  describe '_extractDomainForBloom', ->
    extract = Profiles._extractDomainForBloom

    it 'should extract domain from *.example.com', ->
      extract('*.example.com').should.equal('example.com')

    it 'should extract domain from **.example.com', ->
      extract('**.example.com').should.equal('example.com')

    it 'should extract domain from .example.com', ->
      extract('.example.com').should.equal('example.com')

    it 'should extract exact domain', ->
      extract('example.com').should.equal('example.com')

    it 'should return null for complex patterns', ->
      should.not.exist(extract('*.*example.com'))
      should.not.exist(extract('test?.com'))
      should.not.exist(extract('*'))

  describe '_testDomainInBloom', ->
    BloomFilter = require '../src/bloom_filter'

    it 'should match exact domain', ->
      bf = new BloomFilter(10)
      bf.add('example.com')
      Profiles._testDomainInBloom('example.com', bf).should.be.true

    it 'should match via suffix', ->
      bf = new BloomFilter(10)
      bf.add('example.com')
      Profiles._testDomainInBloom('www.example.com', bf).should.be.true
      Profiles._testDomainInBloom('a.b.example.com', bf).should.be.true

    it 'should not match unrelated domains', ->
      bf = new BloomFilter(10)
      bf.add('example.com')
      Profiles._testDomainInBloom('example.net', bf).should.be.false
      Profiles._testDomainInBloom('notexample.com', bf).should.be.false

  describe '_buildRulesAnalysis', ->
    it 'should build bloom filter from HostWildcardCondition rules', ->
      rules = [
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy'
      ,
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.test.org'}
        profileName: 'proxy'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      should.exist(result.bloomFilter)
      result.bloomFilter.count().should.equal(2)
      result.hasNonHostRules.should.be.false
      result.hasComplexPatterns.should.be.false

    it 'should detect non-host rules', ->
      rules = [
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy'
      ,
        condition: {conditionType: 'KeywordCondition', pattern: 'test'}
        profileName: 'proxy'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      result.hasNonHostRules.should.be.true

    it 'should detect complex patterns', ->
      rules = [
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.*example.com'}
        profileName: 'proxy'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      result.hasComplexPatterns.should.be.true

    it 'should handle multi-pattern conditions', ->
      rules = [
        condition:
          conditionType: 'HostWildcardCondition'
          pattern: '*.example.com|*.test.org'
        profileName: 'proxy'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      result.bloomFilter.count().should.equal(2)

    it 'should handle empty rules', ->
      result = Profiles._buildRulesAnalysis([])
      should.not.exist(result.bloomFilter)
      result.rules.should.have.length(0)

  describe 'SwitchProfile with bloom filter', ->
    makeProfile = (rules, defaultProfile = 'direct') ->
      profile = Profiles.create({
        name: 'test'
        profileType: 'SwitchProfile'
        defaultProfileName: defaultProfile
        rules: rules
      })
      profile.revision = 'test-rev-' + Math.random()
      profile

    makeRequest = (url) ->
      Conditions.requestFromUrl(url)

    it 'should match domains in the bloom filter', ->
      profile = makeProfile([
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy1'
      ])
      result = Profiles.match(profile, makeRequest('http://www.example.com/'))
      result.profileName.should.equal('proxy1')

    it 'should skip non-matching domains via bloom filter', ->
      profile = makeProfile([
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy1'
      ])
      result = Profiles.match(profile, makeRequest('http://other.net/'))
      result[0].should.equal('+direct')

    it 'should still match non-host rules when bloom filter rejects host', ->
      profile = makeProfile([
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy1'
      ,
        condition: {conditionType: 'KeywordCondition', pattern: 'keyword'}
        profileName: 'proxy2'
      ])
      result = Profiles.match(profile,
        makeRequest('http://other.net/path?keyword'))
      result.profileName.should.equal('proxy2')

    it 'should preserve rule priority order', ->
      profile = makeProfile([
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy1'
      ,
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy2'
      ])
      result = Profiles.match(profile, makeRequest('http://www.example.com/'))
      result.profileName.should.equal('proxy1')

    it 'should handle complex patterns correctly', ->
      profile = makeProfile([
        condition:
          conditionType: 'HostWildcardCondition'
          pattern: '*.*example.com'
        profileName: 'proxy1'
      ])
      result = Profiles.match(profile,
        makeRequest('http://www.some-example.com/'))
      result.profileName.should.equal('proxy1')

    it 'should handle large rule sets', ->
      rules = for i in [0...1000]
        condition:
          conditionType: 'HostWildcardCondition'
          pattern: "*.domain#{i}.com"
        profileName: 'proxy'

      profile = makeProfile(rules)

      result = Profiles.match(profile,
        makeRequest('http://www.domain500.com/'))
      result.profileName.should.equal('proxy')

      result = Profiles.match(profile,
        makeRequest('http://www.nomatch.org/'))
      result[0].should.equal('+direct')
