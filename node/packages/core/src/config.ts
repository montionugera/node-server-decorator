// Library-level configuration: the optional service name used to prefix auto-topics
// and stamp metadata.service (contract 1.1.0).

let service: string | null = process.env.SERVER_DECORATOR_SERVICE || null

export function configure(options: { service: string | null }): void {
  service = options.service || null
}

export function getService(): string | null {
  return service
}
