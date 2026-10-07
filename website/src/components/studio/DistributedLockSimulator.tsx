import React, { useState, useEffect, useRef } from "react";
import {
  Lock,
  Unlock,
  Heart,
  AlertOctagon,
  Play,
  StopCircle,
} from "lucide-react";
import { PolyglotCodeTabs } from "./PolyglotCodeTabs";
import "./studio.css";

export interface DistLockProps {
  initialTtlMs?: number;
}

export const DistributedLockSimulator: React.FC<DistLockProps> = ({
  initialTtlMs = 3000,
}) => {
  const [ttlMs, setTtlMs] = useState(initialTtlMs);
  const [isHeld, setIsHeld] = useState(false);
  const [currentTtlRemaining, setCurrentTtlRemaining] = useState(0);
  const [worker2Blocked, setWorker2Blocked] = useState(false);
  const [watchdogAlive, setWatchdogAlive] = useState(true);
  const [renewPulses, setRenewPulses] = useState(0);
  const [logs, setLogs] = useState<string[]>([
    'Lock "lock:order:101" is currently idle in Redis.',
  ]);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const watchdogRef = useRef<NodeJS.Timeout | null>(null);

  const addLog = (msg: string) => {
    setLogs((prev) => [
      `[${new Date().toLocaleTimeString()}] ${msg}`,
      ...prev.slice(0, 15),
    ]);
  };

  const acquireLock = () => {
    if (isHeld) {
      addLog("Worker 1 already holds the lock.");
      return;
    }

    setIsHeld(true);
    setWatchdogAlive(true);
    setCurrentTtlRemaining(ttlMs);
    setRenewPulses(0);
    setWorker2Blocked(false);
    addLog(
      `Acquired lock token with initial TTL: ${ttlMs}ms. Heartbeat watchdog running every ${Math.floor(ttlMs / 3)}ms.`,
    );
  };

  // TTL decrement loop
  useEffect(() => {
    if (isHeld) {
      intervalRef.current = setInterval(() => {
        setCurrentTtlRemaining((prev) => {
          if (prev <= 100) {
            clearInterval(intervalRef.current!);
            setIsHeld(false);
            addLog("LOCK EXPIRED! TTL hit 0 (watchdog was stopped or lost).");
            return 0;
          }
          return prev - 100;
        });
      }, 100);

      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }
  }, [isHeld]);

  // Watchdog renewal pulse loop
  useEffect(() => {
    if (isHeld && watchdogAlive) {
      const renewPeriod = Math.floor(ttlMs / 3);
      watchdogRef.current = setInterval(() => {
        setCurrentTtlRemaining(ttlMs);
        setRenewPulses((p) => p + 1);
        addLog(
          `Watchdog pulse: evaluated RENEW_LOCK_LUA in Redis. Extended TTL back to ${ttlMs}ms.`,
        );
      }, renewPeriod);

      return () => {
        if (watchdogRef.current) clearInterval(watchdogRef.current);
      };
    }
  }, [isHeld, watchdogAlive, ttlMs]);

  const killWatchdog = () => {
    setWatchdogAlive(false);
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    addLog(
      "SIMULATION: Worker process hung / watchdog crashed! Watchdog stopped. Lock will expire when remaining TTL hits 0.",
    );
  };

  const tryWorker2 = () => {
    if (isHeld) {
      setWorker2Blocked(true);
      addLog(
        'Worker 2 attempted SET NX PX "lock:order:101" -> REJECTED: LockAcquisitionError (Contention)!',
      );
      setTimeout(() => setWorker2Blocked(false), 2000);
    } else {
      addLog(
        "Worker 2 attempted acquisition -> SUCCESS! Lock acquired by Worker 2.",
      );
    }
  };

  const releaseLock = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (watchdogRef.current) clearInterval(watchdogRef.current);
    setIsHeld(false);
    setCurrentTtlRemaining(0);
    setWatchdogAlive(true);
    addLog("Evaluated RELEASE_LOCK_LUA in Redis. Lock cleanly released.");
  };

  const snippets = {
    typescript: `// TypeScript / Node
import { withDistributedLock, LockAcquisitionError } from '@montionugera/server-decorator';

const processOrder = withDistributedLock('lock:order:101', async (orderId: string) => {
  // Watchdog automatically extends lock TTL while this async function runs!
  await performHeavyComputation();
  return { status: 'processed' };
}, {
  ttlMs: ${ttlMs},
  autoRenew: true,
  waitTimeoutMs: 500 // Fail fast or wait
});`,
    python: `# Python
from server_decorator import distributed_lock

@distributed_lock("lock:order:101", ttl_ms=${ttlMs}, auto_renew=True)
async def process_order(order_id: str):
    await heavy_computation()`,
    go: `// Go
import "github.com/montionugera/node-server-decorator/go/core"

err := lockManager.WithDistributedLock(ctx, "lock:order:101", core.LockOptions{
    TTL:       ${ttlMs} * time.Millisecond,
    AutoRenew: true,
}, func() error {
    return processOrder(orderId)
})`,
    nim: `// Nim
import server_decorator/distlock

withLock("lock:order:101", ttlMs = ${ttlMs}, autoRenew = true):
  processOrder(orderId)`,
    rust: `// Rust
use server_decorator_core::distlock::{with_distributed_lock, LockOptions};

let res = with_distributed_lock("lock:order:101", LockOptions {
    ttl: Duration::from_millis(${ttlMs}),
    auto_renew: true,
}, || async {
    process_order(order_id).await
}).await;`,
  };

  return (
    <div className="studio-card">
      <div className="studio-header">
        <h3 className="studio-title">
          <Lock size={22} color="#f0883e" /> Distributed Lock & Watchdog
          Simulator
        </h3>
        <span
          className={`studio-badge ${isHeld ? "badge-amber" : "badge-green"}`}
        >
          {isHeld ? "Lock Held" : "Lock Free"}
        </span>
      </div>

      <div className="studio-grid">
        <div className="studio-panel">
          <div className="studio-controls">
            <div className="studio-control-row">
              <span className="studio-control-label">Lock Base TTL (ms):</span>
              <input
                type="number"
                min="1000"
                step="500"
                max="10000"
                className="studio-input"
                value={ttlMs}
                onChange={(e) => setTtlMs(Number(e.target.value))}
              />
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">Watchdog Interval:</span>
              <span style={{ fontSize: "0.85rem", color: "#58a6ff" }}>
                Every ~{Math.floor(ttlMs / 3)}ms (TTL / 3)
              </span>
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
              <span>Remaining TTL:</span>
              <strong>{currentTtlRemaining}ms</strong>
            </div>
            <div
              style={{
                width: "100%",
                height: "14px",
                background: "#21262d",
                borderRadius: "9999px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${(currentTtlRemaining / ttlMs) * 100}%`,
                  height: "100%",
                  background: isHeld ? "#f0883e" : "#238636",
                  transition: "width 0.1s linear",
                }}
              />
            </div>
            {isHeld && watchdogAlive && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  color: "#3fb950",
                  fontSize: "0.8rem",
                  marginTop: "0.5rem",
                }}
              >
                <Heart size={14} className="pulse" /> Watchdog active:{" "}
                {renewPulses} renewals sent to Redis
              </div>
            )}
          </div>

          <div className="studio-btn-group">
            {!isHeld ? (
              <button className="studio-btn btn-primary" onClick={acquireLock}>
                <Play size={16} /> Acquire Lock (Worker 1)
              </button>
            ) : (
              <>
                <button
                  className="studio-btn btn-secondary"
                  onClick={releaseLock}
                >
                  <Unlock size={16} /> Release Lock
                </button>
                {watchdogAlive && (
                  <button
                    className="studio-btn btn-danger"
                    onClick={killWatchdog}
                  >
                    <AlertOctagon size={16} /> Simulate Worker Crash
                  </button>
                )}
              </>
            )}
            <button
              className={`studio-btn ${worker2Blocked ? "btn-danger" : "btn-accent"}`}
              onClick={tryWorker2}
            >
              <StopCircle size={16} /> Worker 2: Try Acquire
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
            Distributed Lock Events
          </div>
          <div className="studio-log-box">
            {logs.map((msg, i) => (
              <div
                key={i}
                className="log-entry"
                style={{
                  color: msg.includes("REJECTED")
                    ? "#f85149"
                    : msg.includes("pulse")
                      ? "#3fb950"
                      : "#c9d1d9",
                }}
              >
                {msg}
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
