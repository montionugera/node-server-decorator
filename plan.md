# Implementation Plan - F-012: Polyglot Resilience Suite (@retry, @circuit_breaker, @rate_limit) & Property Wrapping

**Goal (Verbatim):** Open release 2.1, refine idea I-002, and implement the polyglot Resilience Suite (@retry, @circuit_breaker, @rate_limit) across Go, Node/TypeScript, and Python.

---

### Task 1: Go Resilience Engine (`go/core`)

**Files:**
- Create: `go/core/retry.go`
- Create: `go/core/retry_test.go`
- Create: `go/core/circuit_breaker.go`
- Create: `go/core/circuit_breaker_test.go`
- Create: `go/core/rate_limit.go`
- Create: `go/core/rate_limit_test.go`

**Interfaces:**
- Produces: `Retry[In, Out any](opts RetryOptions, fn func(context.Context, In) (Out, error))`
- Produces: `NewCircuitBreaker(opts CircuitBreakerOptions) *CircuitBreaker` and `CircuitBreakerWrapper[In, Out any](cb *CircuitBreaker, fn ...)`
- Produces: `NewTokenBucketLimiter(capacity float64, refillRate float64) *TokenBucketLimiter` and `RateLimit[In, Out any](limiter *TokenBucketLimiter, fn ...)`

- [x] **Step 1: Write unit tests in `retry_test.go`, `circuit_breaker_test.go`, and `rate_limit_test.go`**
- [x] **Step 2: Run tests to verify red/missing state**
- [x] **Step 3: Implement `retry.go`, `circuit_breaker.go`, and `rate_limit.go` in `go/core`**
- [x] **Step 4: Run `CGO_ENABLED=0 go test -v ./go/core/...` and verify green**
- [x] **Step 5: Git commit**

---

### Task 2: Node/TypeScript Resilience Suite (`node/packages/core`)

**Files:**
- Create: `node/packages/core/src/decorators/retry.ts`
- Create: `node/packages/core/src/decorators/retry.spec.ts`
- Create: `node/packages/core/src/decorators/circuit-breaker.ts`
- Create: `node/packages/core/src/decorators/circuit-breaker.spec.ts`
- Create: `node/packages/core/src/decorators/rate-limit.ts`
- Create: `node/packages/core/src/decorators/rate-limit.spec.ts`
- Modify: `node/packages/core/src/index.ts`

**Interfaces:**
- Produces: `@retry(options?: RetryOptions)`
- Produces: `@circuitBreaker(options?: CircuitBreakerOptions)` & `CircuitBreakerOpenError`
- Produces: `@rateLimit(options?: RateLimitOptions)` & `RateLimitExceededError`

- [x] **Step 1: Write test specifications for retry, circuit breaker, and rate limiter**
- [x] **Step 2: Run tests to verify failures**
- [x] **Step 3: Implement decorators in `src/decorators/` and export in `src/index.ts`**
- [x] **Step 4: Run `pnpm --filter @montionugera/server-decorator test:unit` and verify all tests pass**
- [x] **Step 5: Git commit**

---

### Task 3: Python Resilience Suite & Property Wrapping (`python/packages/core`)

**Files:**
- Create: `python/packages/core/src/server_decorator/decorators/retry.py`
- Create: `python/packages/core/src/server_decorator/decorators/circuit_breaker.py`
- Create: `python/packages/core/src/server_decorator/decorators/rate_limit.py`
- Modify: `python/packages/core/src/server_decorator/decorators/_class_apply.py` (N1 resolution)
- Modify: `python/packages/core/src/server_decorator/decorators/__init__.py`
- Modify: `python/packages/core/src/server_decorator/__init__.py`
- Create: `python/packages/core/tests/unit/test_retry.py`
- Create: `python/packages/core/tests/unit/test_circuit_breaker.py`
- Create: `python/packages/core/tests/unit/test_rate_limit.py`
- Create: `python/packages/core/tests/unit/test_property_wrapping.py`

**Interfaces:**
- Produces: `@retry`, `@retry_class`
- Produces: `@circuit_breaker`, `@circuit_breaker_class`, `CircuitBreakerOpenError`
- Produces: `@rate_limit`, `@rate_limit_class`, `RateLimitExceededError`
- Resolves: Decision N1: `wrap_properties=True` in `_class_apply.py` wraps `@property` getters/setters.

- [x] **Step 1: Write pytest test cases for retry, circuit breaker, rate limiter, and property wrapping**
- [x] **Step 2: Implement resilience modules and update `_class_apply.py`**
- [x] **Step 3: Run `uv run --package server-decorator --extra dev pytest packages/core/tests/unit` and verify green**
- [x] **Step 4: Git commit**

---

### Task 4: Documentation, Verification & Ship

**Files:**
- Create: `website/src/content/docs/core/resilience.mdx`
- Run `bash scripts/contributor-check.sh`
- Execute `psrw ship`

- [x] **Step 1: Create documentation in `website/src/content/docs/core/resilience.mdx`**
- [x] **Step 2: Run `bash scripts/contributor-check.sh` and verify all 7 gates pass**
- [ ] **Step 3: Execute `psrw ship`**
