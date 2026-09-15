# Deploying iDrift

The whole thing is one Cloudflare Worker: it serves the built game as static
assets and answers `/api/*` itself. One project, one deploy, one origin.

## First time

```bash
npx wrangler login          # opens a browser; only you can do this
npm run setup:cloudflare    # creates D1 + R2, writes the binding, migrates
npm run deploy
```

`setup:cloudflare` is safe to re-run — every step checks for an existing
resource first. It will not touch authentication, and it never asks for an API
token.

## Day to day

```bash
npm run dev          # game only, on :5173 and on your LAN for phone testing
npm run dev:worker   # game + real API against a local D1, on :8787
npm test             # headless sim, camera and moderation tests
npm run deploy       # typecheck, build, ship
```

`npm run dev` is the fast loop and is what you want for handling work. It does
not serve `/api/*`, so the leaderboard panel will say it cannot reach the board
— that is expected and nothing else is affected.

## Wiping the board

While handling is still being tuned the leaderboard is disposable:

```bash
npm run db:reset         # remote
npm run db:reset:local   # local dev database
```

Once other people are playing, prefer bumping `SIM_VERSION` over wiping.
Boards are partitioned by it, so a physics change starts a clean board while
leaving the old rows intact and correctly labelled as belonging to the old
model. Wiping is for the period before anyone's time means anything.

## What is where

| Thing | Where |
|---|---|
| Static game | `dist/`, served by the Worker's ASSETS binding |
| API | `worker/index.ts` |
| Leaderboard tables | D1 `idrift-db`, schema in `migrations/` |
| Art and meme assets | R2 `idrift-media` (bound as `MEDIA`, nothing reads it yet) |
| Rate limiting | Workers rate-limit binding, 10 posts/min/IP |

## Free tier

D1 allows 5M row reads and 100k row writes per day; a leaderboard read is a
20-row scan on an index and a submission is one insert plus one count. R2 has
no egress fees, which is the reason art lives there rather than in the bundle.
Static asset bandwidth on Workers is unmetered. Nothing here is close to a
limit at the scale of friends and family, and none of it needs a paid plan.

## The one thing that can go wrong quietly

`SIM_VERSION` in `src/sim/version.ts` must be bumped for **any** physics or
scoring change. Nothing enforces it. If it is missed, new times land on the
same board as times set against a different model, and no player can tell.
