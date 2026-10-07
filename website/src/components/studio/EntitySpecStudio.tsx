import React, { useState } from "react";
import {
  Box,
  Code,
  FileText,
  CheckSquare,
  Plus,
  Trash2,
  Globe,
} from "lucide-react";
import "./studio.css";

interface FieldItem {
  id: string;
  name: string;
  type: string;
  role?: string;
  format?: string;
  readonly?: boolean;
  required?: boolean;
}

export const EntitySpecStudio: React.FC = () => {
  const [entityName, setEntityName] = useState("User");
  const [entityPath, setEntityPath] = useState("users");
  const [activeOutputTab, setActiveOutputTab] = useState<
    "ir" | "openapi" | "dto" | "server"
  >("ir");

  const [fields, setFields] = useState<FieldItem[]>([
    {
      id: "1",
      name: "id",
      type: "str",
      role: "id",
      format: "uuid",
      readonly: true,
    },
    { id: "2", name: "email", type: "str", format: "email", required: true },
    { id: "3", name: "displayName", type: "str", required: true },
    { id: "4", name: "role", type: "enum", required: true },
    { id: "5", name: "loginCount", type: "int", readonly: true },
    { id: "6", name: "createdAt", type: "datetime", readonly: true },
  ]);

  const addField = () => {
    const newId = String(Date.now());
    setFields((prev) => [
      ...prev,
      {
        id: newId,
        name: `field${prev.length + 1}`,
        type: "str",
        required: false,
      },
    ]);
  };

  const removeField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
  };

  // Compile to Canonical EntitySpec IR
  const canonicalIR = {
    entity: entityName,
    path: entityPath,
    transports: ["rest"],
    fields: fields.map((f) => {
      const fieldObj: any = { name: f.name, type: f.type };
      if (f.role) fieldObj.role = f.role;
      if (f.format) fieldObj.format = f.format;
      if (f.readonly) fieldObj.readonly = true;
      if (!f.required && !f.readonly) fieldObj.optional = true;
      if (f.type === "enum") fieldObj.values = ["admin", "member", "guest"];
      return fieldObj;
    }),
    actions: [
      { name: "activate", desc: "Activate user account" },
      { name: "archive", desc: "Archive user record" },
    ],
  };

  // Compile to OpenAPI 3.1
  const openApiDoc = {
    openapi: "3.1.0",
    info: { title: `${entityName} Service API`, version: "2.0.17" },
    paths: {
      [`/${entityPath}`]: {
        get: {
          summary: `List ${entityName}s`,
          responses: { "200": { description: "Success" } },
        },
        post: {
          summary: `Create ${entityName}`,
          responses: { "201": { description: "Created" } },
        },
      },
      [`/${entityPath}/{id}`]: {
        get: {
          summary: `Get ${entityName} by ID`,
          responses: { "200": { description: "Found" } },
        },
        patch: {
          summary: `Update ${entityName}`,
          responses: { "200": { description: "Updated" } },
        },
        delete: {
          summary: `Delete ${entityName}`,
          responses: { "204": { description: "Deleted" } },
        },
      },
    },
    components: {
      schemas: {
        [`${entityName}Read`]: {
          type: "object",
          properties: Object.fromEntries(
            fields.map((f) => [
              f.name,
              {
                type: f.type === "int" ? "integer" : "string",
                format: f.format,
              },
            ]),
          ),
        },
      },
    },
  };

  const dtoCode = `// Generated TypeScript Zod DTO
import { z } from 'zod';

export const ${entityName}CreateSchema = z.object({
${fields
  .filter((f) => !f.readonly)
  .map(
    (f) =>
      `  ${f.name}: z.${f.type === "int" ? "number().int()" : "string()"}${f.format === "email" ? ".email()" : ""}${!f.required ? ".optional()" : ""},`,
  )
  .join("\n")}
});

export const ${entityName}UpdateSchema = ${entityName}CreateSchema.partial();
export type ${entityName}CreateDTO = z.infer<typeof ${entityName}CreateSchema>;`;

  const serverMountCode = `// Multi-Framework Mount Code
// 1. Express (Node):
import { mountExpressRoutes } from '@montionugera/server-decorator/express';
mountExpressRoutes(app, ${entityName}Spec, new ${entityName}Service());

// 2. FastAPI (Python):
# mount_fastapi_routes(router, ${entityName}Spec, ${entityName}Service())

// 3. Gin (Go):
// ginadapter.Mount(router, ${entityName}Spec, ${entityName}Handler)

// 4. Axum (Rust):
// let app = Router::new().merge(mount_entity_routes::<${entityName}Handler>(spec));`;

  return (
    <div className="studio-card">
      <div className="studio-header">
        <h3 className="studio-title">
          <Box size={22} color="#58a6ff" /> EntitySpec Studio & Polyglot
          Compiler
        </h3>
        <span className="studio-badge badge-blue">
          Interactive Schema Studio
        </span>
      </div>

      <div className="studio-grid">
        <div className="studio-panel">
          <div className="studio-controls" style={{ marginBottom: "1rem" }}>
            <div className="studio-control-row">
              <span className="studio-control-label">Entity Name:</span>
              <input
                type="text"
                className="studio-input"
                value={entityName}
                onChange={(e) => setEntityName(e.target.value)}
              />
            </div>
            <div className="studio-control-row">
              <span className="studio-control-label">REST API Path:</span>
              <input
                type="text"
                className="studio-input"
                value={entityPath}
                onChange={(e) => setEntityPath(e.target.value)}
              />
            </div>
          </div>

          <div
            style={{
              fontSize: "0.85rem",
              fontWeight: 600,
              marginBottom: "0.5rem",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <span>Entity Fields ({fields.length}):</span>
            <button
              className="studio-btn btn-secondary"
              style={{ padding: "0.2rem 0.5rem", fontSize: "0.75rem" }}
              onClick={addField}
            >
              <Plus size={12} /> Add Field
            </button>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.4rem",
              maxHeight: "220px",
              overflowY: "auto",
            }}
          >
            {fields.map((f) => (
              <div
                key={f.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.5rem",
                  background: "#0d1117",
                  padding: "0.4rem 0.6rem",
                  borderRadius: "0.375rem",
                  border: "1px solid #21262d",
                  fontSize: "0.8rem",
                }}
              >
                <input
                  type="text"
                  className="studio-input"
                  style={{ width: "90px", padding: "0.2rem 0.4rem" }}
                  value={f.name}
                  onChange={(e) => {
                    const val = e.target.value;
                    setFields((prev) =>
                      prev.map((item) =>
                        item.id === f.id ? { ...item, name: val } : item,
                      ),
                    );
                  }}
                />
                <select
                  className="studio-input"
                  style={{ padding: "0.2rem 0.4rem" }}
                  value={f.type}
                  onChange={(e) => {
                    const val = e.target.value;
                    setFields((prev) =>
                      prev.map((item) =>
                        item.id === f.id ? { ...item, type: val } : item,
                      ),
                    );
                  }}
                >
                  <option value="str">str</option>
                  <option value="int">int</option>
                  <option value="bool">bool</option>
                  <option value="datetime">datetime</option>
                  <option value="enum">enum</option>
                </select>
                {f.readonly ? (
                  <span
                    className="studio-badge badge-amber"
                    style={{ fontSize: "0.65rem" }}
                  >
                    readonly
                  </span>
                ) : f.required ? (
                  <span
                    className="studio-badge badge-blue"
                    style={{ fontSize: "0.65rem" }}
                  >
                    required
                  </span>
                ) : (
                  <span style={{ fontSize: "0.7rem", color: "#8b949e" }}>
                    optional
                  </span>
                )}
                {fields.length > 1 && (
                  <button
                    onClick={() => removeField(f.id)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: "#8b949e",
                      cursor: "pointer",
                      marginLeft: "auto",
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="studio-panel">
          <div className="polyglot-tabs-header">
            <button
              className={`polyglot-tab-btn ${activeOutputTab === "ir" ? "active" : ""}`}
              onClick={() => setActiveOutputTab("ir")}
            >
              <FileText
                size={12}
                style={{ display: "inline", marginRight: "0.3rem" }}
              />{" "}
              Canonical IR
            </button>
            <button
              className={`polyglot-tab-btn ${activeOutputTab === "openapi" ? "active" : ""}`}
              onClick={() => setActiveOutputTab("openapi")}
            >
              <Globe
                size={12}
                style={{ display: "inline", marginRight: "0.3rem" }}
              />{" "}
              OpenAPI 3.1
            </button>
            <button
              className={`polyglot-tab-btn ${activeOutputTab === "dto" ? "active" : ""}`}
              onClick={() => setActiveOutputTab("dto")}
            >
              <CheckSquare
                size={12}
                style={{ display: "inline", marginRight: "0.3rem" }}
              />{" "}
              DTO Validator
            </button>
            <button
              className={`polyglot-tab-btn ${activeOutputTab === "server" ? "active" : ""}`}
              onClick={() => setActiveOutputTab("server")}
            >
              <Code
                size={12}
                style={{ display: "inline", marginRight: "0.3rem" }}
              />{" "}
              REST Routers
            </button>
          </div>

          <pre className="polyglot-code-block" style={{ maxHeight: "250px" }}>
            <code>
              {activeOutputTab === "ir" && JSON.stringify(canonicalIR, null, 2)}
              {activeOutputTab === "openapi" &&
                JSON.stringify(openApiDoc, null, 2)}
              {activeOutputTab === "dto" && dtoCode}
              {activeOutputTab === "server" && serverMountCode}
            </code>
          </pre>
        </div>
      </div>
    </div>
  );
};
