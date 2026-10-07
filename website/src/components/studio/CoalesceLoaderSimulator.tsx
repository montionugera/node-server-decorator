import React, { useState } from "react";
import {
  Layers,
  Database,
  User,
  ArrowDown,
  Sparkles,
  RefreshCw,
} from "lucide-react";
import { PolyglotCodeTabs } from "./PolyglotCodeTabs";
import "./studio.css";

interface UserCard {
  id: string;
  name: string;
  role: string;
}

export const CoalesceLoaderSimulator: React.FC = () => {
  const users: UserCard[] = [
    { id: "u_1", name: "Alice", role: "Admin" },
    { id: "u_2", name: "Bob", role: "Engineer" },
    { id: "u_3", name: "Carol", role: "Designer" },
    { id: "u_4", name: "Dave", role: "Support" },
  ];

  const [requestedIds, setRequestedIds] = useState<string[]>([]);
  const [batchesDispatched, setBatchesDispatched] = useState<string[][]>([]);
  const [totalClientRequests, setTotalClientRequests] = useState(0);

  const requestUser = (id: string) => {
    setTotalClientRequests((c) => c + 1);
    setRequestedIds((prev) => [...prev, id]);
  };

  const triggerAll = () => {
    // Simulates 8 concurrent calls from different parts of a GraphQL or REST request
    const ids = ["u_1", "u_2", "u_1", "u_3", "u_2", "u_4", "u_1", "u_3"];
    setTotalClientRequests((c) => c + ids.length);
    setRequestedIds((prev) => [...prev, ...ids]);
  };

  const flushBatch = () => {
    if (requestedIds.length === 0) return;
    const unique = Array.from(new Set(requestedIds));
    setBatchesDispatched((prev) => [[...unique], ...prev.slice(0, 5)]);
    setRequestedIds([]);
  };

  const resetAll = () => {
    setRequestedIds([]);
    setBatchesDispatched([]);
    setTotalClientRequests(0);
  };

  const totalBatches = batchesDispatched.length;
  const reductionPercent =
    totalClientRequests > 0
      ? Math.round(
          ((totalClientRequests - Math.max(1, totalBatches)) /
            totalClientRequests) *
            100,
        )
      : 0;

  const snippets = {
    typescript: `// TypeScript / Node
import { withBatchLoad } from '@montionugera/server-decorator';

// Microservice callers use standard single-fetch signature:
export const getUserById = withBatchLoad(async (ids: string[]) => {
  console.log('Fired single batched database query for:', ids);
  return await db.query('SELECT * FROM users WHERE id IN (?)', [ids]);
});

// Elsewhere in parallel resolvers:
const [u1, u2, u3] = await Promise.all([
  getUserById('u_1'),
  getUserById('u_2'),
  getUserById('u_1') // Deduped & coalesced!
]);`,
    python: `# Python
from server_decorator import batch_load

@batch_load
async def get_user_by_id(ids: list[str]):
    return await db.fetch_all("SELECT * FROM users WHERE id = ANY($1)", ids)`,
    go: `// Go
import "github.com/montionugera/node-server-decorator/go/core"

loader := core.NewBatchLoader(func(ctx context.Context, keys []string) ([]User, error) {
    return db.FindUsersByIDs(ctx, keys)
})
user1, _ := loader.Load(ctx, "u_1")
user2, _ := loader.Load(ctx, "u_2")`,
    nim: `// Nim
import server_decorator/coalesce

let loader = newBatchLoader(proc(ids: seq[string]): Future[seq[User]] {.async.} =
  return await db.queryUsers(ids)
)
let u1 = await loader.load("u_1")`,
    rust: `// Rust
use server_decorator_core::coalesce::CoalesceLoader;

let loader = CoalesceLoader::new(|ids: Vec<String>| async move {
    db::find_users_by_ids(&ids).await
});
let user1 = loader.load("u_1").await;`,
  };

  return (
    <div className="studio-card">
      <div className="studio-header">
        <h3 className="studio-title">
          <Layers size={22} color="#3fb950" /> Reactive Call Coalescing /
          DataLoader Simulator
        </h3>
        <span className="studio-badge badge-green">
          {reductionPercent > 0
            ? `${reductionPercent}% I/O Calls Saved`
            : "Ready"}
        </span>
      </div>

      <div className="studio-grid">
        <div className="studio-panel">
          <div
            style={{
              fontSize: "0.875rem",
              fontWeight: 600,
              marginBottom: "0.75rem",
              color: "#8b949e",
            }}
          >
            Click entities to simulate concurrent consumer requests:
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: "0.5rem",
              marginBottom: "1rem",
            }}
          >
            {users.map((u) => (
              <button
                key={u.id}
                className="studio-btn btn-secondary"
                style={{
                  justifyContent: "flex-start",
                  padding: "0.6rem 0.75rem",
                }}
                onClick={() => requestUser(u.id)}
              >
                <User size={16} color="#58a6ff" />
                <div style={{ textAlign: "left", lineHeight: 1.2 }}>
                  <div style={{ fontWeight: 600 }}>{u.name}</div>
                  <div style={{ fontSize: "0.7rem", color: "#8b949e" }}>
                    ID: {u.id}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="studio-btn-group">
            <button className="studio-btn btn-primary" onClick={triggerAll}>
              <Sparkles size={16} /> Burst 8 Concurrent Requests
            </button>
            <button
              className="studio-btn btn-accent"
              onClick={flushBatch}
              disabled={requestedIds.length === 0}
            >
              <ArrowDown size={16} /> Dispatch Microtask Batch (
              {requestedIds.length})
            </button>
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
            Batch Execution Inspector
          </div>

          <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem" }}>
            <div
              style={{
                flex: 1,
                padding: "0.6rem",
                background: "#0d1117",
                borderRadius: "0.375rem",
                border: "1px solid #21262d",
              }}
            >
              <div style={{ fontSize: "0.75rem", color: "#8b949e" }}>
                Client Function Calls
              </div>
              <div
                style={{
                  fontSize: "1.4rem",
                  fontWeight: 700,
                  color: "#e6edf3",
                }}
              >
                {totalClientRequests}
              </div>
            </div>
            <div
              style={{
                flex: 1,
                padding: "0.6rem",
                background: "#0d1117",
                borderRadius: "0.375rem",
                border: "1px solid #21262d",
              }}
            >
              <div style={{ fontSize: "0.75rem", color: "#3fb950" }}>
                Batched DB Queries
              </div>
              <div
                style={{
                  fontSize: "1.4rem",
                  fontWeight: 700,
                  color: "#3fb950",
                }}
              >
                {totalBatches}
              </div>
            </div>
          </div>

          {requestedIds.length > 0 && (
            <div
              style={{
                padding: "0.6rem",
                background: "rgba(210, 153, 34, 0.1)",
                border: "1px solid #bb8009",
                borderRadius: "0.375rem",
                marginBottom: "0.75rem",
                fontSize: "0.8rem",
                color: "#d29922",
              }}
            >
              Pending in Event Loop Microtask Tick: [{requestedIds.join(", ")}]
            </div>
          )}

          <div className="studio-log-box" style={{ maxHeight: "130px" }}>
            {batchesDispatched.length === 0 ? (
              <div style={{ fontStyle: "italic", color: "#8b949e" }}>
                No batches dispatched yet.
              </div>
            ) : (
              batchesDispatched.map((b, i) => (
                <div key={i} className="log-entry log-success">
                  <Database
                    size={12}
                    style={{ display: "inline", marginRight: "0.3rem" }}
                  />
                  SELECT * FROM users WHERE id IN (
                  {b.map((x) => `'${x}'`).join(", ")})
                </div>
              ))
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
