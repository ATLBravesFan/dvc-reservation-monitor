# DVC Reservation Monitor

Cloudflare Workers + D1 + GitHub Actions monitor for confirmed DVC reservations.

## Watches

- DVC Rental Store under $201/night: every minute, new listings + price changes.
- DVC Rental Store under $12/point: every minute, new listings + price changes.
- DVC Rental Store website/browser backup: requested every minute by the Worker, with a 5-minute GitHub cron fallback.
- DVC Rental Store all reservations: every 10 minutes, new listings + price changes.
- David's Vacation Rentals: every 10 minutes, under $300/night OR 1/2/3-bedroom under $17/point, new listings + price changes.
- DVC-Rental: browser-backed every 10 minutes across all result pages, new listings only.
- DVC Shop: every 10 minutes, new available listings only.

## Behavior

- First successful snapshot for each source is a baseline; no mass alert is sent.
- Removals never alert.
- Unchanged listings never repeat.
- Rental Store API, website backup, and all-reservations watch share alert deduplication.
- Failed email delivery releases the alert claim so it can retry.
- Direct booking URLs are included when available.
- D1 stores snapshots, alert claims/dedupe, health, email counters, and status metadata.
- Source failures are tracked; a 3-consecutive-failure warning email is attempted.
- Email usage is counted daily. Low-priority alerts pause before the provider limit so Rental Store bargain alerts retain headroom.

## Deployment

Deployment is intentionally manual through GitHub Actions.

Repository secrets required before running **Deploy DVC monitor**:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BREVO_API_KEY`
- `EMAIL_TO`
- `EMAIL_FROM`
- `DVC_MONITOR_INGEST_TOKEN`
- `GITHUB_DISPATCH_TOKEN`
- optional `DVC_MONITOR_ADMIN_TOKEN`

The deploy workflow creates or reuses the Cloudflare D1 database named `dvc-reservation-monitor`, applies `schema.sql`, binds it as `DB`, uploads Worker secrets, and deploys the Worker with a one-minute cron.

After the Worker URL is known, add these GitHub Actions secrets for browser collectors:

- `DVC_MONITOR_BASE_URL`
- `DVC_MONITOR_INGEST_TOKEN` (same value used by the Worker)

Run the two browser workflows once manually to establish their baselines.

Keep ChangeDetection enabled while this monitor runs in parallel for 48 hours. Verify the Worker status page, GitHub browser workflows, D1 usage, Worker CPU/request usage, and email delivery before retiring ChangeDetection.
