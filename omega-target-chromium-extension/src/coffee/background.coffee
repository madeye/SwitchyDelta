###
  Minimal background (MV3 service worker, Option B).

  - Apply / re-apply proxy profiles (manual + auto PAC)
  - RPC for popup & options pages
  - Proxy authentication
  - Alarms for remote rule-list updates

  Intentionally omitted: connection monitor, dynamic icons, context menus,
  keep-alive, localStorage polyfill.
###

OmegaTargetCurrent = Object.create(OmegaTargetChromium)
Promise = OmegaTargetCurrent.Promise
Promise.longStackTraces()

OmegaTargetCurrent.Log = Object.create(OmegaTargetCurrent.Log)
Log = OmegaTargetCurrent.Log

Log.log = (args...) ->
  console.log(args...)
Log.error = (args...) ->
  console.error(args...)

# CRITICAL (MV3): register onAuthRequired synchronously during script load.
# Listeners attached only inside async boot() miss the wake-up auth event.
# Credentials are restored from chrome.storage.session via asyncBlocking.
try
  OmegaTargetCurrent.proxy.ProxyAuth.shared(Log).listen()
catch authListenErr
  Log.error('Failed to register proxy auth listener', authListenErr)

unhandledPromises = []
unhandledPromisesId = []
unhandledPromisesNextId = 1
Promise.onPossiblyUnhandledRejection (reason, promise) ->
  Log.error("[#{unhandledPromisesNextId}] Unhandled rejection:\n", reason)
  unhandledPromises.push(promise)
  unhandledPromisesId.push(unhandledPromisesNextId)
  unhandledPromisesNextId++
Promise.onUnhandledRejectionHandled (promise) ->
  index = unhandledPromises.indexOf(promise)
  Log.log("[#{unhandledPromisesId[index]}] Rejection handled!", promise)
  unhandledPromises.splice(index, 1)
  unhandledPromisesId.splice(index, 1)

dispName = (name) -> chrome.i18n.getMessage('profile_' + name) || name

encodeError = (obj) ->
  if obj instanceof Error
    {
      _error: 'error'
      name: obj.name
      message: obj.message
      stack: obj.stack
      original: obj
    }
  else
    obj

# Filled once async init completes.
options = null
state = null

boot = ->
  # State lives in chrome.storage.local under this prefix (SW-safe).
  storage = new OmegaTargetCurrent.Storage('local')
  state = new OmegaTargetCurrent.BrowserStorage('omega.local.')

  sync = null
  if chrome?.storage?.sync or browser?.storage?.sync
    syncStorage = new OmegaTargetCurrent.Storage('sync')
    sync = new OmegaTargetCurrent.OptionsSync(syncStorage)
    sync.transformValue = OmegaTargetCurrent.Options.transformValueForSync

  # Resolve whether sync is enabled *before* Options.init runs.
  Promise.resolve(
    if sync?
      state.get({'syncOptions': ''}).then ({syncOptions}) ->
        if syncOptions != 'sync'
          sync.enabled = false
    else
      null
  ).then ->
    proxyImpl = OmegaTargetCurrent.proxy.getProxyImpl(Log)
    state.set({proxyImplFeatures: proxyImpl.features})

    options = new OmegaTargetCurrent.Options(null, storage, state, Log, sync,
      proxyImpl)

    options.externalApi = new OmegaTargetCurrent.ExternalApi(options)
    options.externalApi.listen()

    if chrome.runtime.id != OmegaTargetCurrent.SwitchySharp.extId
      options.switchySharp = new OmegaTargetCurrent.SwitchySharp()
      options.switchySharp.monitor()

    options.setProxyNotControllable(null)
    timeout = null

    proxyImpl.watchProxyChange (details) ->
      return if options.externalApi.disabled
      return unless details
      notControllableBefore = options.proxyNotControllable()
      internal = false
      noRevert = false
      switch details['levelOfControl']
        when "controlled_by_other_extensions", "not_controllable"
          reason =
            if details['levelOfControl'] == 'not_controllable'
              'policy'
            else
              'app'
          options.setProxyNotControllable(reason)
          noRevert = true
        else
          options.setProxyNotControllable(null)

      if details['levelOfControl'] == 'controlled_by_this_extension'
        internal = true
        return if not notControllableBefore
      Log.log('external proxy: ', details)

      clearTimeout(timeout) if timeout?
      parsed = null
      timeout = setTimeout (->
        if parsed
          options.setExternalProfile(parsed,
            {noRevert: noRevert, internal: internal})
      ), 500

      parsed = proxyImpl.parseExternalProfile(details, options._options)
      return

    external = false
    options.currentProfileChanged = (reason) ->
      if reason == 'external'
        external = true
      else if reason != 'clearBadge'
        external = false

      current = options.currentProfile()
      currentName = ''
      if current
        currentName = dispName(current.name)
        if current.profileType == 'VirtualProfile'
          realCurrentName = current.defaultProfileName
          currentName += " [#{dispName(realCurrentName)}]"
          current = options.profile(realCurrentName)

      detailsText = options.printProfile(current)
      if currentName
        title = chrome.i18n.getMessage('browserAction_titleWithResult', [
          currentName, '', detailsText])
      else
        title = detailsText

      if external and current.profileType != 'SystemProfile'
        message = chrome.i18n.getMessage('browserAction_titleExternalProxy')
        title = message + '\n' + title
        options.setBadge()

      # Static toolbar title only (no per-tab icon drawing).
      try
        chrome.action.setTitle({title: title})
      catch _
        # ignore

    options.ready

refreshActivePageIfEnabled = ->
  return unless state?
  state.get({'refreshOnProfileChange': true}).then (st) ->
    return if st['refreshOnProfileChange'] == false
    chrome.tabs.query {active: true, lastFocusedWindow: true}, (tabs) ->
      return unless tabs[0]
      url = tabs[0].url
      return if not url
      return if url.substr(0, 6) == 'chrome'
      return if url.substr(0, 6) == 'about:'
      return if url.substr(0, 4) == 'moz-'
      chrome.tabs.reload(tabs[0].id, {bypassCache: true})

ready = boot()

chrome.runtime.onMessage.addListener (request, sender, respond) ->
  return unless request and request.method
  ready.then ->
    if request.method == 'getState'
      target = state
      method = state.get
    else if request.method == 'setState'
      target = state
      method = state.set
    else
      target = options
      method = target[request.method]
    if typeof method != 'function'
      Log.error("No such method #{request.method}!")
      respond(
        error:
          reason: 'noSuchMethod'
      )
      return

    promise = Promise.resolve().then -> method.apply(target, request.args)
    if request.refreshActivePage
      promise.then refreshActivePageIfEnabled
    return if request.noReply

    promise.then (result) ->
      if request.method == 'updateProfile'
        for own key, value of result
          result[key] = encodeError(value)
      respond(result: result)

    promise.catch (error) ->
      Log.error(request.method + ' ==>', error)
      respond(error: encodeError(error))

  # Wait for my response!
  return true unless request.noReply

# Re-apply profile when the browser starts (SW may have been stopped).
# Options.init already applies the current profile on every SW wake that
# constructs Options; onStartup covers cold browser start as an extra assert.
chrome.runtime.onStartup?.addListener ->
  ready.then ->
    name = options.currentProfile()?.name
    options.applyProfile(name) if name
