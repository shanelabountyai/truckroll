"""stdin -> stdout: `{"problem": ..., "timeLimitMs": ...}` (or a fixture file with `problem`) -> canonical plan JSON.

Same code path as POST /solve; the cross-language vitest drives the solver through this.
"""

import json
import sys

from contract import SolveRequest
from solve import plan_json, solve


def main() -> None:
    raw = json.load(sys.stdin)
    req = SolveRequest.model_validate({"problem": raw["problem"], "timeLimitMs": raw.get("timeLimitMs", 2000)})
    sys.stdout.write(plan_json(solve(req)))


if __name__ == "__main__":
    main()
