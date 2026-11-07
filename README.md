# Forecast Trust Check

Upload successive forecast snapshots and see what moved, whether it was noise, and whether splitting totals down to item level distorted the plan.

**Live:** LIVE_URL

## The pain

Scenario planning is the part planners like. The part that eats the week is exporting to Excel to check if the next 30 days held still, and arguing about how a family total became those item numbers. This tool does that checking. It is not a what-if planner, and it works with exports from any planning tool.

## Your data stays in your browser

Forecasts are commercially sensitive, so there is no server. The built page ships a Content Security Policy with `connect-src 'none'` and `form-action 'none'`, so the browser itself refuses outbound requests. Fonts are self-hosted. Share links hold view settings only. Keeping an upload between visits is opt-in.

## Features

- **Import:** tolerant CSV with a column mapping step. Long or wide, many files or one, comma, semicolon, tab or pipe, decimal commas, month and ISO week buckets. Every rejected row is reported with its line and reason.
- **Stability:** revision WAPE, COV (change over versions), frozen-window churn, bias drift, flip-flops with units undone, and a 0-100 nervousness score, per item and hierarchy node.
- **Accuracy:** error by lag, value add against naive, and whether revisions actually helped.
- **Noise vs signal:** each revision is tested against the item's own history, shrunk toward the portfolio when history is short.
- **Disaggregation audit:** sum mismatches, shares that jump under a flat parent, rounding loss, new or inactive items receiving volume, smeared intermittent items, and splits that diverge from actual mix, each with the exact quantity.
- **What to look at first:** one ranked list by volume-weighted impact with a plain-English reason. Navigate with `j`/`k`, `Enter`, `Esc`, `1`-`6`.
- **Views:** waterfall heatmap, hierarchy treemap, sparklines, revision fan, parent-to-children sankey, item drawer.
- **Export:** findings and items CSV, plus a print-ready review pack for the demand review.

Three synthetic samples are included: consumer goods with a bad split, electronics with a nervous near term, and a clean control that should stay quiet. All their names and numbers are invented.

## Parent totals

Rows with a blank item, or an item called `TOTAL` or `ALL`, are read as the stated total for that hierarchy node. That turns on the sum and rounding checks.

## Run locally

```
npm install
npm run dev
npm test
npm run build
```

Built by Aryan Kansagara. Independent project, not affiliated with Kinaxis.
