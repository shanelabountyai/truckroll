"""Solve every fixture N times; print p95 wall ms per fixture as integers; exit 1 if any p95 >= 2000 (Phase 1 gate)."""

import json
import math
import sys
import time
from pathlib import Path

from contract import SolveRequest
from solve import solve

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "problems"
LIMIT_MS = 2000


def p95(samples: list[float]) -> int:
    s = sorted(samples)
    return math.ceil(s[max(0, math.ceil(0.95 * len(s)) - 1)])


def main(runs: int = 20) -> int:
    worst = 0
    print(f"fixture,runs,p95_ms,max_ms")
    for f in sorted(FIXTURES.glob("*.json")):
        fx = json.loads(f.read_text())
        req = SolveRequest.model_validate({"problem": fx["problem"], "timeLimitMs": fx.get("timeLimitMs", 2000)})
        samples = []
        for _ in range(runs):
            t0 = time.perf_counter()
            solve(req)
            samples.append((time.perf_counter() - t0) * 1000)
        q = p95(samples)
        worst = max(worst, q)
        print(f"{f.stem},{runs},{q},{math.ceil(max(samples))}")
    print(f"worst_p95_ms={worst} limit_ms={LIMIT_MS}")
    return 0 if worst < LIMIT_MS else 1


if __name__ == "__main__":
    sys.exit(main(int(sys.argv[1]) if len(sys.argv) > 1 else 20))
