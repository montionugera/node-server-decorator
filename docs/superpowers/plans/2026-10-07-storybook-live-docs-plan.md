# Storybook-Like Interactive Live Docs & Tutorial Studio Implementation Plan

**File**: `docs/superpowers/plans/2026-10-07-storybook-live-docs-plan.md`  
**Spec Reference**: `docs/superpowers/specs/2026-10-07-storybook-live-docs-design.md`  
**Execution Mode**: OpenUltraCode / Subagent-Driven Full Chain  
**Quality Gate**: Phased Quality Gate + Contributor Quality Gate (8/8 steps green)  

---

## Phase Breakdown

### Phase 1: Storybook 8 & React Framework Scaffolding in `website/`
- **Goal**: Set up `@storybook/react-vite`, React 18/19, Tailwind/Lucide (or clean CSS), and ensure Storybook runs and builds cleanly.
- **Tasks**:
  1. Install React, ReactDOM, `@storybook/react-vite`, Storybook addons, and Lucide icons in `website/package.json`.
  2. Configure `.storybook/main.ts` and `.storybook/preview.ts` inside `website/`.
  3. Configure Storybook port handling (port 6006, fallback 6007 per global rule #6).
  4. Add `pnpm run storybook` and `pnpm run build-storybook` scripts.
- **Verification**:
  - `cd website && pnpm build-storybook` exits 0 and outputs static files to `website/public/storybook`.
  - Phase 1 Quality Gate: verify, review, refactor, re-verify.

---

### Phase 2: Core Resilience Simulators (React Components)
- **Goal**: Build visual, reactive state machines for resilience decorators.
- **Components**:
  1. `CircuitBreakerSimulator`: CLOSED / OPEN / HALF-OPEN state machine, live reset timer, failure counter, trial requests.
  2. `RetryBackoffSimulator`: Interactive Gantt-chart timeline, exponential backoff curve, jitter comparison.
  3. `RateLimiterSimulator`: Animated token bucket container, token drip refill, burst capacity, RFC 7807 problem modal.
  4. `DistributedLockSimulator`: Lease duration countdown, background heartbeat watchdog pulse at TTL/3, simulated network partitions.
  5. `CoalesceLoaderSimulator`: Interactive multi-card request dispatcher, microtask tick coalescing, singleflight batch log.
- **Verification**:
  - Unit tests for state machine logic with Vitest.
  - Phase 2 Quality Gate: verify, review, refactor, re-verify.

---

### Phase 3: EntitySpec Studio & Polyglot Code Generator
- **Goal**: Build an in-browser interactive schema editor that compiles to IR, OpenAPI, and multi-language code.
- **Components**:
  1. `EntitySpecStudio`: Field builder (types, constraints, format, pattern, roles).
  2. `CanonicalIRViewer`: Live JSON viewer formatted according to canonical sorting rules.
  3. `OpenApiCompilerViewer`: Live OpenAPI 3.1 generator.
  4. `PolyglotCodeTabs`: 5-language synchronized code view (TypeScript, Python, Go, Nim, Rust).
- **Verification**:
  - Interactive schema edits immediately update all 4 output views in real-time.
  - Phase 3 Quality Gate: verify, review, refactor, re-verify.

---

### Phase 4: Storybook Stories & Interactive Polyglot Tutorials
- **Goal**: Create comprehensive `.stories.tsx` and tutorial chapters.
- **Stories**:
  1. `stories/resilience/CircuitBreaker.stories.tsx`
  2. `stories/resilience/Retry.stories.tsx`
  3. `stories/resilience/RateLimiter.stories.tsx`
  4. `stories/resilience/DistributedLock.stories.tsx`
  5. `stories/resilience/Coalesce.stories.tsx`
  6. `stories/entity/EntitySpecStudio.stories.tsx`
  7. `stories/tutorials/PolyglotQuickstart.stories.tsx`
- **Verification**:
  - All stories render with interactive controls (args), actions logging, and synced language switchers.
  - Phase 4 Quality Gate: verify, review, refactor, re-verify.

---

### Phase 5: Portal Integration & Documentation Updates
- **Goal**: Integrate Storybook into the Astro Starlight portal and update docs.
- **Tasks**:
  1. Create `<StorybookEmbed />` Astro component in `website/src/components/`.
  2. Embed live stories directly in `/core/resilience`, `/core/cache`, `/core/coalescing`, and `/entity-spec/declaration`.
  3. Add dedicated "Interactive Studio" link in Starlight top navbar and sidebar.
  4. Update `README.md` and `website/README.md`.
- **Verification**:
  - `bash scripts/contributor-check.sh` passes all 8 steps cleanly including step 8 (`pnpm build` in `website/`).
  - Phase 5 Quality Gate: verify, review, refactor, re-verify.
