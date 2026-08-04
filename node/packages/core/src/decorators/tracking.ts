import {globalTracker} from "../tracker";
import {globalLogger} from "../logger";

export function tracking(
  target: any,
  propertyKey: string,
  descriptor: PropertyDescriptor
) {
  const originalMethod = descriptor.value

  descriptor.value = async function (...args: any[]) {
    const start = Date.now()
    let result: any
    let isError = false
    let foundError:Error | null = null
    try {
      result = await originalMethod.apply(this, args)
    } catch (error) {
      foundError = error as Error
      isError = true
      throw error
    } finally {
      const latency = Date.now() - start
      const key = `${target.constructor.name}.${propertyKey}`
      if (isError) {
        globalLogger.error(
            `[Tracking] ${key} - Latency: ${latency}ms, Error: ${foundError}`
        )
      }
      globalTracker.track(
          key,latency,isError
      )
    }

    return result
  }

  return descriptor
}
