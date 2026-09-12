# Cinema: public evidence and remaining acceptance

This is a portable summary of the local Cinema exercise, not a new migration
verdict. The applications, specification, fixtures and session artifacts are kept
outside the harness repository's published files. No private raw artifacts are
included here. Historical execution details also appear in [VALIDATION](VALIDATION.md).

| Identity | Recorded value |
| --- | --- |
| Profile | `standard` |
| Session | `7746d541d4ad0d27d9a86a2f8972c234`, generation 0 |
| Source baseline | Angular `11db3f2` |
| Destination baseline | React `b3bfcf5` |
| Accepted destination commit | `2c98611`, in the separate React repository |
| Preparation | `p5-prepared-02`, VERIFIED; 72 source captures, 36 scenarios, two repeated source executions |
| Passing run | `0001`, 2026-09-12 |
| Configuration hash | `7224f2a4030894474831264ed8c19c604e61f93a747478096136baad458b1b1e` |
| Reference hash | `84e9843094c794f84864d64a2033c63587bfa8117104970e345af3117effcc70` |
| Candidate hash | `8289c7fb3b91d99fe1e02294ffe60bf96f1e7f889d25d368d1f1c372a90a412f` |
| Served build hash | `b51766f8e21070618b7c370375daf062cfe0997f9e18f789a4aff64b72b8ea2d` |

The public run report was inspected in the initial 2026-09-12 audit. The harness
reported PASS for preservation, requirements and native project checks: 36/36
scenarios, 131/131 requirements and 3/3 checks. These values identify that run;
they do not certify later changes or a clean checkout of another revision.

Run 0000 was INCONCLUSIVE: six scenarios failed the first Save interaction.
Blur validation moved the Save button before mouseup, preventing submission.
A synthetic before/after probe localized the problem; the scoped React repair
preserved validation, and run 0001 passed. Two of four attempts were consumed.
The local record reports 273,569 ms of active verification, two diagnostic probes,
and no mandatory pause to author a brief or intermediate JSON in standard mode.
Preparation/editing/idle time and a complete count of owner interruptions were
not measured; no percentage productivity improvement is claimed.

The recorded human review on 2026-09-12 examined both applications side by side
and authorized the React commit. This summary does not repeat that visual review
or independently assert accessibility compliance.

## Coverage limits and pending acceptance

- These applications were created for the exercise; they are not a third-party
  or production migration. APIs were mocked, so real backend persistence is not proven.
- Three expected differences were declared: trimming title and synopsis and
  rejecting fractional duration. Two non-blocking ARIA warnings remained visible
  in the tool report and were addressed by the recorded human inspection.
- The three controlled value/validation/navigation regressions are demonstrated
  by [the P4 acceptance test](../tests/browser/migration-acceptance.test.mjs).
  They were not separately injected and repaired in the Cinema session. This
  Cinema-specific P5 criterion remains open; the blur fix does not substitute it.
- A complete measure of preparation effort and owner interventions remains open.
  Active verification time alone is not that measure.

Resolving those P5 items requires additional recorded evidence within authorized
scope and persistent budgets. The harness maintenance and GitHub publication task
does not reset or replace the Cinema session to obtain extra attempts.
