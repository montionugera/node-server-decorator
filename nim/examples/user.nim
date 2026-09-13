## Mirrors contracts/fixtures/entity-spec.valid-user.json — the parity input.
import std/times
import server_decorator/entity

restful "users", description = "A registered user account", tags = ["identity"],
        transports = [rest, rpc, sse, ws],
        security = SecuritySpec(
          schemes: @[SecurityScheme(name: "bearerAuth", `type`: "http", scheme: some("bearer"), bearerFormat: some("JWT"))],
          ops: @[("create", @["user:write"]), ("update", @["user:write"]), ("delete", @["user:admin"])],
          actions: @[("activate", @["user:admin"])]):
  type
    Profile* = object
      bio* {.max: 500, optional.}: string
    User* = object
      id* {.role: "id", readonly.}: string
      email* {.description: "Primary contact address", format: "email", filterable.}: string
      name* {.min: 2, max: 80.}: string
      status* {.enumOf: ["inactive", "active", "banned"], filterable.}: string
      loginCount* {.min: 0, readonly.}: int
      tags*: seq[string]
      profile* {.optional.}: Profile
      birthday* {.nullable, optional.}: DateTime
      score* {.min: 0, optional.}: float
      active* {.optional.}: bool
      secretNote* {.max: 100, writeonly, optional.}: string
  action "activate", description = "Move a dormant account back to active":
    transition "status", "inactive", "active"
    input:
      reason {.max: 200, optional.}: string
  action "ping"
