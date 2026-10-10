# DVC reservation monitor

Free-tier DVC confirmed-reservation monitoring built with Cloudflare Workers + D1, GitHub Actions browser checks, and Brevo transactional email.

## Watches

| Watch | Schedule | Alerts |
|---|---:|---|
| DVC Rental Store under $200 | every minute | new + price changes; current legacy cutoff is `< $201/night` |
| DVC Rental Store under $12/point | every minute | new + price changes |
| DVC Rental Store website backup | requested every minute; 5-minute GitHub cron fallback | new + price changes matching either fast Rental Store filter |
| DVC Rental Store - All Reservations | every 10 minutes | all new reservations + price changes |
| David's Vacation Rentals | every 10 minutes | `< $300/night` OR 1/2/3-bedroom `< $17/point`; new + price changes |
| DVC-Rental | every 10 minutes | all newly listed confirmed reservations across all pages |
| DVC Shop | every 10 minutes | newly available confirmed reservations |

The first successful snapshot for each source is a baseline and sends no mass alert. Removals do not alert. Direct booking links are included whenever available.

## Reliability protections

- Cloudflare D1 stores snapshots, atomic alert claims/deduplication, health, and daily email counters.
- Rental Store API, all-reservations watch, and website backup share one alert namespace, preventing duplicate emails for the same reservation and price fingerprint.
- Alert claims expire if a Worker crashes before email delivery, so the event can retry later.
- A source failure or zero-result parser failure does not replace a good snapshot.
- Snapshots advance only after alerts are successfully delivered or there is nothing new to deliver.
- Three consecutive source failures trigger a warning email.
- The status page shows source last-check/last-success timestamps, failure counts, and email usage.
- Brevo capacity guardrails warn at 225 sends/day, pause low-priority emails at 250, and preserve bargain-alert capacity until a hard safety cutoff of 295.

## Storage

The deploy workflow creates or reuses a D1 database named `dvc-monitor-state`, applies `migrations/0001_init.sql`, binds it to the Worker as `DB`, and deploys the Worker.

## Required GitHub Actions secrets

For the **Deploy DVC monitor** workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BREVO_API_KEY`
- `EMAIL_TO`
- `EMAIL_FROM`
- `DVC_MONITOR_INGEST_TOKEN`
- `DVC_MONITOR_ADMIN_TOKEN`
- `GITHUB_DISPATCH_TOKEN`

After deployment, add:

- `DVC_MONITOR_BASE_URL` — the `workers.dev` URL printed by the deployment workflow
- `DVC_MONITOR_INGEST_TOKEN` — same ingest token already used by deployment

Never commit secret values to this repository.

## Cloudflare token permissions

The deploy token must be able to create/manage the D1 database and create/deploy the Worker. Use Cloudflare's current account-owned API token permissions for D1 write/admin and Workers product-level admin when creating the Worker for the first time. After initial provisioning, the token can be reduced if desired.

## Deployment

1. Add the required repository secrets.
2. Run **Actions → Deploy DVC monitor → Run workflow**.
3. Copy the printed `DVC_MONITOR_BASE_URL` into the repository secret of the same name.
4. Run the two browser workflows manually once to establish baselines.
5. Open the Worker URL to confirm health.
6. Keep ChangeDetection enabled for 48 hours while comparing alerts and actual usage.

## Manual checks

Protected Worker endpoint examples:

- `POST /run?mode=rental-store` — Rental Store API + all-reservations cycle
- `POST /run?mode=slow` — David's + DVC Shop
- `POST /run?mode=website-backup-dispatch` — request Rental Store browser backup
- `POST /run?mode=test-email` — send one test email

Use `Authorization: Bearer <DVC_MONITOR_ADMIN_TOKEN>`.
