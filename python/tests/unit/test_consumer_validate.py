from server_decorator.consumer.validate import InvalidEnvelope, validate_envelope


def test_valid_envelope_returns_payload_and_metadata() -> None:
    raw = {
        "eventName": "UserService.create",
        "payload": {"id": 1},
        "timestamp": 1746748800000,
        "metadata": {"service": "user-svc"},
    }
    event_name, payload, metadata = validate_envelope(raw)
    assert event_name == "UserService.create"
    assert payload == {"id": 1}
    assert metadata == {"service": "user-svc"}


def test_missing_event_name_raises() -> None:
    try:
        validate_envelope({"payload": 1, "timestamp": 0})
    except InvalidEnvelope as e:
        assert "eventName" in str(e)
    else:
        raise AssertionError("expected InvalidEnvelope")


def test_non_dict_raises() -> None:
    try:
        validate_envelope("not-a-dict")
    except InvalidEnvelope:
        pass
    else:
        raise AssertionError("expected InvalidEnvelope")


def test_boolean_timestamp_raises() -> None:
    try:
        validate_envelope({"eventName": "A.x", "payload": 1, "timestamp": True})
    except InvalidEnvelope as e:
        assert "timestamp" in str(e)
    else:
        raise AssertionError("expected InvalidEnvelope")


def test_null_metadata_defaults_to_empty() -> None:
    _, _, metadata = validate_envelope(
        {"eventName": "A.x", "payload": 1, "timestamp": 1, "metadata": None}
    )
    assert metadata == {}


def test_non_dict_metadata_raises() -> None:
    try:
        validate_envelope({"eventName": "A.x", "payload": 1, "timestamp": 1, "metadata": [1, 2]})
    except InvalidEnvelope as e:
        assert "metadata" in str(e)
    else:
        raise AssertionError("expected InvalidEnvelope")
