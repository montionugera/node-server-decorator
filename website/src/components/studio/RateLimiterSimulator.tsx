import React, { useState, useEffect } from "react";
import { Gauge, ShieldAlert, Check, Flame, RefreshCcw } from "lucide-react";
import { PolyglotCodeTabs } from "./PolyglotCodeTabs";
import "./studio.css";

export interface RateLimiterSimulatorProps {
  capacity?: number;
  refillPerSecond?: number;
}

export const RateLimiterSimulator: React.FC<RateLimiterSimulatorProps> = ({
  capacity = 10,
  refillPerSecond = 2,
}) => {
  const [bucketCapacity, setBucketCapacity] = useState(capacity);
  const [refillRate, setRefillRate] = useState(refillPerSecond);
  const [tokens, setTokens] = useState(capacity);
  const [passedCount, setPassedCount] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [showProblemJson, setShowProblemJson] = useState(false);

  // Background token refill loop
  useEffect(() => {
    const interval = setInterval(() => {
      setTokens((prev) => Math.min(bucketCapacity, prev + refillRate / 2));
    }, 500);
    return () => clearInterval(interval);
  }, [bucketCapacity, refillRate]);

  const consumeTokens = (amount: number) => {
    if (tokens >= amount) {
      setTokens((prev) => prev - amount);
      setPassedCount((prev) => prev + amount);
      setShowProblemJson(false);
    } else {
      const allowed = Math.floor(tokens);
      setTokens(0);
      setPassedCount((prev) => prev + allowed);
      setRejectedCount((prev) => prev + (amount - allowed));
      setShowProblemJson(true);
    }
  };

  const resetBucket = () => {
    setTokens(bucketCapacity);
    setPassedCount(0);
    setRejectedCount(0);
    setShowProblemJson(false);
  };

  const percentage = Math.round((tokens / bucketCapacity) * 100);

  const snippets = {
    typescript: `// TypeScript / Node
import { withRateLimit, RateLimitExceededError } from '@montionugera/server-decorator';

const rateLimitedEndpoint = withRateLimit(async (req: Request) => {
  return await handleRequest(req);
}, {
  tokensPerInterval: ${bucketCapacity},
  interval: 'second',
  key: (req) => req.headers.get('x-user-id') ?? req.ip
});`,
    python: `# Python
from server_decorator import rate_limit

@rate_limit(tokens=${bucketCapacity}, interval="1s", key=lambda req: req.client.host)
async def api_endpoint(request: Request):
    return {"status": "ok"}`,
    go: `// Go
import "github.com/montionugera/node-server-decorator/go/core"

limiter := core.NewTokenBucketLimiter(${bucketCapacity}, ${refillRate})
if !limiter.Allow() {
    return c.JSON(429, core.NewProblem(429, "Rate Limit Exceeded"))
}`,
    nim: `// Nim
import server_decorator/resilience

let limiter = newTokenBucket(capacity = ${bucketCapacity}, refillRate = ${refillRate})
if not limiter.tryAcquire():
  raise newException(RateLimitError, "Token bucket depleted")`,
    rust: `// Rust
use server_decorator_core::rate_limit::{RateLimiter, RateLimitOptions};

let limiter = RateLimiter::new(RateLimitOptions {
    capacity: ${bucketCapacity},
    refill_rate: ${refillRate},
});
if !limiter.check_and_consume(1) {
    return Err(Problem::new(StatusCode::TOO_MANY_REQUESTS, "Rate Limit Exceeded"));
}`,
  };

  return (
    <div className="studio-card">
      <div className="studio-header">
        <h3 className="studio-title">
          <Gauge size={22} color="#388bfd" /> Token Bucket Rate Limiter
          Simulator
        </h3>
        <span className="studio-badge badge-blue">
          Refill: +{refillRate} tokens/sec
        </span>
      </div>

      <div className="studio-grid">
        <div className="studio-panel">
          <div className="studio-controls">
            <div className="studio-control-row">
              <span className="studio-control-label">
                Bucket Capacity (Burst limit):
              </span>
              <input
                type="number"
                min="2"
                max="30"
                className="studio-input"
                value={bucketCapacity}
                onChange={(e) => {
                  const val = Number(e.target.value);
                  setBucketCapacity(val);
                  setTokens(val);
                }}
              />
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">
                Refill Rate (tokens / second):
              </span>
              <input
                type="number"
                min="1"
                max="10"
                className="studio-input"
                value={refillRate}
                onChange={(e) => setRefillRate(Number(e.target.value))}
              />
            </div>
          </div>

          <div style={{ marginTop: "1.25rem" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                fontSize: "0.85rem",
                marginBottom: "0.35rem",
              }}
            >
              <span>Bucket Fill Level:</span>
              <strong>
                {tokens.toFixed(1)} / {bucketCapacity} Tokens ({percentage}%)
              </strong>
            </div>
            <div
              style={{
                width: "100%",
                height: "20px",
                background: "#21262d",
                borderRadius: "9999px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${percentage}%`,
                  height: "100%",
                  background: percentage > 25 ? "#388bfd" : "#f85149",
                  transition: "width 0.3s ease, background 0.3s ease",
                }}
              />
            </div>
          </div>

          <div className="studio-btn-group">
            <button
              className="studio-btn btn-primary"
              onClick={() => consumeTokens(1)}
            >
              <Check size={16} /> 1 Request
            </button>
            <button
              className="studio-btn btn-secondary"
              onClick={() => consumeTokens(5)}
            >
              Burst (5 Calls)
            </button>
            <button
              className="studio-btn btn-danger"
              onClick={() => consumeTokens(12)}
            >
              <Flame size={16} /> Spam (12 Calls)
            </button>
            <button className="studio-btn btn-secondary" onClick={resetBucket}>
              <RefreshCcw size={16} /> Reset
            </button>
          </div>
        </div>

        <div className="studio-panel">
          <div
            style={{
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
              color: "#8b949e",
            }}
          >
            Traffic Stats & Rejection Inspector
          </div>
          <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
            <div
              style={{
                flex: 1,
                padding: "0.75rem",
                background: "rgba(35, 134, 54, 0.1)",
                borderRadius: "0.375rem",
                border: "1px solid #238636",
              }}
            >
              <div style={{ fontSize: "0.75rem", color: "#3fb950" }}>
                200 OK (Allowed)
              </div>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  color: "#3fb950",
                }}
              >
                {passedCount}
              </div>
            </div>
            <div
              style={{
                flex: 1,
                padding: "0.75rem",
                background: "rgba(218, 54, 51, 0.1)",
                borderRadius: "0.375rem",
                border: "1px solid #da3633",
              }}
            >
              <div style={{ fontSize: "0.75rem", color: "#f85149" }}>
                429 Rejected (Blocked)
              </div>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  color: "#f85149",
                }}
              >
                {rejectedCount}
              </div>
            </div>
          </div>

          {showProblemJson && (
            <div
              style={{
                background: "#0d1117",
                border: "1px solid #da3633",
                borderRadius: "0.375rem",
                padding: "0.75rem",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  color: "#f85149",
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  marginBottom: "0.4rem",
                }}
              >
                <ShieldAlert size={14} /> RFC 7807 Problem Details Response
                (HTTP 429)
              </div>
              <pre
                style={{
                  margin: 0,
                  fontSize: "0.75rem",
                  color: "#e6edf3",
                  overflowX: "auto",
                }}
              >
                {JSON.stringify(
                  {
                    type: "https://example.com/probs/rate-limit-exceeded",
                    title: "Rate Limit Exceeded",
                    status: 429,
                    detail: `Token bucket depleted. Capacity: ${bucketCapacity}, current tokens: ${tokens.toFixed(1)}. Please retry after 1s.`,
                    instance: "/api/v1/orders",
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: "1.5rem" }}>
        <h4
          style={{
            fontSize: "0.95rem",
            fontWeight: 600,
            marginBottom: "0.5rem",
            color: "#8b949e",
          }}
        >
          Polyglot Code Implementation
        </h4>
        <PolyglotCodeTabs snippets={snippets} />
      </div>
    </div>
  );
};
