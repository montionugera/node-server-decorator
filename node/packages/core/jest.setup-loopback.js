// Unit-lane setup: make supertest dial the IPv6 loopback when its ephemeral server is bound to
// the dual-stack wildcard (`::`).
//
// supertest starts a server with `app.listen(0)` (binds `::`) and then connects to
// `127.0.0.1:<port>`. On macOS the kernel can hand the `::` socket a port number that another
// local process already holds on IPv4 (`127.0.0.1:<port>` or `*:<port>`); the request then
// reaches that foreign process and the test fails with "socket hang up" (about 1 in 2000
// requests on a developer machine with a few local daemons). `[::1]:<port>` always reaches the
// server supertest just started. Linux refuses such a bind outright, so it is left untouched.
if (process.platform === 'darwin') {
  const { Test } = require('supertest')

  const PATCHED = Symbol.for('server-decorator.test.loopback-dial')

  if (!Test.prototype[PATCHED]) {
    const originalServerAddress = Test.prototype.serverAddress
    Test.prototype.serverAddress = function serverAddress(app, path) {
      const url = originalServerAddress.call(this, app, path)
      const addr = app.address()
      return addr && addr.family === 'IPv6'
        ? url.replace('://127.0.0.1:', '://[::1]:')
        : url
    }
    Test.prototype[PATCHED] = true
  }
}
