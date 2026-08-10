module.exports =
  default: [
    'coffeelint'
    # index + browser only; not omega_webext_proxy_script (Firefox optional).
    'browserify:index'
    'browserify:browser'
    'coffee'
    'copy'
    'po2crx'
  ]
  test: ['mochaTest']
  # Firefox proxy.register script (uses match-only omega_pac).
  firefox_proxy_script: ['browserify:omega_webext_proxy_script']
  release: ['default', 'chromium-manifest', 'compress']
