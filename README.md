# World Cup 2026 Match Schedule

A modern, responsive webpage listing all FIFA World Cup 2026 matches with timezone support, team filters, and live score updates.

## Features

- Full tournament schedule (group stage through final)
- Timezone selector with your local timezone detected automatically
- Team, status, group/stage, and text search filters
- Scores shown only for finished matches; live matches highlighted
- Refresh button and automatic reload on page refresh
- Mobile-optimized card layout

## Data source

Match data is fetched from the free [World Cup 2026 Companion API](https://wcup2026.org) (openfootball dataset, no API key). If that is unavailable, the page falls back to [openfootball/worldcup.json](https://github.com/openfootball/worldcup.json) on GitHub.

## Run locally

Open `index.html` in a browser, or serve the folder with any static server:

```bash
npx serve .
```

Then visit `http://localhost:3000` (or the port shown).
