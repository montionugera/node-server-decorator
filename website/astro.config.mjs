// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'server-decorator',
			description: 'Polyglot microservices decorator library for Node/TypeScript, Python, Go, and Nim.',
			defaultLocale: 'root',
			locales: {
				root: {
					label: 'English',
					lang: 'en',
				},
				th: {
					label: 'ไทย',
					lang: 'th',
				},
			},
			social: [
				{
					icon: 'github',
					label: 'GitHub',
					href: 'https://github.com/montionugera/node-server-decorator',
				},
			],
			sidebar: [
				{
					label: 'Getting Started',
					items: [
						{ label: 'Overview', slug: 'getting-started/overview' },
						{ label: 'Quickstart', slug: 'getting-started/quickstart' },
						{ label: 'Installation', slug: 'getting-started/installation' },
					],
				},
				{
					label: 'Core Decorators',
					items: [
						{ label: 'Caching (@cache)', slug: 'core/cache' },
						{ label: 'Tracking (@tracking)', slug: 'core/tracking' },
						{ label: 'Queue Emission (@EmitOnSuccess)', slug: 'core/emit-on-success' },
						{ label: 'Adapters & Transports', slug: 'core/adapters' },
					],
				},
				{
					label: 'Entity-Spec IR Layer',
					items: [
						{ label: 'EntitySpec Overview', slug: 'entity-spec/overview' },
						{ label: 'Declaring Entities', slug: 'entity-spec/declaration' },
					],
				},
				{
					label: 'Code Generators',
					items: [
						{ label: 'DTO Validation (Zod & Pydantic)', slug: 'generators/dto-validation' },
						{ label: 'OpenAPI 3.1 Generation', slug: 'generators/openapi' },
					],
				},
				{
					label: 'Architecture & Contracts',
					items: [
						{ label: 'Wire Contracts & Protocols', slug: 'architecture/contracts' },
						{ label: 'Locked Decisions', slug: 'architecture/decisions' },
						{ label: 'Architecture Decision Records (ADRs)', slug: 'architecture/adrs' },
						{ label: 'v1 to v2 Migration Guide', slug: 'architecture/migration' },
					],
				},
				{
					label: 'Contributing & Quality Gates',
					items: [
						{ label: 'Contributor Guidelines', slug: 'contributing/guidelines' },
						{ label: 'Adding a New Language Lane', slug: 'contributing/adding-a-language' },
					],
				},
			],
		}),
	],
});
