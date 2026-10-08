// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import react from "@astrojs/react";

// https://astro.build/config
export default defineConfig({
  base: process.env.ASTRO_BASE || "/server-decorator",
  integrations: [
    react(),
    starlight({
      title: "server-decorator",
      description:
        "Polyglot microservices decorator library for Node/TypeScript, Python, Go, Nim, and Rust.",
      defaultLocale: "root",
      locales: {
        root: {
          label: "English",
          lang: "en",
        },
        th: {
          label: "ไทย",
          lang: "th",
        },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/montionugera/node-server-decorator",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Overview", slug: "getting-started/overview" },
            { label: "Quickstart", slug: "getting-started/quickstart" },
            { label: "Installation", slug: "getting-started/installation" },
          ],
        },
        {
          label: "Interactive Studio & Live Docs",
          items: [
            { label: "Interactive Studio Hub", slug: "studio" },
            { label: "Open Standalone Storybook ↗", link: "/storybook/" },
          ],
        },
        {
          label: "Core Decorators",
          items: [
            { label: "Caching (@cache)", slug: "core/cache" },
            { label: "Tracking (@tracking)", slug: "core/tracking" },
            {
              label: "Queue Emission (@EmitOnSuccess)",
              slug: "core/emit-on-success",
            },
            { label: "Real-Time SSE Streaming", slug: "core/sse" },
            { label: "Scoped Authorization", slug: "core/auth" },
            {
              label: "Resilience Suite (@retry, @circuit_breaker, @rate_limit)",
              slug: "core/resilience",
            },
            {
              label: "Reactive Call Coalescing (@batchLoad)",
              slug: "core/coalescing",
            },
            { label: "Adapters & Transports", slug: "core/adapters" },
          ],
        },
        {
          label: "Entity-Spec IR Layer",
          items: [
            { label: "EntitySpec Overview", slug: "entity-spec/overview" },
            { label: "Declaring Entities", slug: "entity-spec/declaration" },
          ],
        },
        {
          label: "Code Generators",
          items: [
            {
              label: "DTO Validation (Zod & Pydantic)",
              slug: "generators/dto-validation",
            },
            { label: "OpenAPI 3.1 Generation", slug: "generators/openapi" },
          ],
        },
        {
          label: "Architecture & Contracts",
          items: [
            {
              label: "Wire Contracts & Protocols",
              slug: "architecture/contracts",
            },
            { label: "Locked Decisions", slug: "architecture/decisions" },
            {
              label: "Architecture Decision Records (ADRs)",
              slug: "architecture/adrs",
            },
            {
              label: "v1 to v2 Migration Guide",
              slug: "architecture/migration",
            },
          ],
        },
        {
          label: "Contributing & Quality Gates",
          items: [
            {
              label: "Contributor Guidelines",
              slug: "contributing/guidelines",
            },
            {
              label: "Adding a New Language Lane",
              slug: "contributing/adding-a-language",
            },
          ],
        },
      ],
    }),
  ],
});
