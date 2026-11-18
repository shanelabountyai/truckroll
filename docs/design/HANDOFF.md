# Design handoff

Source of truth for the UI built on branch `design/impl`. Exported 2026-11-18 from the Claude Design canvas so cloud runs don't depend on artifact access.

- Canvas: https://claude.ai/artifact/QchpXfvqN5AXsRJag7VS8V
- Brief: https://claude.ai/artifact/HCatrPJeLn9PSL4imV2LRz

## Artboards (`docs/design/*.dc.html`)

Each file is a self-contained Design Component: HTML with inline styles, `{{holes}}` filled by the `renderVals()` script at the bottom. Read the markup and the script together; the script holds the sample data.

| File | Screen | Frame |
| --- | --- | --- |
| `Main.dc.html` | Dispatch board — desktop | 1440×1240 |
| `MyDay.dc.html` | Tech's day — 390 px | 390×1180 |
| `Metrics.dc.html` | Owner metrics — desktop | 1280×900 |

## Owner calls (binding)

- No arrival after the customer window; unreachable jobs go unassigned with a reason. (Shane, 2026-11-14)
- Pinned jobs are never dropped; the solver names the pin that breaks feasibility. (Shane, 2026-11-14)
- Brief open questions not answered by Shane; the design took the brief's recommendations: shared visual identity with Walkthrough (both use the navy/amber Three Forks look), no basemap (timeline only), neutral shop branding with a small 'Built by Lab Intelligence' footer. Record each as a DECISIONS row.

## Gaps: screens the PRD needs that no artboard covers

- Stop detail (/o/[org]/dispatch/stops/[id])
- Demo entry (/demo: pick shop and role)

Design each gap as a new `docs/design/<Name>.dc.html` in the same look before building it.

## Placeholders

[XX] metric values are placeholders; compute from seeded runs.
