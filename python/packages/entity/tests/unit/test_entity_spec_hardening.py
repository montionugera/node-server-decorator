"""Reviewer-confirmed hardening for entity_spec/@restful/@action (Task 9 fix round).

Findings:
1. entity_spec() must not return the live memoized dict (mutation-proof copy).
2. Undecorated subclass of a @restful base must not silently inherit the base's spec.
3. Field collection must be own-class only (no MRO re-collection in subclasses).
4. _camel()-computed wire names must be validated (format + collisions).
5. @action on a staticmethod/classmethod must raise, in either decorator order.
"""

from typing import Annotated

import pytest

from server_decorator_entity import Id, Str, action, entity_spec, entity_spec_canonical, restful
from server_decorator_entity.testing.user_fixture import UserFixture

# --- Finding 1: copy-on-read -------------------------------------------------


def test_entity_spec_returns_copy_not_live_reference() -> None:
    spec1 = entity_spec(UserFixture)
    spec1["entity"] = "Poisoned"
    spec1["fields"].append({"name": "poison", "type": "str"})

    spec2 = entity_spec(UserFixture)
    assert spec2["entity"] == "User"
    assert all(f.get("name") != "poison" for f in spec2["fields"])


def test_entity_spec_canonical_unaffected_by_prior_mutation_attempt() -> None:
    spec = entity_spec(UserFixture)
    spec["fields"] = []

    # entity_spec_canonical reads the internal stored spec, not the poisoned copy.
    assert '"fields":[]' not in entity_spec_canonical(UserFixture)


# --- Finding 2: undecorated subclass must not inherit base's spec via MRO ----


def test_undecorated_subclass_of_restful_base_raises() -> None:
    @restful(path="bases")
    class Base:
        id: Annotated[str, Id()]

    class Sub(Base):
        pass

    with pytest.raises(TypeError, match="not decorated with @restful"):
        entity_spec(Sub)


# --- Finding 3: field collection is own-class only, not MRO-wide ------------


def test_subclass_fields_do_not_inherit_base_fields() -> None:
    @restful(path="bases")
    class Base:
        id: Annotated[str, Id()]
        name: Annotated[str, Str()]

    @restful(path="subs")
    class Sub(Base):
        extra: Annotated[str, Str()]

    spec = entity_spec(Sub)
    assert [f["name"] for f in spec["fields"]] == ["extra"]


# --- Finding 4: wire-name validation -----------------------------------------


def test_leading_underscore_field_name_raises() -> None:
    with pytest.raises(ValueError, match="_private"):

        @restful(path="x")
        class Bad:
            _private: Annotated[str, Str()]


def test_colliding_wire_names_raise() -> None:
    with pytest.raises(ValueError, match="collides"):

        @restful(path="x")
        class Bad:
            foo_bar: Annotated[str, Str()]
            foo__bar: Annotated[str, Str()]


# --- Finding 5: @action on staticmethod/classmethod raises, either order ----


def test_action_then_staticmethod_raises_immediately() -> None:
    with pytest.raises(TypeError, match="static"):

        class Bad:
            @action("ping")
            @staticmethod
            def ping() -> None: ...


def test_staticmethod_then_action_raises_at_restful_time() -> None:
    with pytest.raises(TypeError, match="static"):

        @restful(path="x")
        class Bad:
            @staticmethod
            @action("ping")
            def ping() -> None: ...


def test_action_then_classmethod_raises_immediately() -> None:
    with pytest.raises(TypeError, match="class"):

        class Bad:
            @action("ping")
            @classmethod
            def ping(cls) -> None: ...


def test_classmethod_then_action_raises_at_restful_time() -> None:
    with pytest.raises(TypeError, match="class"):

        @restful(path="x")
        class Bad:
            @classmethod
            @action("ping")
            def ping(cls) -> None: ...
