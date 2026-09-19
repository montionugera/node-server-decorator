# Contributing to server-decorator

Thank you for contributing to `server-decorator`!

This repository is a **polyglot library** maintained under strict contractual guarantees. Because multiple languages (Node/TypeScript, Python, Go, Nim) interoperate through shared wire protocols, all contributors must follow these development rules to prevent drift, regressions, or broken contracts.

---

## 1. Golden Rules for Contributors

### Rule 1: Contract-First
Any change to wire envelopes, message structures, cache key algorithms, or EntitySpec IR **must start in `contracts/`**:
1. Update schemas in `contracts/schemas/` or algorithm rules in `contracts/rules/`.
2. Update the `contracts/fixtures/` test cases.
3. Bump `contracts/VERSION` and add an entry in `contracts/CHANGELOG.md`.
4. Update `_contract.ts` (Node) and `_contract.py` (Python) in lockstep.

### Rule 2: Byte-Identical Parity
- **EntitySpec IR**: Node, Python, Go, and Nim `entity` packages must emit **100% byte-identical JSON** for the same entity definition (`bash scripts/check-entity-parity.sh`).
- **OpenAPI 3.1**: Node, Python, and Nim `gen-openapi` packages must emit **100% byte-identical OpenAPI specifications** (`bash scripts/check-openapi-parity.sh`).
- **DTO Validation**: Zod (Node) and Pydantic v2 (Python) must pass all test cases defined in `contracts/fixtures/entity-spec.cases.json`.

### Rule 3: Documentation Mandate
- **No code without documentation**: Any new decorator, adapter, field marker, or configuration option must be documented in:
  1. The package's local `README.md`.
  2. The multi-language documentation portal (`website/src/content/docs/`).
- **Polyglot Code Snippets**: Always provide code examples for **all supported languages** using synchronized code tabs (`<Tabs syncKey="lang">`).

### Rule 4: Lockstep Semver
All published packages share the same semver version. Never manually bump one package alone. Use:
```bash
bash scripts/bump-version.sh [patch|minor|major]
```

---

## 2. Local Development & Verification

Before submitting a Pull Request, run the local verification suite:

```bash
bash scripts/contributor-check.sh
```

This automated script verifies:
- [x] Package version alignment (`scripts/check-versions.sh`)
- [x] EntitySpec IR parity across all 4 languages (`scripts/check-entity-parity.sh`)
- [x] OpenAPI 3.1 parity across all 3 generators (`scripts/check-openapi-parity.sh`)
- [x] Node unit tests and build (`cd node && pnpm -r test:unit && pnpm -r run build`)
- [x] Python linting, typing, and unit tests (`cd python && bash scripts/check.sh`)
- [x] Go tests and hygiene (`go test ./go/... && test -z "$(gofmt -l go)"`)
- [x] Nim tests and syntax check (`cd nim && nimble test`)
- [x] Documentation website build (`cd website && pnpm build`)

---

## 3. Pull Request Requirements

Every pull request must:
1. Use conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
2. Complete all checklist items in `.github/pull_request_template.md`.
3. Include tests covering new functionality across all affected language lanes.
4. Pass all CI workflows (`ci-contracts.yml`, `ci-node.yml`, `ci-python.yml`, `ci-go.yml`, `ci-nim.yml`).
