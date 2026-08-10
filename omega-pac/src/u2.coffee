# Lazy accessor for uglify-js (PAC AST compile only).
#
# Match-only browser builds ignore uglify-js so the service worker does not
# pay for it until omega_pac_full is loaded. require() runs on first property
# access; constructing this module does not load uglify.

_raw = undefined

load = ->
  if _raw is undefined
    _raw = require 'uglify-js'
  # Real uglify-js exports AST_*; ignored/stubbed module is {}.
  unless _raw? and (_raw.AST_Binary? or _raw.AST_True?)
    err = new Error(
      'PAC compiler not loaded. Load omega_pac_full.min.js first.')
    err.code = 'OMEGA_PAC_COMPILE_REQUIRED'
    throw err
  _raw

# Proxy keeps existing U2.AST_* / U2.Compressor call sites unchanged.
module.exports = new Proxy {},
  get: (_target, prop) ->
    if prop == 'inspect' or prop == 'then' or prop == 'toJSON'
      return undefined
    if typeof prop == 'symbol'
      return undefined
    mod = load()
    mod[prop]
