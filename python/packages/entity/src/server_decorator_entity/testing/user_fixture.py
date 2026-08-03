from typing import Annotated, Any

from server_decorator_entity import (
    Datetime,
    Email,
    EnumOf,
    Id,
    Int,
    ListOf,
    Obj,
    Str,
    action,
    restful,
)


@restful(path="users", transports=["rest", "rpc", "sse", "ws"])
class User:
    id: Annotated[str, Id()]
    email: Annotated[str, Email(filterable=True)]
    name: Annotated[str, Str(min=2, max=80)]
    status: Annotated[str, EnumOf("inactive", "active", "banned", filterable=True)]
    login_count: Annotated[int, Int(min=0, readonly=True)]
    tags: Annotated[list[str], ListOf(Str())]
    profile: Annotated[
        dict[str, Any] | None, Obj([("bio", Str(max=500, optional=True))], optional=True)
    ]
    birthday: Annotated[str | None, Datetime(optional=True, nullable=True)]

    @action(
        "activate",
        from_state="inactive",
        to_state="active",
        input=[("reason", Str(max=200, optional=True))],
    )
    def activate(self) -> None: ...

    @action("ping")
    def ping(self) -> None: ...


UserFixture = User
