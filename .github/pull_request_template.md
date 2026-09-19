## Description

Please provide a concise description of the changes made and the rationale behind them.

---

## Type of Change

- [ ] `feat`: New feature / capability
- [ ] `fix`: Bug fix
- [ ] `docs`: Documentation updates or additions
- [ ] `refactor`: Behavior-preserving code improvement
- [ ] `contract`: Change to wire schemas or algorithm rules in `contracts/`

---

## Contributor Quality Checklist

Please verify that your change adheres to the project's quality standards:

### 1. Contract & Parity
- [ ] If wire formats or behaviors changed, `contracts/` was updated first (schemas, rules, fixtures, `VERSION`, and `CHANGELOG.md`).
- [ ] `bash scripts/check-entity-parity.sh` passes (Node == Python == Go == Nim).
- [ ] `bash scripts/check-openapi-parity.sh` passes (Node == Python == Nim).
- [ ] `bash scripts/check-versions.sh` passes (All packages share lockstep semver).

### 2. Testing
- [ ] Unit tests added or updated for all modified language packages.
- [ ] All package test suites pass locally (`node`, `python`, `go`, `nim`).

### 3. Documentation Mandate
- [ ] Package `README.md` updated for any new public API, decorator, or parameter.
- [ ] Multi-language documentation portal (`website/src/content/docs/`) updated with synchronized code tabs (`<Tabs syncKey="lang">`) for all active languages.
- [ ] Documentation build passes (`cd website && pnpm build`).

### 4. Local Gate
- [ ] Ran `bash scripts/contributor-check.sh` and verified all automated checks passed.
