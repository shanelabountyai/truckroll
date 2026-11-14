"""FastAPI service: POST /solve (PRD §5). Stateless; the caller's checker validates every plan (D-03)."""

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response

from contract import SolveRequest
from solve import TimeLimitExceeded, plan_json, solve

app = FastAPI(title="truckroll-solver", version="0.1.0")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/solve")
def solve_endpoint(req: SolveRequest) -> Response:
    # Canonical bytes (sorted keys, no spaces): the same request gives the same body (TR-04). A search the clock cut
    # short returns no plan at all (503), never a plan that depends on machine speed (D-18).
    try:
        plan = solve(req)
    except TimeLimitExceeded as e:
        return JSONResponse(status_code=503, content={"error": "time-limit", "detail": str(e)})
    return Response(content=plan_json(plan), media_type="application/json")
