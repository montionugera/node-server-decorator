import React, { useState, useEffect, useRef } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  RefreshCw,
  Zap,
} from "lucide-react";
import { PolyglotCodeTabs } from "./PolyglotCodeTabs";
import "./studio.css";

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface LogEntry {
  id: string;
  time: string;
  type: "success" | "fail" | "warn" | "info";
  message: string;
}

export interface CircuitBreakerProps {
  failureThreshold?: number;
  resetTimeoutMs?: number;
  trialSuccesses?: number;
}

export const CircuitBreakerSimulator: React.FC<CircuitBreakerProps> = ({
  failureThreshold = 3,
  resetTimeoutMs = 3000,
  trialSuccesses = 2,
}) => {
  const [threshold, setThreshold] = useState(failureThreshold);
  const [timeoutMs, setTimeoutMs] = useState(resetTimeoutMs);
  const [trialsNeeded, setTrialsNeeded] = useState(trialSuccesses);

  const [state, setState] = useState<CircuitState>("CLOSED");
  const [failureCount, setFailureCount] = useState(0);
  const [trialSuccessCount, setTrialSuccessCount] = useState(0);
  const [remainingTime, setRemainingTime] = useState(0);
  const [logs, setLogs] = useState<LogEntry[]>([
    {
      id: "init",
      time: new Date().toLocaleTimeString(),
      type: "info",
      message: "Circuit initialized in CLOSED state. Monitoring service calls.",
    },
  ]);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const addLog = (type: LogEntry["type"], message: string) => {
    setLogs((prev) => [
      {
        id: Math.random().toString(36).substring(2, 9),
        time: new Date().toLocaleTimeString(),
        type,
        message,
      },
      ...prev.slice(0, 19),
    ]);
  };

  useEffect(() => {
    if (state === "OPEN") {
      setRemainingTime(Math.ceil(timeoutMs / 1000));
      const interval = setInterval(() => {
        setRemainingTime((prev) => {
          if (prev <= 1) {
            clearInterval(interval);
            setState("HALF_OPEN");
            setTrialSuccessCount(0);
            addLog(
              "warn",
              "Reset timeout expired. Transitioned to HALF-OPEN state (trial mode).",
            );
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      timerRef.current = interval;
      return () => clearInterval(interval);
    }
  }, [state, timeoutMs]);

  const triggerSuccess = () => {
    if (state === "OPEN") {
      addLog(
        "fail",
        "Blocked: CircuitBreakerOpenError! Call rejected immediately (fast failure).",
      );
      return;
    }

    if (state === "HALF_OPEN") {
      const nextSuccess = trialSuccessCount + 1;
      setTrialSuccessCount(nextSuccess);
      addLog(
        "success",
        `Trial canary call succeeded (${nextSuccess}/${trialsNeeded}).`,
      );

      if (nextSuccess >= trialsNeeded) {
        setState("CLOSED");
        setFailureCount(0);
        setTrialSuccessCount(0);
        addLog(
          "success",
          "Health verified! Circuit recovered and transitioned to CLOSED state.",
        );
      }
    } else {
      addLog("success", "Call succeeded (200 OK). Circuit remains CLOSED.");
    }
  };

  const triggerFailure = () => {
    if (state === "OPEN") {
      addLog(
        "fail",
        "Blocked: CircuitBreakerOpenError! Downstream is protected from further load.",
      );
      return;
    }

    if (state === "HALF_OPEN") {
      setState("OPEN");
      setTrialSuccessCount(0);
      addLog(
        "fail",
        "Trial call failed! Canary tripped; circuit immediately reopened to OPEN state.",
      );
      return;
    }

    const nextCount = failureCount + 1;
    setFailureCount(nextCount);
    addLog(
      "fail",
      `Call failed with 500 error (${nextCount}/${threshold} threshold).`,
    );

    if (nextCount >= threshold) {
      setState("OPEN");
      setFailureCount(0);
      addLog(
        "warn",
        `Threshold reached (${threshold} errors)! Circuit TRIPPED to OPEN state.`,
      );
    }
  };

  const fastForward = () => {
    if (state === "OPEN") {
      if (timerRef.current) clearInterval(timerRef.current);
      setRemainingTime(0);
      setState("HALF_OPEN");
      setTrialSuccessCount(0);
      addLog(
        "info",
        "Fast-forwarded timeout. Circuit transitioned to HALF-OPEN.",
      );
    }
  };

  const resetAll = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    setState("CLOSED");
    setFailureCount(0);
    setTrialSuccessCount(0);
    setRemainingTime(0);
    addLog("info", "Manual reset applied: Circuit forced to CLOSED.");
  };

  const stateBadgeClass =
    state === "CLOSED"
      ? "badge-green"
      : state === "OPEN"
        ? "badge-red"
        : "badge-amber";

  const snippets = {
    typescript: `// TypeScript / Node
import { withCircuitBreaker, CircuitBreakerOpenError } from '@montionugera/server-decorator';

const resilientFetch = withCircuitBreaker(async (id: string) => {
  return await fetchUserFromRemote(id);
}, {
  threshold: ${threshold},
  resetTimeoutMs: ${timeoutMs},
  fallback: () => ({ id: 'fallback', name: 'Cached User' })
});`,
    python: `# Python
from server_decorator import circuit_breaker, CircuitBreakerOpenError

@circuit_breaker(threshold=${threshold}, reset_timeout_ms=${timeoutMs})
async def fetch_user(user_id: str):
    return await remote_service.get(user_id)`,
    go: `// Go
import "github.com/montionugera/node-server-decorator/go/core"

cb := core.NewCircuitBreaker(core.CircuitBreakerOptions{
    FailureThreshold: ${threshold},
    ResetTimeout:     ${timeoutMs} * time.Millisecond,
})
res, err := cb.Execute(ctx, func() (any, error) {
    return fetchUser(id)
})`,
    nim: `// Nim
import server_decorator/resilience

let cb = newCircuitBreaker(
  threshold = ${threshold},
  resetTimeoutMs = ${timeoutMs}
)
let result = cb.protect:
  fetchUser(id)`,
    rust: `// Rust (Axum / Core)
use server_decorator_core::circuit_breaker::{CircuitBreaker, CircuitBreakerOptions};

let cb = CircuitBreaker::new(CircuitBreakerOptions {
    threshold: ${threshold},
    reset_timeout: Duration::from_millis(${timeoutMs}),
});
let res = cb.call(|| async { fetch_user(id).await }).await;`,
  };

  return (
    <div className="studio-card">
      <div className="studio-header">
        <h3 className="studio-title">
          <Activity size={22} color="#58a6ff" /> Circuit Breaker Interactive
          Simulator
        </h3>
        <span className={`studio-badge ${stateBadgeClass}`}>
          State: {state}
        </span>
      </div>

      <div className="studio-grid">
        <div className="studio-panel">
          <div className="studio-controls">
            <div className="studio-control-row">
              <span className="studio-control-label">Failure Threshold:</span>
              <input
                type="number"
                min="1"
                max="10"
                className="studio-input"
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
              />
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">Reset Timeout (ms):</span>
              <input
                type="number"
                min="1000"
                step="500"
                max="10000"
                className="studio-input"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
              />
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">
                Trial Successes Required:
              </span>
              <input
                type="number"
                min="1"
                max="5"
                className="studio-input"
                value={trialsNeeded}
                onChange={(e) => setTrialsNeeded(Number(e.target.value))}
              />
            </div>
          </div>

          <div
            style={{
              marginTop: "1rem",
              padding: "0.75rem",
              background: "#0d1117",
              borderRadius: "0.375rem",
              border: "1px solid #21262d",
            }}
          >
            <div
              style={{
                fontSize: "0.85rem",
                marginBottom: "0.4rem",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>Failure Counter:</span>
              <strong
                style={{ color: failureCount > 0 ? "#f85149" : "#3fb950" }}
              >
                {failureCount} / {threshold}
              </strong>
            </div>
            {state === "OPEN" && (
              <div
                style={{
                  fontSize: "0.85rem",
                  display: "flex",
                  justifyContent: "space-between",
                  color: "#f85149",
                }}
              >
                <span>Cooldown Remaining:</span>
                <strong>{remainingTime}s</strong>
              </div>
            )}
            {state === "HALF_OPEN" && (
              <div
                style={{
                  fontSize: "0.85rem",
                  display: "flex",
                  justifyContent: "space-between",
                  color: "#d29922",
                }}
              >
                <span>Canary Successes:</span>
                <strong>
                  {trialSuccessCount} / {trialsNeeded}
                </strong>
              </div>
            )}
          </div>

          <div className="studio-btn-group">
            <button className="studio-btn btn-primary" onClick={triggerSuccess}>
              <CheckCircle size={16} /> Call (Success 200)
            </button>
            <button className="studio-btn btn-danger" onClick={triggerFailure}>
              <AlertTriangle size={16} /> Call (Error 500)
            </button>
            {state === "OPEN" && (
              <button className="studio-btn btn-accent" onClick={fastForward}>
                <Zap size={16} /> Skip Cooldown
              </button>
            )}
            <button className="studio-btn btn-secondary" onClick={resetAll}>
              <RefreshCw size={16} /> Reset
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
            Live Telemetry Log
          </div>
          <div className="studio-log-box">
            {logs.map((log) => (
              <div key={log.id} className={`log-entry log-${log.type}`}>
                <span style={{ opacity: 0.5, marginRight: "0.4rem" }}>
                  [{log.time}]
                </span>
                {log.message}
              </div>
            ))}
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
