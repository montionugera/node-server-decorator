def test_all_consumers_importable_from_top_level() -> None:
    from server_decorator import (
        BullMQConsumer,
        KafkaConsumer,
        RabbitMQConsumer,
        RedisStreamConsumer,
    )

    assert KafkaConsumer is not None
    assert RabbitMQConsumer is not None
    assert BullMQConsumer is not None
    assert RedisStreamConsumer is not None
