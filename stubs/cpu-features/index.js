// ssh2 wraps require('cpu-features')() in try/catch and falls back to its
// default cipher order, so failing here matches the addon being absent.
throw new Error('cpu-features is stubbed out in noxed')
