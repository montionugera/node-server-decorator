import sys
from pathlib import Path

from server_decorator_entity import entity_spec
from server_decorator_entity.canonical import canonical_json
from server_decorator_entity.testing.user_fixture import User

from server_decorator_gen_openapi import openapi_document

# emit_openapi.py -> scripts -> gen_openapi -> packages -> python -> repo root
version = (Path(__file__).resolve().parents[4] / "contracts/VERSION").read_text().strip()
sys.stdout.write(canonical_json(openapi_document([entity_spec(User)], version)))
