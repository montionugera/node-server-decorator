// global-emitter.ts
//
// v2.0.0: dropped `@nestjs/event-emitter` (Decision #8). The exported `globalEmitter`
// is now an `eventemitter3` instance. The public surface (`.emit`, `.on`, `.off`) is
// unchanged; only the underlying type name changed. Migration: callers that imported
// the `EventEmitter2` type explicitly should switch to `import EventEmitter from 'eventemitter3'`.

import EventEmitter from 'eventemitter3'

export let globalEmitter: EventEmitter = new EventEmitter()

export function setGlobalEmitter(emitter: EventEmitter) {
    globalEmitter = emitter
}
