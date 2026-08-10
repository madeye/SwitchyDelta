# Match-only entry: rule matching, domain trie, rule lists — no PacGenerator.
# Browser build aliases uglify-js to a stub so the SW stays small.
module.exports =
  Conditions: require('./src/conditions')
  Profiles: require('./src/profiles')
  RuleList: require('./src/rule_list')
  ShexpUtils: require('./src/shexp_utils')

for name, value of require('./src/utils.coffee')
  module.exports[name] = value
