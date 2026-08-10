OmegaTarget = require('omega-target')
Promise = OmegaTarget.Promise
ProxyAuth = require('./proxy_auth')

class ProxyImpl
  constructor: (log) ->
    @log = log
  # Full PAC compiler script; loaded on demand for Switch/RuleList profiles.
  _pacFullScriptUrl: 'js/omega_pac_full.min.js'
  @isSupported: -> false
  applyProfile: (profile, meta) -> Promise.reject()
  watchProxyChange: (callback) -> null
  parseExternalProfile: (details, options) -> null
  _profileNotFound: (name) ->
    @log.error("Profile #{name} not found! Things may go very, very wrong.")
    return OmegaPac.Profiles.create({
      name: name
      profileType: 'VirtualProfile'
      defaultProfileName: 'direct'
    })
  ###*
  # OmegaPac with PacGenerator. Match-only SW loads omega_pac.min.js first;
  # importScripts the full compiler bundle once when generating PAC text.
  ###
  _pacWithCompiler: ->
    g = globalThis
    return g.OmegaPacFull if g.OmegaPacFull?.PacGenerator?
    return g.OmegaPac if g.OmegaPac?.PacGenerator?
    if typeof importScripts == 'function'
      importScripts(@_pacFullScriptUrl)
      return g.OmegaPacFull if g.OmegaPacFull?.PacGenerator?
      return g.OmegaPac if g.OmegaPac?.PacGenerator?
    throw new Error(
      'PAC compiler unavailable (omega_pac_full.min.js not loaded)')
  setProxyAuth: (profile, options) ->
    return Promise.try(=>
      # Share the singleton registered at SW startup (see background.coffee).
      @_proxyAuth = ProxyAuth.shared(@log)
      @_proxyAuth.listen()
      referenced_profiles = []
      ref_set = OmegaPac.Profiles.allReferenceSet(profile,
        options, profileNotFound: @_profileNotFound.bind(this))
      for own _, name of ref_set
        profile = OmegaPac.Profiles.byName(name, options)
        if profile
          referenced_profiles.push(profile)
      @_proxyAuth.setProxies(referenced_profiles)
    )
  getProfilePacScript: (profile, meta, options) ->
    meta ?= profile
    Pac = @_pacWithCompiler()
    ast = Pac.PacGenerator.script(options, profile,
      profileNotFound: @_profileNotFound.bind(this))
    ast = Pac.PacGenerator.compress(ast)
    script = Pac.PacGenerator.ascii(ast.print_to_string())
    profileName = Pac.PacGenerator.ascii(JSON.stringify(meta.name))
    profileName = profileName.replace(/\*/g, '\\u002a')
    profileName = profileName.replace(/\\/g, '\\u002f')
    prefix = "/*OmegaProfile*#{profileName}*#{meta.revision}*/"
    return prefix + script

module.exports = ProxyImpl
