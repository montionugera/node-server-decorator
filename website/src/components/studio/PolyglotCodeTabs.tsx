import React, { useState } from "react";
import "./studio.css";

export interface PolyglotSnippets {
  typescript: string;
  python: string;
  go: string;
  nim: string;
  rust: string;
}

interface PolyglotCodeTabsProps {
  snippets: PolyglotSnippets;
  initialLanguage?: keyof PolyglotSnippets;
}

export const PolyglotCodeTabs: React.FC<PolyglotCodeTabsProps> = ({
  snippets,
  initialLanguage = "typescript",
}) => {
  const [activeLang, setActiveLang] =
    useState<keyof PolyglotSnippets>(initialLanguage);

  const languages: {
    key: keyof PolyglotSnippets;
    label: string;
    badge: string;
  }[] = [
    { key: "typescript", label: "TypeScript", badge: "Node" },
    { key: "python", label: "Python", badge: "FastAPI" },
    { key: "go", label: "Go", badge: "Gin" },
    { key: "nim", label: "Nim", badge: "Stdlib" },
    { key: "rust", label: "Rust", badge: "Axum" },
  ];

  return (
    <div className="polyglot-container">
      <div className="polyglot-tabs-header">
        {languages.map((lang) => (
          <button
            key={lang.key}
            className={`polyglot-tab-btn ${activeLang === lang.key ? "active" : ""}`}
            onClick={() => setActiveLang(lang.key)}
          >
            {lang.label}{" "}
            <span style={{ opacity: 0.6, fontSize: "0.75rem" }}>
              ({lang.badge})
            </span>
          </button>
        ))}
      </div>
      <pre className="polyglot-code-block">
        <code>{snippets[activeLang]}</code>
      </pre>
    </div>
  );
};
