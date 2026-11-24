# LinkedIn drafts — Truckroll

Two drafts in Shane's voice, each built on one row of `docs/truckroll/DECISIONS.md`. Facts come from the repo as read
on 2026-11-24 (`main` at `aa4897e`). Truckroll is not deployed and runs on synthetic data; both drafts say so.
Edit freely before posting.

---

## Draft 1 — Don't trust the solver (D-03, D-32)

**Status: Drafted, unposted**

Truckroll, the HVAC dispatch planner I built with Claude Code, rests on one rule: the route solver's answer is never trusted.

The solver is Google OR-Tools in a small Python service. It decides which technician goes where, in what order, inside
each customer's window. Every plan it returns goes through a separate TypeScript checker before anything is
saved: skills, windows, shifts, lunch, pins, capacity.

The first review showed why the rule matters. The checker accepted whatever reason the solver gave for leaving a job
unassigned. A plan that dropped all 24 jobs on the demo day still passed.

So the checker now works out each reason itself. If a job comes back as "no room", it has to prove there was no
technician and no position on any route where it would fit. A wrong reason fails. A job that could have been routed
fails. That is decision D-32 in the project's log.

The lesson I keep relearning: a second component is only a check if it can say no.

Truckroll is a portfolio project, not deployed, on synthetic data for two made-up shops in eastern Oklahoma. The code
and the decisions log are public: github.com/shanelabountyai/truckroll

---

## Draft 2 — No late arrivals, and what it cost (D-36)

**Status: Drafted, unposted**

One product call on Truckroll, the HVAC dispatch planner I built with Claude Code, changed how the whole engine behaves.

The first version let the planner arrive up to an hour after a customer's window closed, with a penalty for every
late minute. Mathematically tidy. In practice it meant the software could quietly promise a customer something the shop
never agreed to.

I changed it to hard windows (decision D-36). A technician starts inside the window or the job isn't routed, and the
dispatcher sees it listed as unplaced with the reason. Arriving early means waiting at the door.

It wasn't free. On the demo day the planner now settles on 237 drive minutes instead of 221. It also finishes in about
60 ms instead of about 600, because there are far fewer options to search.

Sixteen extra minutes of driving in exchange for never telling a customer a time outside the window they booked. For a
shop that lives on trust, I'd take that trade again. Others might not, and the log says how to undo it.

Truckroll is a portfolio project, not deployed, on synthetic data. Decisions log: github.com/shanelabountyai/truckroll
