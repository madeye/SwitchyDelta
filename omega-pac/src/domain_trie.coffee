# Domain label trie for host wildcard matching.
# Ported from meow-rs `meow-trie::DomainTrie` (reverse-label prefix tree).
#
# Pattern forms on insert:
#   example.com   exact host
#   *.example.com one label under example.com
#   .example.com  one or more labels under example.com
#   +.example.com one or more labels (star + dot), not the apex
#
# Labels are matched from the TLD leftward (rsplit). Values support
# first-insert-wins; searchMin folds the minimum Ord value among all
# matching patterns (for first-match-wins rule engines).

class DomainTrie
  constructor: ->
    @_root = @_newNode()
    @_len = 0

  _newNode: ->
    children: Object.create(null)
    exact: undefined
    star: undefined
    dot: undefined

  isEmpty: -> @_len == 0
  size: -> @_len

  # @param {string} domain pattern (exact / *. / . / +.)
  # @param {*} data value stored at the leaf (e.g. rule index)
  # @return {boolean} whether the pattern was accepted
  insert: (domain, data) ->
    domain = (domain ? '').trim().toLowerCase()
    return false if domain.length == 0

    if domain.indexOf('+.') == 0
      rest = domain.substring(2)
      return false if rest.length == 0
      @_insertIntoTree(rest, data, 'star')
      @_insertIntoTree(rest, data, 'dot')
      @_len += 2
      return true

    if domain.indexOf('*.') == 0
      rest = domain.substring(2)
      return false if rest.length == 0
      @_insertIntoTree(rest, data, 'star')
      @_len += 1
      return true

    if domain.charCodeAt(0) == 46 # '.'
      rest = domain.substring(1)
      return false if rest.length == 0
      @_insertIntoTree(rest, data, 'dot')
      @_len += 1
      return true

    @_insertIntoTree(domain, data, 'exact')
    @_len += 1
    true

  _insertIntoTree: (baseDomain, value, kind) ->
    node = @_root
    labels = baseDomain.split('.')
    # Walk TLD → subdomain (rsplit).
    for i in [labels.length - 1..0] by -1
      label = labels[i]
      continue if label.length == 0
      node = (node.children[label] ?= @_newNode())
    switch kind
      when 'exact'
        node.exact ?= value
      when 'star'
        node.star ?= value
      when 'dot'
        node.dot ?= value
    return

  # Most-specific match (exact > star > deeper dot), not first-rule.
  search: (domain) ->
    return undefined if @_len == 0
    query = @_normalizeQuery(domain)
    return undefined unless query?
    @_searchBest(query)

  # Minimum value among every matching pattern. For rule indices this is the
  # earliest matching rule (first-match-wins).
  searchMin: (domain) ->
    return undefined if @_len == 0
    query = @_normalizeQuery(domain)
    return undefined unless query?
    @_searchMin(query)

  _normalizeQuery: (domain) ->
    query = (domain ? '').trim()
    return null if query.length == 0
    # Strip trailing dots.
    while query.length > 0 and query.charCodeAt(query.length - 1) == 46
      query = query.substring(0, query.length - 1)
    return null if query.length == 0
    query.toLowerCase()

  _searchBest: (query) ->
    labels = query.split('.')
    n = labels.length
    node = @_root
    best = undefined

    for d in [0...n]
      label = labels[n - 1 - d]
      child = node.children[label]
      break unless child?
      node = child
      remaining = n - d - 1
      if remaining == 0
        return node.exact if node.exact isnt undefined
      else if remaining == 1
        if node.star isnt undefined
          best = node.star
        else if node.dot isnt undefined
          best = node.dot
      else if node.dot isnt undefined
        best = node.dot
    best

  _searchMin: (query) ->
    labels = query.split('.')
    n = labels.length
    node = @_root
    best = undefined

    for d in [0...n]
      label = labels[n - 1 - d]
      child = node.children[label]
      break unless child?
      node = child
      remaining = n - d - 1
      if remaining == 0
        best = @_foldMin(best, node.exact)
      else
        if remaining == 1
          best = @_foldMin(best, node.star)
        best = @_foldMin(best, node.dot)
    best

  _foldMin: (best, candidate) ->
    return best if candidate is undefined
    return candidate if best is undefined
    if best <= candidate then best else candidate

module.exports = DomainTrie
