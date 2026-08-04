import {
  RedisStreamConsumer,
  KafkaConsumer,
  RabbitMQConsumer,
  BullMQConsumer,
} from '../index'

describe('consumer exports', () => {
  it('all consumer classes are exported from the package root', () => {
    expect(typeof RedisStreamConsumer).toBe('function')
    expect(typeof KafkaConsumer).toBe('function')
    expect(typeof RabbitMQConsumer).toBe('function')
    expect(typeof BullMQConsumer).toBe('function')
  })
})
