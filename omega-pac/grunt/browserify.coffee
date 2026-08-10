minifyPlugin = ->
  if process.env.BUILD == 'release'
    [['minifyify', {map: false}]]
  else
    []

module.exports =
  # Node / test bundle (full: match + PacGenerator + real uglify-js).
  index:
    files:
      'index.js': 'index.coffee'
    options:
      transform: ['coffeeify']
      exclude: ['uglify-js', 'ip-address']
      browserifyOptions:
        extensions: '.coffee'
        builtins: []
        standalone: 'index.coffee'
        debug: true

  # Match-only browser bundle for the MV3 service worker (no uglify).
  # ignore uglify-* so the SW does not pay for PAC AST compilation until
  # omega_pac_full.min.js is importScripts'd on demand.
  browser:
    files:
      'omega_pac.min.js': './index_match.coffee'
    options:
      alias: [
        './index_match.coffee:OmegaPac'
      ]
      ignore: ['uglify-js', 'uglify-js-real']
      transform: ['coffeeify']
      plugin: minifyPlugin()
      browserifyOptions:
        extensions: '.coffee'
        standalone: 'OmegaPac'

  # Full PAC compiler for on-demand load when applying Switch/RuleList profiles.
  browser_full:
    files:
      'omega_pac_full.min.js': './index.coffee'
    options:
      alias: [
        './index.coffee:OmegaPacFull'
      ]
      transform: ['coffeeify']
      plugin: minifyPlugin()
      browserifyOptions:
        extensions: '.coffee'
        standalone: 'OmegaPacFull'
