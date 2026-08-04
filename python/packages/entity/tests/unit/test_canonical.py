from server_decorator_entity.canonical import canonical_json


def test_sorts_keys_no_whitespace() -> None:
    result = canonical_json({"b": 1, "a": {"d": [2, 1], "c": "x"}})
    assert result == '{"a":{"c":"x","d":[2,1]},"b":1}'


def test_non_ascii_not_escaped() -> None:
    assert canonical_json({"a": "ราคา"}) == '{"a":"ราคา"}'
