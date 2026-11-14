"""D-04: lexicographic objective via penalties. Each tier dominates everything below it on any realistic day.

drop emergency > drop standard > drop maintenance > drive per minute.
D-36 (Shane, 2026-11-14): no lateness, so there is no lateness tier; a stop starts inside its window or not at all.
D-37 (Shane, 2026-11-14): a pinned job is never dropped, so it has no drop penalty: the model makes it mandatory.
"""

DROP = {"emergency": 1_000_000_000, "standard": 1_000_000, "maintenance": 100_000}
DRIVE_PER_MIN = 1

# Search stop (D-18): greedy descent to a local optimum, bounded by a solution count — never the clock — so the same
# input gives the same plan. timeLimitMs is only a safety cap: a search that hits it returns no plan (503 / exit 3).
SOLUTION_LIMIT = 2000
