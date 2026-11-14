"""FastAPI service: POST /solve (PRD §5). Stateless; the caller's checker validates every plan (D-03)."""

from fastapi import FastAPI
from fastapi.responses import Response

from contract import SolveRequest
from solve import plan_json, solve

app = FastAPI(title="truckroll-solver", version="0.1.0")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/solve")
def solve_endpoint(req: SolveRequest) -> Response:
    # Canonical bytes (sorted keys, no spaces): the same request gives the same body (TR-04).
    return Response(content=plan_json(solve(req)), media_type="application/json")
