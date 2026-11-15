# SPHEREx Sky Time-Machine — Stardust Syndicate

This repository contains the source export of version 16 of the Hatchable project.

## Source snapshot
- Frontend: `public/index.html`, `public/viewer.js`, `public/timeline.js`
- API handlers: `api/search.js`, `api/cutout.js`, `api/realcolor.js`
- Data source: NASA/IPAC Infrared Science Archive (IRSA) SPHEREx SIA2/IBE; Pan-STARRS1 via STScI for the separate visible-light colour comparison.

## Important
This is a source backup, not yet a standalone deployment. The API handlers currently use Hatchable's request/response runtime conventions and need adaptation before deploying to another host. No simulated observations are substituted for archive results.
