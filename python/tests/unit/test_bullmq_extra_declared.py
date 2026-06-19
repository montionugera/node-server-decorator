from pathlib import Path

import tomllib


def test_bullmq_extra_present() -> None:
    pyproject = tomllib.loads((Path(__file__).resolve().parents[2] / "pyproject.toml").read_text())
    extras = pyproject["project"]["optional-dependencies"]
    assert "bullmq" in extras, "missing [project.optional-dependencies] bullmq extra"
    assert any("bullmq" in dep for dep in extras["bullmq"])
    assert any("bullmq" in dep for dep in extras["all"])
