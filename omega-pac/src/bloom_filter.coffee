_imul = Math.imul ? (a, b) ->
  ah = (a >>> 16) & 0xffff
  al = a & 0xffff
  bh = (b >>> 16) & 0xffff
  bl = b & 0xffff
  (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0

_murmur3 = (key, seed) ->
  h = seed | 0
  for i in [0...key.length]
    k = key.charCodeAt(i)
    k = _imul(k, 0xcc9e2d51)
    k = (k << 15) | (k >>> 17)
    k = _imul(k, 0x1b873593)
    h ^= k
    h = (h << 13) | (h >>> 19)
    h = (_imul(h, 5) + 0xe6546b64) | 0
  h ^= key.length
  h ^= h >>> 16
  h = _imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = _imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  h >>> 0

class BloomFilter
  constructor: (expectedItems, falsePositiveRate = 0.001) ->
    expectedItems = Math.max(expectedItems, 1)
    ln2 = Math.LN2
    @_m = Math.ceil(-expectedItems * Math.log(falsePositiveRate) / (ln2 * ln2))
    @_m = Math.max(@_m, 64)
    @_k = Math.max(1, Math.round((@_m / expectedItems) * ln2))
    @_bits = new Uint8Array(Math.ceil(@_m / 8))
    @_count = 0

  add: (key) ->
    h1 = _murmur3(key, 0)
    h2 = _murmur3(key, 0x9e3779b9)
    h2 = h2 | 1
    for i in [0...@_k]
      pos = ((h1 + _imul(i, h2)) >>> 0) % @_m
      @_bits[pos >>> 3] |= (1 << (pos & 7))
    @_count++
    return

  test: (key) ->
    h1 = _murmur3(key, 0)
    h2 = _murmur3(key, 0x9e3779b9)
    h2 = h2 | 1
    for i in [0...@_k]
      pos = ((h1 + _imul(i, h2)) >>> 0) % @_m
      return false unless @_bits[pos >>> 3] & (1 << (pos & 7))
    true

  count: -> @_count
  bitSize: -> @_m
  hashCount: -> @_k

module.exports = BloomFilter
