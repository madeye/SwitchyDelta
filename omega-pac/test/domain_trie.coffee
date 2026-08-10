chai = require 'chai'
should = chai.should()

describe 'DomainTrie', ->
  DomainTrie = require '../src/domain_trie'

  describe 'exact match', ->
    it 'should match exact hosts only', ->
      trie = new DomainTrie()
      trie.insert('example.com', 1)
      trie.search('example.com').should.equal(1)
      should.not.exist(trie.search('www.example.com'))
      should.not.exist(trie.search('foo.com'))

  describe 'star wildcard', ->
    it 'should match exactly one label', ->
      trie = new DomainTrie()
      trie.insert('*.example.com', 1)
      trie.search('www.example.com').should.equal(1)
      trie.search('foo.example.com').should.equal(1)
      should.not.exist(trie.search('example.com'))
      should.not.exist(trie.search('a.b.example.com'))

  describe 'dot wildcard', ->
    it 'should match one or more labels under the suffix', ->
      trie = new DomainTrie()
      trie.insert('.example.com', 1)
      should.not.exist(trie.search('example.com'))
      trie.search('www.example.com').should.equal(1)
      trie.search('a.b.example.com').should.equal(1)

  describe 'plus wildcard', ->
    it 'should match one or more labels under the suffix', ->
      trie = new DomainTrie()
      trie.insert('+.example.com', 1)
      trie.search('www.example.com').should.equal(1)
      trie.search('a.b.example.com').should.equal(1)
      should.not.exist(trie.search('example.com'))

  describe 'priority (search)', ->
    it 'should prefer exact over wildcards', ->
      trie = new DomainTrie()
      trie.insert('www.example.com', 1)
      trie.insert('*.example.com', 2)
      trie.insert('.example.com', 3)
      trie.search('www.example.com').should.equal(1)
      trie.search('foo.example.com').should.equal(2)
      trie.search('a.b.example.com').should.equal(3)

  describe 'searchMin', ->
    it 'should fold the minimum value across all matching patterns', ->
      trie = new DomainTrie()
      trie.insert('+.a.com', 1)
      trie.insert('+.b.a.com', 3)
      trie.insert('x.b.a.com', 7)
      # Most-specific prefers exact/deepest.
      trie.search('x.b.a.com').should.equal(7)
      # Min folds the earliest rule index among all matches.
      trie.searchMin('x.b.a.com').should.equal(1)
      trie.searchMin('y.b.a.com').should.equal(1)
      trie.searchMin('deep.y.b.a.com').should.equal(1)
      should.not.exist(trie.searchMin('unrelated.com'))

    it 'should see star, dot, and exact values', ->
      trie = new DomainTrie()
      trie.insert('exact.example.com', 9)
      trie.insert('*.example.com', 4)
      trie.insert('.example.com', 6)
      trie.searchMin('exact.example.com').should.equal(4)
      trie.searchMin('a.b.example.com').should.equal(6)
      should.not.exist(trie.searchMin('example.com'))

  describe 'first-insert-wins', ->
    it 'should keep the first value for the same pattern', ->
      trie = new DomainTrie()
      trie.insert('*.example.com', 1)
      trie.insert('*.example.com', 2)
      trie.search('foo.example.com').should.equal(1)

  describe 'case insensitivity', ->
    it 'should match regardless of case', ->
      trie = new DomainTrie()
      trie.insert('Example.COM', 1)
      trie.search('example.com').should.equal(1)
      trie.search('EXAMPLE.COM').should.equal(1)

  describe 'empty trie', ->
    it 'should match nothing', ->
      trie = new DomainTrie()
      trie.isEmpty().should.be.true
      should.not.exist(trie.search('anything.com'))
      should.not.exist(trie.searchMin('anything.com'))

describe 'DomainTrie integration with profiles', ->
  Profiles = require '../src/profiles'
  Conditions = require '../src/conditions'

  describe '_hostPatternToTrieKeys', ->
    keys = Profiles._hostPatternToTrieKeys

    it 'should map *.example.com to apex + subdomain keys', ->
      keys('*.example.com').should.eql(['example.com', '.example.com'])

    it 'should map .example.com like *.', ->
      keys('.example.com').should.eql(['example.com', '.example.com'])

    it 'should map **.example.com to subdomain-only key', ->
      keys('**.example.com').should.eql(['.example.com'])

    it 'should map exact domains', ->
      keys('example.com').should.eql(['example.com'])

    it 'should reject complex patterns', ->
      should.not.exist(keys('*.*example.com'))
      should.not.exist(keys('test?.com'))
      should.not.exist(keys('*'))

  describe '_buildRulesAnalysis', ->
    it 'should mark simple HostWildcard rules and build the trie', ->
      rules = [
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy'
      ,
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.test.org'}
        profileName: 'proxy'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      result.simpleHost[0].should.be.true
      result.simpleHost[1].should.be.true
      result.domainTrie.isEmpty().should.be.false
      result.domainTrie.searchMin('www.example.com').should.equal(0)
      result.domainTrie.searchMin('www.test.org').should.equal(1)
      result.hasNonHostRules.should.be.false

    it 'should detect non-host rules', ->
      rules = [
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy'
      ,
        condition: {conditionType: 'KeywordCondition', pattern: 'test'}
        profileName: 'proxy'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      result.simpleHost[0].should.be.true
      result.simpleHost[1].should.be.false
      result.hasNonHostRules.should.be.true

    it 'should keep complex host patterns on the linear path', ->
      rules = [
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.*example.com'}
        profileName: 'proxy'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      result.simpleHost[0].should.be.false
      result.hasNonHostRules.should.be.true

    it 'should not partially insert multi-pattern rules with a complex part', ->
      rules = [
        condition:
          conditionType: 'HostWildcardCondition'
          pattern: '*.example.com|*.*other.com'
        profileName: 'proxy'
      ,
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy2'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      result.simpleHost[0].should.be.false
      result.simpleHost[1].should.be.true
      # Rule 1 owns example.com; rule 0 must not have claimed it.
      result.domainTrie.searchMin('www.example.com').should.equal(1)

    it 'should handle multi-pattern simple conditions', ->
      rules = [
        condition:
          conditionType: 'HostWildcardCondition'
          pattern: '*.example.com|*.test.org'
        profileName: 'proxy'
      ]
      result = Profiles._buildRulesAnalysis(rules)
      result.simpleHost[0].should.be.true
      result.domainTrie.searchMin('a.example.com').should.equal(0)
      result.domainTrie.searchMin('b.test.org').should.equal(0)

    it 'should handle empty rules', ->
      result = Profiles._buildRulesAnalysis([])
      result.domainTrie.isEmpty().should.be.true
      result.rules.should.have.length(0)

  describe 'SwitchProfile with domain trie', ->
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

    it 'should match domains via the trie', ->
      profile = makeProfile([
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy1'
      ])
      result = Profiles.match(profile, makeRequest('http://www.example.com/'))
      result.profileName.should.equal('proxy1')
      result = Profiles.match(profile, makeRequest('http://example.com/'))
      result.profileName.should.equal('proxy1')

    it 'should honor **. subdomain-only patterns', ->
      profile = makeProfile([
        condition: {conditionType: 'HostWildcardCondition', pattern: '**.example.com'}
        profileName: 'proxy1'
      ])
      result = Profiles.match(profile, makeRequest('http://www.example.com/'))
      result.profileName.should.equal('proxy1')
      result = Profiles.match(profile, makeRequest('http://example.com/'))
      result[0].should.equal('+direct')

    it 'should skip non-matching hosts without linear host checks', ->
      profile = makeProfile([
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy1'
      ])
      result = Profiles.match(profile, makeRequest('http://other.net/'))
      result[0].should.equal('+direct')

    it 'should still match non-host rules when host misses the trie', ->
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

    it 'should let earlier non-host rules win over later host hits', ->
      profile = makeProfile([
        condition: {conditionType: 'KeywordCondition', pattern: 'special'}
        profileName: 'proxy-kw'
      ,
        condition: {conditionType: 'HostWildcardCondition', pattern: '*.example.com'}
        profileName: 'proxy-host'
      ])
      result = Profiles.match(profile,
        makeRequest('http://www.example.com/special'))
      result.profileName.should.equal('proxy-kw')

    it 'should handle complex patterns correctly via linear path', ->
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
