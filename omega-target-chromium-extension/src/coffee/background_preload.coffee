# Minimal SW / background bootstrap. No context menus, no localStorage logs.
if not globalThis.window?
  globalThis.window = globalThis
  globalThis.global = globalThis

window.UglifyJS_NoUnsafeEval = true
