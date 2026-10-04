# ADR 0009 — Cache-key ordering is by Unicode code point

Status: Accepted (2026-10-04) · Contract: 1.3.0 · Refines ADR 0003 / Decision #6

## Context
ADR 0003 and Decision #6 promise a cache key with "stable key ordering" that is
byte-identical in every language. `contracts/rules/cache-key.md` said `sort_keys=True` and
left the *order* unstated, so each lane used its language's default:

- Python `sorted` and Go `sort.Strings` compare by Unicode code point (equivalently, by
  UTF-8 bytes).
- Node `Array.prototype.sort` compares by UTF-16 code unit.

The two orders agree except in one range. An astral character (U+10000 and above) is
stored in UTF-16 as a surrogate pair starting at 0xD800–0xDBFF, so Node sorted it *before*
any character in U+E000–U+FFFF, while Python and Go sort it after. For an object such as
`{"😀": 1, "～": 2}` Node produced `{"😀":1,"～":2}` and Python and Go produced
`{"～":2,"😀":1}`: the same call had two different keys, and the byte-for-byte promise was
broken.

## Decision
Object keys, `kwargs` names, Node `Map` entries and Node `Set` members are ordered by
**Unicode code point**. Node uses an explicit code-point comparator and must never fall
back to the default sort. The shared fixture case `object-keys-sorted-by-code-point` in
`contracts/fixtures/cache-key.examples.json` pins it for Node, Python and Go.

Code point, not UTF-16 code unit, because two of the three lanes already did it, it equals
UTF-8 byte order (what a store sees), and it needs no special case in any language except
the one that was wrong.

## What changes for consumers
Measured by building keys with the pre-1.3.0 and the 1.3.0 builders on the same inputs:

- **Node** — a key changes when a plain object or the kwargs contain, at the same level,
  one key with an astral character and one with a character in U+E000–U+FFFF; the two
  swap places. Objects whose keys are ASCII, or mix astral characters only with characters
  below U+E000, give the same key as before. (`Map` and `Set` arguments change for a
  separate reason: they were `{}` before 1.3.0 and are now serialised by their content,
  in the same code-point order.)
- **Python, Go** — key order did not change; both already sorted by code point.

Each affected Node entry is missed once after the upgrade and re-computed under the new
key; the old entry is never read again and expires by its TTL. Nothing is served from a
wrong entry, so no flush is required. The full per-language list of 1.3.0 key changes is
in `contracts/CHANGELOG.md`, 1.3.0 "Compatibility".

## Why a minor contract bump, not a major one
`CLAUDE.md` says changing the cache-key algorithm is a major bump. This is not a change of
the algorithm; it is one lane being brought into line with it:

- The contract's stated guarantee (byte-identical keys across languages) was already
  violated for these inputs. No consumer could rely on the Node ordering *and* on the
  contract at the same time.
- The fix removes a divergence instead of introducing one, and the affected input set is
  narrow (two specific Unicode ranges meeting in one object).
- The cost is a one-time miss per affected key, the same cost as any cache expiry, with no
  correctness risk. A major bump exists to force a deliberate flush (D-A); here there is
  nothing to flush.

Contract 1.3.0 is unreleased, so the correction ships inside it without a further bump.

## Consequences
- The rule text now names the order, so a new lane cannot pick its language default by
  accident, and the fixture fails if it does.
- A future change to this order *would* be an algorithm change and a major bump.
- Date text and whole-number floats remain the two documented per-language differences;
  this ADR does not touch them.
