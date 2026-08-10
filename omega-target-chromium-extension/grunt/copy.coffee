module.exports =
  web:
    expand: true
    cwd: '../omega-web/build'
    src: ['**/*']
    dest: 'build/'
  target:
    files:
      'build/js/omega_target.min.js':
        'node_modules/omega-target/omega_target.min.js'
      # Match-only (SW default) + full PAC compiler (loaded on demand).
      'build/js/omega_pac.min.js':
        'node_modules/omega-pac/omega_pac.min.js'
      'build/js/omega_pac_full.min.js':
        'node_modules/omega-pac/omega_pac_full.min.js'
  target_self:
    src: 'omega_target_chromium_extension.min.js'
    dest: 'build/js/'
  target_popup:
    expand: true
    cwd: 'src/js'
    src: 'omega_target_popup.js'
    dest: 'build/js/'
  overlay:
    expand: true
    cwd: 'overlay'
    src: ['**/*']
    dest: 'build/'
  docs:
    expand: true
    cwd: '..'
    src: ['COPYING', 'AUTHORS']
    dest: 'build/'
