OmegaTarget = require('omega-target')
OmegaPac = OmegaTarget.OmegaPac
Promise = OmegaTarget.Promise

STORAGE_KEY = 'omegaProxyAuth'

# Module-level singleton so the SW can register the listener at startup
# and still share the same credential map with setProxyAuth().
_shared = null

module.exports = class ProxyAuth
  @shared: (log) ->
    _shared ?= new ProxyAuth(log)
    if log?
      _shared.log = log
    _shared

  constructor: (log) ->
    @_requests = {}
    @_proxies = {}
    @_fallbacks = []
    @_hydrated = false
    @_hydratePromise = null
    @log = log
    _shared = this

  listening: false

  ###*
  # Register onAuthRequired as early as possible (synchronously at SW start).
  # MV3 requires this: listeners attached only after async boot miss the
  # wake-up auth event. Uses asyncBlocking + durable credential storage.
  ###
  listen: ->
    return if @listening
    if not chrome.webRequest
      @log?.error('Proxy auth disabled! No webRequest permission.')
      return
    if not chrome.webRequest.onAuthRequired
      @log?.error('Proxy auth disabled! onAuthRequired not available.')
      return

    # Prefer asyncBlocking (MV3 + webRequestAuthProvider). Fall back to
    # blocking for older / Firefox paths.
    try
      chrome.webRequest.onAuthRequired.addListener(
        @authHandler.bind(this)
        {urls: ['<all_urls>']}
        ['asyncBlocking']
      )
    catch err
      @log?.error(
        'asyncBlocking onAuthRequired failed; trying blocking.', err)
      chrome.webRequest.onAuthRequired.addListener(
        @authHandler.bind(this)
        {urls: ['<all_urls>']}
        ['blocking']
      )

    chrome.webRequest.onCompleted.addListener(
      @_requestDone.bind(this)
      {urls: ['<all_urls>']}
    )
    chrome.webRequest.onErrorOccurred.addListener(
      @_requestDone.bind(this)
      {urls: ['<all_urls>']}
    )
    @listening = true
    # Warm credentials from last applyProfile (session and/or local).
    @_hydrate()
    return

  _payload: ->
    proxies: @_proxies
    fallbacks: @_fallbacks

  _applyPayload: (data) ->
    return false unless data?
    @_proxies = data.proxies or {}
    @_fallbacks = data.fallbacks or []
    true

  _persist: ->
    payload = {}
    payload[STORAGE_KEY] = @_payload()
    # Write both: session for fast SW restarts, local so credentials survive
    # full browser restarts before Options.init re-applies the profile.
    for areaName in ['session', 'local']
      area = chrome.storage?[areaName]
      continue unless area?.set
      try
        area.set payload, -> chrome.runtime?.lastError
      catch _
        # ignore
    return

  _getFromArea: (areaName) ->
    area = chrome.storage?[areaName]
    return Promise.resolve(null) unless area?.get
    new Promise (resolve) ->
      try
        area.get STORAGE_KEY, (items) ->
          if chrome.runtime?.lastError?
            return resolve(null)
          resolve(items?[STORAGE_KEY] ? null)
      catch _
        resolve(null)

  _hydrate: ->
    return Promise.resolve() if @_hydrated
    return @_hydratePromise if @_hydratePromise?

    @_hydratePromise = Promise.resolve(
      @_getFromArea('session')
    ).then((data) =>
      return data if data?
      @_getFromArea('local')
    ).then((data) =>
      @_applyPayload(data)
      @_hydrated = true
      @_hydratePromise = null
      # Mirror into session for subsequent SW wakes this browser session.
      if data? and chrome.storage?.session?.set
        payload = {}
        payload[STORAGE_KEY] = data
        try
          chrome.storage.session.set payload, -> chrome.runtime?.lastError
        catch _
          # ignore
      return
    ).catch(=>
      @_hydrated = true
      @_hydratePromise = null
    )
    @_hydratePromise

  _keyForProxy: (proxy) ->
    host = (proxy.host or '').toLowerCase()
    port = proxy.port
    "#{host}:#{port}"

  _keysForChallenger: (challenger) ->
    host = (challenger.host or '').toLowerCase()
    port = challenger.port
    keys = ["#{host}:#{port}"]
    # Strip IPv6 brackets if present (Chrome may include them).
    if host.length >= 2 and host[0] == '[' and host[host.length - 1] == ']'
      keys.push("#{host.substring(1, host.length - 1)}:#{port}")
    keys

  setProxies: (profiles) ->
    @_proxies = {}
    @_fallbacks = []
    for profile in profiles when profile.auth
      for scheme in OmegaPac.Profiles.schemes when profile[scheme.prop]
        auth = profile.auth?[scheme.prop]
        continue unless auth?.username?
        proxy = profile[scheme.prop]
        key = @_keyForProxy(proxy)
        list = @_proxies[key]
        if not list?
          @_proxies[key] = list = []
        list.push({
          config: proxy
          auth:
            username: auth.username
            password: auth.password ? ''
          name: profile.name + '.' + scheme.prop
        })

      fallback = profile.auth?['all']
      if fallback?.username?
        @_fallbacks.push({
          auth:
            username: fallback.username
            password: fallback.password ? ''
          name: profile.name + '.' + 'all'
        })

    @_hydrated = true
    @_persist()
    return

  _normalizeAuth: (auth) ->
    return null unless auth?
    # Accept both {username,password} and legacy shapes.
    username = auth.username ? auth.user
    return null unless username?
    {
      username: username
      password: auth.password ? auth.pass ? ''
    }

  _credentialsFor: (details) ->
    return {} unless details.isProxy
    req = @_requests[details.requestId]
    if not req?
      @_requests[details.requestId] = req = {authTries: 0}

    list = null
    key = null
    for k in @_keysForChallenger(details.challenger)
      if @_proxies[k]?
        list = @_proxies[k]
        key = k
        break
    key ?= @_keyForProxy(
      host: details.challenger.host
      port: details.challenger.port
    )
    list ?= @_proxies[key]

    listLen = if list? then list.length else 0
    if req.authTries < listLen
      proxy = list[req.authTries]
    else
      proxy = @_fallbacks[req.authTries - listLen]
    @log?.log('ProxyAuth', key, req.authTries, proxy?.name)

    return {} unless proxy?
    creds = @_normalizeAuth(proxy.auth)
    return {} unless creds?
    req.authTries++
    return authCredentials: creds

  ###*
  # @param {object} details
  # @param {function?} asyncCallback  present when extraInfo has asyncBlocking
  ###
  authHandler: (details, asyncCallback) ->
    respond = (result) ->
      if typeof asyncCallback == 'function'
        asyncCallback(result)
        return undefined
      return result

    unless details.isProxy
      return respond({})

    # Fast path: already restored or set by applyProfile.
    if @_hydrated
      return respond(@_credentialsFor(details))

    # SW just woke: load last credentials then respond (asyncBlocking).
    if typeof asyncCallback == 'function'
      @_hydrate().then(=>
        respond(@_credentialsFor(details))
      ).catch(=>
        respond({})
      )
      return undefined

    # Blocking mode without async: best-effort in-memory only.
    return respond(@_credentialsFor(details))

  _requestDone: (details) ->
    delete @_requests[details.requestId]
