import json
from pathlib import Path

from server_decorator.consumer.validate import validate_envelope

FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "contracts"
    / "fixtures"
    / "queue-message.valid-with-service.json"
)


def test_service_envelope_unwraps() -> None:
    raw = json.loads(FIXTURE.read_text())
    event_name, payload, metadata = validate_envelope(raw)
    assert event_name == "UserService.create"
    assert payload == {"userId": "u-1", "email": "a@example.com"}
    assert metadata["service"] == "user-svc"
    assert metadata["topic"] == "user-svc.UserService.create"
