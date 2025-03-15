// global-emitter.ts

import {EventEmitter2} from "@nestjs/event-emitter";

export let globalEmitter: EventEmitter2 = new EventEmitter2();

export function setGlobalEmitter(emitter: EventEmitter2) {
    globalEmitter = emitter
}
