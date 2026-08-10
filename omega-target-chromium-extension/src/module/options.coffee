OmegaTarget = require('omega-target')
OmegaPac = OmegaTarget.OmegaPac
Promise = OmegaTarget.Promise
querystring = require('querystring')
ChromePort = require('./chrome_port')
fetchUrl = require('./fetch_url')
Url = require('url')

class ChromeOptions extends OmegaTarget.Options
  fetchUrl: fetchUrl
  _pacFullScriptUrl: 'js/omega_pac_full.min.js'

  # Match-only SW bundle has no PacGenerator; load full compiler on demand.
  _pacWithCompiler: ->
    g = globalThis
    return g.OmegaPacFull if g.OmegaPacFull?.PacGenerator?
    return OmegaPac if OmegaPac.PacGenerator?
    return g.OmegaPac if g.OmegaPac?.PacGenerator?
    if typeof importScripts == 'function'
      importScripts(@_pacFullScriptUrl)
      return g.OmegaPacFull if g.OmegaPacFull?.PacGenerator?
      return g.OmegaPac if g.OmegaPac?.PacGenerator?
    throw new Error(
      'PAC compiler unavailable (omega_pac_full.min.js not loaded)')

  updateProfile: (args...) ->
    super(args...).then (results) ->
      error = false
      for own profileName, result of results
        if result instanceof Error
          error = true
          break
      if error
        # Keep silent; options UI shows per-profile errors.
        true
      return results

  _proxyNotControllable: null
  proxyNotControllable: -> @_proxyNotControllable
  setProxyNotControllable: (reason, badge) ->
    @_proxyNotControllable = reason
    if reason
      @_state.set({'proxyNotControllable': reason})
      @setBadge(badge)
    else
      @_state.remove(['proxyNotControllable'])
      @clearBadge()

  _badgeTitle: null
  setBadge: (options) ->
    if not options
      options =
        if @_proxyNotControllable
          text: '='
          color: '#da4f49'
        else
          text: '?'
          color: '#49afcd'
    chrome.action.setBadgeText(text: options.text)
    chrome.action.setBadgeBackgroundColor(color: options.color)
    if options.title
      @_badgeTitle = options.title
      chrome.action.setTitle(title: options.title)
    else
      @_badgeTitle = null
  clearBadge: ->
    return if @externalApi?.disabled
    if @_badgeTitle
      @currentProfileChanged('clearBadge')
    if @_proxyNotControllable
      @setBadge()
    else
      chrome.action.setBadgeText?(text: '')
    return

  _quickSwitchInit: false
  _quickSwitchCanEnable: false
  setQuickSwitch: (quickSwitch, canEnable) ->
    @_quickSwitchCanEnable = canEnable
    if quickSwitch or not chrome.action.setPopup?
      chrome.action.setPopup?({popup: ''})
      if not @_quickSwitchInit
        @_quickSwitchInit = true
        chrome.action.onClicked.addListener (tab) =>
          @clearBadge()
          if not @_options['-enableQuickSwitch']
            chrome.tabs.create(url: 'popup/index.html')
            return
          profiles = @_options['-quickSwitchProfiles']
          index = profiles.indexOf(@_currentProfileName)
          index = (index + 1) % profiles.length
          @applyProfile(profiles[index]).then =>
            if @_options['-refreshOnProfileChange']
              url = tab.url
              return if not url
              return if url.substr(0, 6) == 'chrome'
              return if url.substr(0, 6) == 'about:'
              return if url.substr(0, 4) == 'moz-'
              chrome.tabs.reload(tab.id)
    else
      chrome.action.setPopup({popup: 'popup/index.html'})
    Promise.resolve()

  # Option B: no element inspect menus.
  setInspect: -> Promise.resolve()

  # Option B: no connection / request monitor.
  setMonitorWebRequests: -> Promise.resolve()

  _alarms: null
  schedule: (name, periodInMinutes, callback) ->
    name = 'omega.' + name
    if not @_alarms?
      @_alarms = {}
      chrome.alarms.onAlarm.addListener (alarm) =>
        @_alarms[alarm.name]?()
    if periodInMinutes < 0
      delete @_alarms[name]
      chrome.alarms.clear(name)
    else
      @_alarms[name] = callback
      chrome.alarms.create(name, {
        periodInMinutes: periodInMinutes
      })
    Promise.resolve()

  printFixedProfile: (profile) ->
    return unless profile.profileType == 'FixedProfile'
    result = ''
    for scheme in OmegaPac.Profiles.schemes when profile[scheme.prop]
      pacResult = OmegaPac.Profiles.pacResult(profile[scheme.prop])
      if scheme.scheme
        result += "#{scheme.scheme}: #{pacResult}\n"
      else
        result += "#{pacResult}\n"
    result ||= chrome.i18n.getMessage(
      'browserAction_profileDetails_DirectProfile')
    return result

  printProfile: (profile) ->
    type = profile.profileType
    if type.indexOf('RuleListProfile') >= 0
      type = 'RuleListProfile'

    if type == 'FixedProfile'
      @printFixedProfile(profile)
    else if type == 'PacProfile' and profile.pacUrl
      profile.pacUrl
    else
      chrome.i18n.getMessage('browserAction_profileDetails_' + type) || null

  upgrade: (options, changes) ->
    super(options).catch (err) =>
      return Promise.reject err if options?['schemaVersion']
      getOldOptions = if @switchySharp
        @switchySharp.getOptions().timeout(1000)
      else
        Promise.reject()

      getOldOptions = getOldOptions.catch ->
        if options?['config']
          Promise.resolve options
        else
          Promise.reject new OmegaTarget.Options.NoOptionsError()

      getOldOptions.then (oldOptions) =>
        i18n = {
          upgrade_profile_auto: chrome.i18n.getMessage('upgrade_profile_auto')
        }
        try
          upgraded = require('./upgrade')(oldOptions, i18n)
        catch ex
          @log.error(ex)
          return Promise.reject ex
        @_state.set({'firstRun': 'upgrade'})
        return this && super(upgraded, upgraded)

  onFirstRun: (reason) ->
    chrome.tabs.create url: chrome.runtime.getURL('options.html')

  getPageInfo: ({tabId, url}) ->
    # Domain helper for "add condition" in the popup — no request monitor.
    result = null
    return Promise.resolve(result) if not url
    if url.substr(0, 6) == 'chrome'
      errorPagePrefix = 'chrome://errorpage/'
      if url.substr(0, errorPagePrefix.length) == errorPagePrefix
        url = querystring.parse(url.substr(url.indexOf('?') + 1)).lasturl
        return Promise.resolve(result) if not url
      else
        return Promise.resolve(result)
    return Promise.resolve(result) if url.substr(0, 6) == 'about:'
    return Promise.resolve(result) if url.substr(0, 4) == 'moz-'
    domain = OmegaPac.getBaseDomain(Url.parse(url).hostname)

    return Promise.resolve({
      url: url
      domain: domain
      tempRuleProfileName: @queryTempRule(domain)
    })

module.exports = ChromeOptions
