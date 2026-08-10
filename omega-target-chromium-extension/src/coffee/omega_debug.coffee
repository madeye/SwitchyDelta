globalThis.OmegaDebug =
  getProjectVersion: ->
    chrome.runtime.getManifest().version
  getExtensionVersion: ->
    chrome.runtime.getManifest().version
  downloadLog: ->
    # Minimal build: no in-memory log buffer. Open the issue reporter instead.
    OmegaDebug.reportIssue()
  resetOptions: ->
    # Clear options + state, then reload so the SW re-inits defaults.
    done = -> chrome.runtime.reload()
    try
      chrome.storage.local.clear ->
        try
          chrome.storage.sync?.clear?()
        catch _
          # ignore
        done()
    catch _
      done()
  reportIssue: ->
    url = 'https://github.com/FelisCatus/SwitchyOmega/issues/new?title=&body='
    finalUrl = url
    try
      projectVersion = OmegaDebug.getProjectVersion()
      extensionVersion = OmegaDebug.getExtensionVersion()
      env =
        extensionVersion: extensionVersion
        projectVersion: extensionVersion
        userAgent: navigator.userAgent
      body = chrome.i18n.getMessage('popup_issueTemplate', [
        env.projectVersion, env.userAgent
      ])
      body ||= """
        \n\n
        <!-- Please write your comment ABOVE this line. -->
        SwitchyOmega #{env.projectVersion}
        #{env.userAgent}
      """
      finalUrl = url + encodeURIComponent(body)
    chrome.tabs.create(url: finalUrl)
