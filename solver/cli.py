"""stdin -> stdout: `{"problem": ..., "timeLimitMs": ...}` (or a fixture file with `problem`) -> canonical plan JSON.

Same code path as POST /solve; the cross-language vitest drives the solver through this.
"""

import json
import sys

from contract import SolveRequest
from solve import PinConflict, TimeLimitExceeded, plan_json, solve


def main() -> None:
    raw = json.load(sys.stdin)
    req = SolveRequest.model_validate({"problem": raw["problem"], "timeLimitMs": raw.get("timeLimitMs", 10_000)})
    try:
        sys.stdout.write(plan_json(solve(req)))
    except TimeLimitExceeded as e:
        sys.stderr.write(f"time-limit: {e}\n")
        sys.exit(3)
    except PinConflict as e:  # D-37: no plan; the canonical error body (as POST /solve's 422) on stderr, exit 4
        sys.stderr.write("pin-conflict: " + plan_json(e.body()) + "\n")
        sys.exit(4)


if __name__ == "__main__":
    main()
