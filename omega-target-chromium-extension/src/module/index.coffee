module.exports =
  Storage: require('./storage')
  Options: require('./options')
  SwitchySharp: require('./switchysharp')
  ExternalApi: require('./external_api')
  Url: require('url')
  proxy: require('./proxy')
  # Intentionally not exported (Option B minimal SW):
  # ChromeTabs, WebRequestMonitor, Inspect

for name, value of require('omega-target')
  module.exports[name] ?= value
