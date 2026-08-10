ListenerProxyImpl = require('./proxy_impl_listener')
SettingsProxyImpl = require('./proxy_impl_settings')
ScriptProxyImpl = require('./proxy_impl_script')
ProxyAuth = require('./proxy_auth')

exports.ProxyAuth = ProxyAuth
exports.proxyImpls = [ListenerProxyImpl, ScriptProxyImpl, SettingsProxyImpl]
exports.getProxyImpl = (log) ->
  for Impl in exports.proxyImpls
    if Impl.isSupported()
      return new Impl(log)
  throw new Error('Your browser does not support proxy settings!')
