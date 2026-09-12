# End-to-end browser specs

Real-browser checks of every surface -- sign-in and registration, the
workbench and admin pages with their guided tours, the workflow board,
the viewer (annotate/review/tutorial), notifications, audit log, the
session handoff between admin-ui and the viewer. They drive the actual
running stack, so they're the closest thing to a person clicking
through the product.

## Running

```bash
docker compose up -d                 # the platform (see INSTALL.md / README.md)
(cd ../ct-annotator && docker compose up -d)
e2e/run.sh                           # all specs (~15 min)
e2e/run.sh auth-page admin-tour2     # a subset
```

Nothing to install: `run.sh` uses the pinned Playwright Docker image on
the host network (it `npm install`s the matching `playwright` package
into the gitignored `e2e/node_modules` on first run). Each spec prints
`PASS`/`FAIL` per check and a `checks N, fails M` summary; `run.sh`
counts a spec as failed on a non-zero exit *or* a summary with
`fails > 0`, and exits non-zero if any spec failed.

Run the suite on an otherwise idle stack: the `viewer` spec opens a
case and waits up to 60 s for the three MPR canvases -- a series whose
volume the viewer backend has not cached yet can exceed that while
other things (e.g. the integration tests) load the same machine. A
spec that fails only under such load passes when rerun alone.

## What they assume

`fixtures.js` lists the seeded data the specs use: the "LIDC-IDRI Real
CT Sample" study with one Annotation and one Review card, a case with
real CT pixel data, and the three accounts (`platform-admin`, `dr-test`
annotator, `dr-review` reviewer, both with emails set so notification
checks can see deliveries). On a fresh stack, create the equivalent
(a study, a member for each role, a case with an uploaded DICOM series,
an Annotation card assigned to the annotator wired from an *all cases*
Dataset, a Review card wired from it) and put the ids in `fixtures.js`.

`tablet.spec.js` emulates an iPad (both orientations, `isMobile` +
`hasTouch`, so `pointer: coarse` / `hover: none` match) and drives real
multi-touch through CDP `Input.dispatchTouchEvent` -- pinch, long-press,
two-finger tap -- since `page.touchscreen` can only tap.

Two checks are data-dependent and expected to flip with the current
state: `roles` reports whether the reviewer currently *has an open
job*, and whether the admin's first job's first case has imaging.

## Adding a spec

Copy the shape of `auth-page.spec.js`: `const { F, login, seenGuides,
token, walkTour } = require("./helpers")`, a `check(name, ok, extra)`
that pushes to `results`, and the summary/exit at the end. Pre-mark
tours as seen (`ctx.addInitScript(seenGuides)`) unless the spec is
about a tour -- an auto-opened tour overlay swallows the first click.
Anchor on `data-testid` / `data-guide` attributes, not on text or CSS
classes.
