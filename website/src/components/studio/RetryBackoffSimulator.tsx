import React, { useState } from "react";
import { RotateCw, CheckCircle, XCircle, Play, Sliders } from "lucide-react";
import { PolyglotCodeTabs } from "./PolyglotCodeTabs";
import "./studio.css";

interface AttemptLog {
  attempt: number;
  delayMs: number;
  status: "pending" | "success" | "failed";
  timestamp: string;
}

export interface RetrySimulatorProps {
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
}

export const RetryBackoffSimulator: React.FC<RetrySimulatorProps> = ({
  maxAttempts = 3,
  backoffMs = 200,
  maxBackoffMs = 2000,
}) => {
  const [attemptsMax, setAttemptsMax] = useState(maxAttempts);
  const [baseBackoff, setBaseBackoff] = useState(backoffMs);
  const [capBackoff, setCapBackoff] = useState(maxBackoffMs);
  const [jitterMode, setJitterMode] = useState<"none" | "full" | "equal">(
    "full",
  );
  const [succeedOn, setSucceedOn] = useState(3); // Attempt that succeeds, or > attemptsMax for fail

  const [isRunning, setIsRunning] = useState(false);
  const [attemptHistory, setAttemptHistory] = useState<AttemptLog[]>([]);
  const [totalTime, setTotalTime] = useState(0);

  const calculateDelay = (attempt: number): number => {
    const exp = Math.min(capBackoff, baseBackoff * Math.pow(2, attempt - 1));
    if (jitterMode === "none") return exp;
    if (jitterMode === "full") return Math.floor(Math.random() * exp);
    if (jitterMode === "equal")
      return Math.floor(exp / 2 + Math.random() * (exp / 2));
    return exp;
  };

  const runSimulation = async () => {
    setIsRunning(true);
    setAttemptHistory([]);
    setTotalTime(0);

    const startTime = Date.now();
    let currentAttempt = 1;

    while (currentAttempt <= attemptsMax) {
      const isSuccess = currentAttempt === succeedOn;

      const newEntry: AttemptLog = {
        attempt: currentAttempt,
        delayMs: 0,
        status: isSuccess ? "success" : "failed",
        timestamp: new Date().toLocaleTimeString(),
      };

      setAttemptHistory((prev) => [...prev, newEntry]);

      if (isSuccess) {
        break;
      }

      if (currentAttempt < attemptsMax) {
        const delay = calculateDelay(currentAttempt);
        newEntry.delayMs = delay;
        await new Promise((r) => setTimeout(r, Math.min(delay, 800))); // Scaled down for UI animation
      }

      currentAttempt++;
    }

    setTotalTime(Date.now() - startTime);
    setIsRunning(false);
  };

  const snippets = {
    typescript: `// TypeScript / Node
import { withRetry } from '@montionugera/server-decorator';

const resilientCall = withRetry(async (id: string) => {
  return await remoteRpcService(id);
}, {
  maxAttempts: ${attemptsMax},
  backoffMs: ${baseBackoff},
  maxBackoffMs: ${capBackoff},
  jitter: ${jitterMode !== "none"},
  retryIf: (err) => err.isTransient === true
});`,
    python: `# Python
from server_decorator import retry

@retry(max_attempts=${attemptsMax}, backoff_ms=${baseBackoff}, max_backoff_ms=${capBackoff})
async def remote_rpc(user_id: str):
    return await client.fetch(user_id)`,
    go: `// Go
import "github.com/montionugera/node-server-decorator/go/core"

res, err := core.Retry(ctx, core.RetryOptions{
    MaxAttempts:  ${attemptsMax},
    Backoff:      ${baseBackoff} * time.Millisecond,
    MaxBackoff:   ${capBackoff} * time.Millisecond,
    Jitter:       ${jitterMode !== "none"},
}, func() (any, error) {
    return remoteCall(id)
})`,
    nim: `// Nim
import server_decorator/resilience

let res = withRetry(
  maxAttempts = ${attemptsMax},
  backoffMs = ${baseBackoff},
  maxBackoffMs = ${capBackoff}
):
  remoteCall(id)`,
    rust: `// Rust
use server_decorator_core::retry::{with_retry, RetryOptions};

let opts = RetryOptions {
    max_attempts: ${attemptsMax},
    backoff: Duration::from_millis(${baseBackoff}),
    max_backoff: Duration::from_millis(${capBackoff}),
    jitter: ${jitterMode !== "none"},
};
let res = with_retry(opts, || async { remote_call(id).await }).await;`,
  };

  return (
    <div className="studio-card">
      <div className="studio-header">
        <h3 className="studio-title">
          <RotateCw size={22} color="#bc8cff" /> Exponential Backoff & Retry
          Simulator
        </h3>
        <span className="studio-badge badge-purple">Jitter: {jitterMode}</span>
      </div>

      <div className="studio-grid">
        <div className="studio-panel">
          <div className="studio-controls">
            <div className="studio-control-row">
              <span className="studio-control-label">Max Attempts:</span>
              <input
                type="number"
                min="1"
                max="10"
                className="studio-input"
                value={attemptsMax}
                onChange={(e) => setAttemptsMax(Number(e.target.value))}
              />
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">
                Initial Backoff (ms):
              </span>
              <input
                type="number"
                min="50"
                step="50"
                max="1000"
                className="studio-input"
                value={baseBackoff}
                onChange={(e) => setBaseBackoff(Number(e.target.value))}
              />
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">
                Max Backoff Cap (ms):
              </span>
              <input
                type="number"
                min="500"
                step="250"
                max="5000"
                className="studio-input"
                value={capBackoff}
                onChange={(e) => setCapBackoff(Number(e.target.value))}
              />
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">Jitter Strategy:</span>
              <select
                className="studio-input"
                value={jitterMode}
                onChange={(e) => setJitterMode(e.target.value as any)}
              >
                <option value="none">No Jitter (Deterministic)</option>
                <option value="full">Full Jitter (Random Uniform)</option>
                <option value="equal">
                  Equal Jitter (Half Base + Half Random)
                </option>
              </select>
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">Simulate Success On:</span>
              <select
                className="studio-input"
                value={succeedOn}
                onChange={(e) => setSucceedOn(Number(e.target.value))}
              >
                {Array.from({ length: attemptsMax }, (_, i) => i + 1).map(
                  (n) => (
                    <option key={n} value={n}>
                      Attempt #{n}
                    </option>
                  ),
                )}
                <option value={999}>Never (Exhaust All Attempts)</option>
              </select>
            </div>
          </div>

          <div className="studio-btn-group">
            <button
              className="studio-btn btn-primary"
              disabled={isRunning}
              onClick={runSimulation}
            >
              <Play size={16} />{" "}
              {isRunning ? "Retrying..." : "Run Retry Execution"}
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
            Attempt Timeline Visualizer
          </div>
          <div
            style={{
              minHeight: "160px",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            {attemptHistory.length === 0 ? (
              <div
                style={{
                  color: "#8b949e",
                  fontSize: "0.85rem",
                  fontStyle: "italic",
                  padding: "1rem 0",
                }}
              >
                Click &quot;Run Retry Execution&quot; to observe backoff delays
                and attempt resolution.
              </div>
            ) : (
              attemptHistory.map((item) => (
                <div
                  key={item.attempt}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0.5rem 0.75rem",
                    background:
                      item.status === "success"
                        ? "rgba(35, 134, 54, 0.15)"
                        : "rgba(218, 54, 51, 0.15)",
                    borderLeft: `4px solid ${item.status === "success" ? "#3fb950" : "#f85149"}`,
                    borderRadius: "0.25rem",
                    fontSize: "0.85rem",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.5rem",
                    }}
                  >
                    {item.status === "success" ? (
                      <CheckCircle size={16} color="#3fb950" />
                    ) : (
                      <XCircle size={16} color="#f85149" />
                    )}
                    <strong>Attempt #{item.attempt}</strong>
                  </div>
                  <div>
                    {item.delayMs > 0 && (
                      <span
                        style={{ color: "#d29922", marginRight: "0.75rem" }}
                      >
                        backoff delay: +{item.delayMs}ms
                      </span>
                    )}
                    <span
                      style={{
                        color:
                          item.status === "success" ? "#3fb950" : "#f85149",
                        fontWeight: 600,
                      }}
                    >
                      {item.status.toUpperCase()}
                    </span>
                  </div>
                </div>
              ))
            )}
            {totalTime > 0 && (
              <div
                style={{
                  marginTop: "0.5rem",
                  fontSize: "0.8rem",
                  color: "#58a6ff",
                  textAlign: "right",
                }}
              >
                Total simulated execution elapsed:{" "}
                <strong>{totalTime}ms</strong>
              </div>
            )}
          </div>
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
