import json
from pathlib import Path

import pytest

FIXTURES = sorted((Path(__file__).resolve().parents[2] / "fixtures" / "problems").glob("*.json"))


def load(path: Path) -> dict:
    return json.loads(path.read_text())


@pytest.fixture(params=FIXTURES, ids=lambda p: p.stem)
def fixture(request) -> dict:
    return load(request.param)
