Storage = require('./storage')
Promise = require('bluebird')

###*
# State storage backed by chrome.storage (service-worker safe).
# Keys are stored with a string prefix to avoid clashing with options data
# when both live in chrome.storage.local.
#
# Constructor remains compatible with the old localStorage form:
#   new BrowserStorage(localStorage, 'omega.local.')
# and supports the MV3 form:
#   new BrowserStorage('omega.local.')
#   new BrowserStorage('omega.local.', 'local')
###
class BrowserStorage extends Storage
  constructor: (storageOrPrefix, prefixOrArea) ->
    if typeof storageOrPrefix == 'string'
      # MV3: new BrowserStorage('omega.local.') or (prefix, areaName)
      @prefix = storageOrPrefix
      @areaName = prefixOrArea or 'local'
      @_legacy = null
    else
      # Legacy: (localStorage-like, prefix)
      @_legacy = storageOrPrefix
      @prefix = prefixOrArea or 'omega.local.'
      @areaName = 'local'
      @proto = if @_legacy then Object.getPrototypeOf(@_legacy) else null

  _chromeArea: ->
    chrome?.storage?[@areaName]

  _isLegacy: ->
    !!(@_legacy and @proto?.getItem and not @_chromeArea())

  get: (keys) ->
    if @_isLegacy()
      return @_legacyGet(keys)
    area = @_chromeArea()
    if not area?
      return Promise.resolve({})

    new Promise (resolve, reject) =>
      if not keys?
        area.get null, (items) =>
          if chrome.runtime?.lastError?
            return reject(new Error(chrome.runtime.lastError.message))
          map = {}
          for own fullKey, value of (items or {})
            if fullKey.substr(0, @prefix.length) == @prefix
              map[fullKey.substr(@prefix.length)] = value
          resolve(map)
        return

      map = {}
      keyList = []
      if typeof keys == 'string'
        keyList = [keys]
        map[keys] = undefined
      else if Array.isArray(keys)
        keyList = keys
        for key in keys
          map[key] = undefined
      else if typeof keys == 'object'
        map = keys
        keyList = (key for own key of keys)

      chromeKeys = keyList.map (k) => @prefix + k
      area.get chromeKeys, (items) =>
        if chrome.runtime?.lastError?
          return reject(new Error(chrome.runtime.lastError.message))
        items ?= {}
        result = {}
        for key in keyList
          full = @prefix + key
          if Object::hasOwnProperty.call(items, full)
            result[key] = items[full]
          else if map[key] != undefined
            result[key] = map[key]
        resolve(result)

  set: (items) ->
    if @_isLegacy()
      return @_legacySet(items)
    area = @_chromeArea()
    if not area?
      return Promise.resolve(items)

    packed = {}
    for own key, value of items
      continue if typeof value == 'undefined'
      packed[@prefix + key] = value

    if Object.keys(packed).length == 0
      return Promise.resolve(items)

    new Promise (resolve, reject) ->
      area.set packed, ->
        if chrome.runtime?.lastError?
          return reject(new Error(chrome.runtime.lastError.message))
        resolve(items)

  remove: (keys) ->
    if @_isLegacy()
      return @_legacyRemove(keys)
    area = @_chromeArea()
    if not area?
      return Promise.resolve()

    new Promise (resolve, reject) =>
      done = ->
        if chrome.runtime?.lastError?
          return reject(new Error(chrome.runtime.lastError.message))
        resolve()

      if not keys?
        # Remove only our prefixed keys.
        area.get null, (items) =>
          if chrome.runtime?.lastError?
            return reject(new Error(chrome.runtime.lastError.message))
          toRemove = []
          for own fullKey of (items or {})
            if fullKey.substr(0, @prefix.length) == @prefix
              toRemove.push(fullKey)
          if toRemove.length == 0
            return resolve()
          area.remove toRemove, done
        return

      if typeof keys == 'string'
        area.remove @prefix + keys, done
      else
        area.remove (keys.map (k) => @prefix + k), done

  # --- legacy localStorage path (tests / old MV2 pages) ---

  _legacyGet: (keys) ->
    map = {}
    if typeof keys == 'string'
      map[keys] = undefined
    else if Array.isArray(keys)
      for key in keys
        map[key] = undefined
    else if typeof keys == 'object'
      map = keys
    for own key of map
      try
        value = JSON.parse(@proto.getItem.call(@_legacy, @prefix + key))
      map[key] = value if value?
      if typeof map[key] == 'undefined'
        delete map[key]
    Promise.resolve map

  _legacySet: (items) ->
    for own key, value of items
      value = JSON.stringify(value)
      @proto.setItem.call(@_legacy, @prefix + key, value)
    Promise.resolve items

  _legacyRemove: (keys) ->
    if not keys?
      if not @prefix
        @proto.clear.call(@_legacy)
      else
        index = 0
        while true
          key = @proto.key.call(@_legacy, index)
          break if key == null
          if key.substr(0, @prefix.length) == @prefix
            @proto.removeItem.call(@_legacy, key)
          else
            index++
    else if typeof keys == 'string'
      @proto.removeItem.call(@_legacy, @prefix + keys)
    else
      for key in keys
        @proto.removeItem.call(@_legacy, @prefix + key)
    Promise.resolve()

module.exports = BrowserStorage
