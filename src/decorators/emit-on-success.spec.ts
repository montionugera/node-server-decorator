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

    @EmitOnSuccess({transform: (res) => ({greeting: res})})
    transformedMethod(data: string) {
        return `Hello, ${data}`
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

        expect(result).toBe('Hello, John')
        expect(globalEmitter.emit).toHaveBeenCalledTimes(1)
        expect(globalEmitter.emit).toHaveBeenCalledWith(
            'ExampleService.syncMethod',
            'Hello, John'
        )
    })

    it('should emit event for async method', async () => {
        const result = await service.asyncMethod('Jane')

        expect(result).toBe('Hello, Jane')
        expect(globalEmitter.emit).toHaveBeenCalledTimes(1)
        expect(globalEmitter.emit).toHaveBeenCalledWith(
            'ExampleService.asyncMethod',
            'Hello, Jane'
        )
    })

    it('should apply transform before emitting', () => {
        const result = service.transformedMethod('Bob')

        expect(result).toBe('Hello, Bob')
        expect(globalEmitter.emit).toHaveBeenCalledTimes(1)
        expect(globalEmitter.emit).toHaveBeenCalledWith(
            'ExampleService.transformedMethod',
            {greeting: 'Hello, Bob'}
        )
    })
})
