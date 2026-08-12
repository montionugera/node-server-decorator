import sys

from server_decorator_entity import entity_spec_canonical
from server_decorator_entity.testing.user_fixture import UserFixture

sys.stdout.write(entity_spec_canonical(UserFixture))
