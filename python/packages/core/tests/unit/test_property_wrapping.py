import pytest

from server_decorator import tracking_class
from server_decorator.tracker import global_tracker


def test_property_wrapping_default_ignores_properties():
    class Item:
        def __init__(self, val: int):
            self._val = val

        @property
        def val(self) -> int:
            return self._val

        def regular_method(self) -> int:
            return 42

    # Default wrap_properties=False
    Wrapped = tracking_class()(Item)
    item = Wrapped(10)
    assert item.val == 10
    assert item.regular_method() == 42


def test_property_wrapping_enabled_wraps_getter():
    class Item:
        def __init__(self, val: int):
            self._val = val

        @property
        def val(self) -> int:
            return self._val

        @val.setter
        def val(self, new_val: int) -> None:
            self._val = new_val

    Wrapped = tracking_class(wrap_properties=True)(Item)
    item = Wrapped(99)

    # Reading property works
    assert item.val == 99

    # Setting property works
    item.val = 100
    assert item.val == 100
