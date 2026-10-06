import EventEmitter from 'eventemitter3'
import * as emitterModule from './global-emitter'
import { setGlobalEmitter } from './global-emitter'

describe('global-emitter module', () => {
  const original = emitterModule.globalEmitter

  afterEach(() => {
    setGlobalEmitter(original)
    original.removeAllListeners()
  })

  it('exports an eventemitter3 instance that delivers payloads to listeners', () => {
    expect(emitterModule.globalEmitter).toBeInstanceOf(EventEmitter)

    const received: unknown[] = []
    emitterModule.globalEmitter.on('evt', (p) => received.push(p))

    expect(emitterModule.globalEmitter.emit('evt', { a: 1 })).toBe(true)
    expect(emitterModule.globalEmitter.emit('nobody-listens', 1)).toBe(false)
    expect(received).toEqual([{ a: 1 }])
  })

  it('setGlobalEmitter swaps the live binding; events go to the new emitter only', () => {
    const oldHits: unknown[] = []
    const newHits: unknown[] = []
    original.on('evt', (p) => oldHits.push(p))

    const replacement = new EventEmitter()
    replacement.on('evt', (p) => newHits.push(p))
    setGlobalEmitter(replacement)

    expect(emitterModule.globalEmitter).toBe(replacement)
    emitterModule.globalEmitter.emit('evt', 'payload')

    expect(newHits).toEqual(['payload'])
    expect(oldHits).toEqual([])
  })

  it('restoring the original emitter keeps its previously registered listeners', () => {
    const hits: unknown[] = []
    original.on('evt', (p) => hits.push(p))

    setGlobalEmitter(new EventEmitter())
    setGlobalEmitter(original)

    expect(emitterModule.globalEmitter).toBe(original)
    emitterModule.globalEmitter.emit('evt', 2)
    expect(hits).toEqual([2])
  })
})
