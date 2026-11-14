"""D-04: lexicographic objective via penalties. Each tier dominates everything below it on any realistic day.

drop pinned  > drop emergency > drop standard > drop maintenance > lateness per minute > drive per minute.
With maxLateMin <= 60, one job's worst lateness (60 * 1_000) is cheaper than dropping any job.
"""

DROP_PINNED = 10_000_000_000
DROP = {"emergency": 1_000_000_000, "standard": 1_000_000, "maintenance": 100_000}
LATE_PER_MIN = 1_000
DRIVE_PER_MIN = 1

# Search stop (D-18): greedy descent to a local optimum, bounded by a solution count — never the clock — so the same
# input gives the same plan. timeLimitMs is only a safety cap: a search that hits it returns no plan (503 / exit 3).
SOLUTION_LIMIT = 2000
