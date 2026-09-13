import std/[json, algorithm, unicode, strutils]

# Compare by Unicode code point (== UTF-8 byte order), like Python sorted() / canonical.ts.
proc cmpCodePoints(a, b: string): int =
  let ra = a.toRunes; let rb = b.toRunes
  for i in 0 ..< min(ra.len, rb.len):
    let d = int(ra[i]) - int(rb[i])
    if d != 0: return d
  ra.len - rb.len

proc escapeString(s: string): string =
  ## JSON.stringify-compatible escaping: short forms for " \ \b \f \n \r \t, LOWERCASE
  ## \u00xx for the other control chars, everything else (non-ASCII, <>&, U+2028) raw.
  ## Not std/json.escapeJson: it emits UPPERCASE hex (\u001F), breaking byte parity with
  ## Node/Python/Go for 0x0E-0x1F (F-006 plan audit, HIGH-1).
  result = newStringOfCap(s.len + 2)
  result.add '"'
  for c in s:
    case c
    of '"': result.add "\\\""
    of '\\': result.add "\\\\"
    of '\b': result.add "\\b"
    of '\f': result.add "\\f"
    of '\n': result.add "\\n"
    of '\r': result.add "\\r"
    of '\t': result.add "\\t"
    of '\0'..'\7', '\11', '\14'..'\31': result.add "\\u00" & toHex(ord(c), 2).toLowerAscii
    else: result.add c
  result.add '"'

proc canonicalJson*(n: JsonNode): string =
  case n.kind
  of JObject:
    var keys: seq[string] = @[]
    for k in n.keys: keys.add k
    keys.sort(cmpCodePoints)
    result = "{"
    for i, k in keys:
      if i > 0: result.add ","
      result.add escapeString(k); result.add ":"; result.add canonicalJson(n[k])
    result.add "}"
  of JArray:
    result = "["
    for i, e in n.elems:
      if i > 0: result.add ","
      result.add canonicalJson(e)
    result.add "]"
  of JString: result = escapeString(n.str)
  of JInt: result = $n.num
  of JFloat: result = $n.fnum
  of JBool: result = (if n.bval: "true" else: "false")
  of JNull: result = "null"
