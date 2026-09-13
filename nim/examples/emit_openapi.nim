import std/[os, strutils]
import server_decorator/gen_openapi
import ./user
let version = readFile(currentSourcePath().parentDir / "../../contracts/VERSION").strip
stdout.write openapiCanonical(@[entitySpec(User)], version)
