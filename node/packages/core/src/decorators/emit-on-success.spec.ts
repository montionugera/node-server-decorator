// __tests__/emit-on-success.spec.ts

import {EmitOnSuccess} from "./emit-on-success";
import {globalEmitter} from "./global-emitter";

class ExampleService {
    @EmitOnSuccess()
    syncMethod(data: string) {
        return `Hello, ${data}`
    }

    @EmitOnSuccess()
    async asyncMethod(data: string) {
        return Promise.resolve(`Hello, ${data}`)
    }


    @EmitOnSuccess()
    syncMethodObj(data: string) {
        return {greeting: `Hello, ${data}`}
    }

    @EmitOnSuccess()
    async asyncMethodObj(data: string) {
        return Promise.resolve({greeting: `Hello, ${data}`})
    }

    @EmitOnSuccess({transform: (res) => ({greeting: res})})
    transformedMethod(data: string) {
        return `Hello, ${data}`
    }

    @EmitOnSuccess({transform: (res) => ({greeting: res.greeting})})
    transformedMethodObj(data: string) {
        return {greeting: `Hello, ${data}`}
    }
}

describe('EmitOnSuccess Decorator', () => {
    let service: ExampleService

    beforeEach(() => {
        service = new ExampleService()
        jest.spyOn(globalEmitter, 'emit')
    })

    afterEach(() => {
        jest.clearAllMocks()
    })

    it('should emit event for sync method', () => {
        const result = service.syncMethod('John')
        const result2 = service.syncMethodObj('Andy')

        expect({
            result,
            result2,
            emitCalls: (globalEmitter.emit as any).mock.calls
        }).toMatchInlineSnapshot(`
{
  "emitCalls": [
    [
      "ExampleService.syncMethod",
      "Hello, John",
    ],
    [
      "ExampleService.syncMethodObj",
      {
        "greeting": "Hello, Andy",
      },
    ],
  ],
  "result": "Hello, John",
  "result2": {
    "greeting": "Hello, Andy",
  },
}
`)
    })

    it('should emit event for async method', async () => {
        const result = await service.asyncMethod('Jane')
        const result2 = await service.asyncMethodObj('Jane')

        expect({
            result,
            result2,
            emitCalls: (globalEmitter.emit as any).mock.calls
        }).toMatchInlineSnapshot(`
{
  "emitCalls": [
    [
      "ExampleService.asyncMethod",
      "Hello, Jane",
    ],
    [
      "ExampleService.asyncMethodObj",
      {
        "greeting": "Hello, Jane",
      },
    ],
  ],
  "result": "Hello, Jane",
  "result2": {
    "greeting": "Hello, Jane",
  },
}
`)
    })

    it('should apply transform before emitting', () => {
        const result = service.transformedMethod('Bob')
        const result2 = service.transformedMethodObj('Bob')

        expect({
  result,
  result2,
  emitCalls: (globalEmitter.emit as any).mock.calls
}).toMatchInlineSnapshot(`
{
  "emitCalls": [
    [
      "ExampleService.transformedMethod",
      {
        "greeting": "Hello, Bob",
      },
    ],
    [
      "ExampleService.transformedMethodObj",
      {
        "greeting": "Hello, Bob",
      },
    ],
  ],
  "result": "Hello, Bob",
  "result2": {
    "greeting": "Hello, Bob",
  },
}
`)
    })
})
