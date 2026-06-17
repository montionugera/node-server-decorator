import {
  ConsumerRegistry,
  EventHandler,
  globalConsumerRegistry,
} from './consumer-registry'

interface OnEventOptions {
  consumer?: string
  registry?: ConsumerRegistry
}

interface PendingHandler {
  eventName: string
  propertyKey: string
  options: OnEventOptions
}

const PENDING = Symbol('server-decorator.onEvent.pending')

// @OnEvent records the binding on the prototype; registerHandlers(instance) wires the
// bound methods into the registry. Handlers are opt-in by decoration (no class walk).
export function OnEvent(eventName: string, options: OnEventOptions = {}) {
  return function (
    target: any,
    propertyKey: string,
    _descriptor: PropertyDescriptor,
  ): void {
    const list: PendingHandler[] = target[PENDING] || (target[PENDING] = [])
    list.push({ eventName, propertyKey, options })
  }
}

export function registerHandlers(instance: any): void {
  const proto = Object.getPrototypeOf(instance)
  const list: PendingHandler[] = proto[PENDING] || []
  for (const { eventName, propertyKey, options } of list) {
    const registry = options.registry ?? globalConsumerRegistry
    const handler: EventHandler = (payload, metadata) =>
      instance[propertyKey](payload, metadata)
    registry.on(eventName, handler, { consumer: options.consumer })
  }
}
