# DVC reservation monitor

Free-tier DVC confirmed-reservation monitoring built with Cloudflare Workers + D1, GitHub Actions browser checks, and Brevo transactional email.

## Watches

| Watch | Schedule | Alerts |
|---|---:|---|
| DVC Rental Store under $201 | every minute | new + price changes below `$201/night` |
| DVC Rental Store under $12/point | every minute | new + price changes below `$12/point` |
| DVC Rental Store website backup | requested every 5 minutes; 15-minute GitHub cron fallback | new + price changes matching either fast Rental Store filter |
| DVC Rental Store - All Reservations | every 10 minutes | all new reservations + price changes |
| David's Vacation Rentals | every 5 minutes | `< $300/night` OR 1/2/3-bedroom `< $17/point`; new + price changes |
| DVC-Rental direct primary | every 5 minutes | all new confirmed reservations + price changes from structured `/deals` data |
| DVC-Rental browser fallback | every 10 minutes | browser verification/fallback for new reservations and price changes using the same D1 state and deduplication |
| DVC Shop | every 5 minutes | newly available confirmed reservations + price changes |
| DVCReservations Rare Finds | every 15 minutes | new reservations + price changes |

Any monitored source that exposes enough price data is also checked for the priority bargain thresholds `< $201/night` and `< $12/point`. A matching event gets a flame subject so it stands out in Gmail and Pushover. The nightly threshold can be evaluated for every current source. Point-price matching requires the source to expose point count or point price; Rental Store and David's currently do so, while the current DVC-Rental and DVC Shop listing feeds do not reliably expose point pricing.

The first successful snapshot for each source is a baseline and sends no mass alert. Removals do not alert. Direct booking links are included whenever available.

## Alert delivery

Production alerts go to the notification-only Gmail account in `EMAIL_TO` and, when `EMAIL_FROM` is a different address, a copy is also delivered to that primary Gmail inbox. This allows Gmail push notifications to be enabled only for the notification account while still keeping every DVC alert in the primary mailbox. Pushover can remain enabled as a BCC backup.

## Reliability protections

- Cloudflare D1 stores snapshots, atomic alert claims/deduplication, health, and daily email counters.
- Rental Store API, all-reservations watch, and website backup share one alert namespace, preventing duplicate emails for the same reservation and price fingerprint.
- DVC-Rental direct and browser paths share one snapshot and alert namespace, so the browser fallback does not create duplicate alerts for the same reservation fingerprint. A browser scrape of the exact inventory already committed by the primary finishes successfully without acquiring a competing lock; any new, removed, or repriced reservations still require normal ingestion. A stalled or stale browser backup is surfaced separately in health.
- Alert claims expire if a Worker crashes before email delivery, so the event can retry later.
- A source failure or zero-result parser failure does not replace a good snapshot.
- Snapshots advance only after alerts are successfully delivered or there is nothing new to deliver.
- Three consecutive source failures trigger a warning email.
- The status page shows source last-check/last-success timestamps, failure counts, email usage, and last added/changed activity for each watch.
- With notification Gmail + primary Gmail + the Pushover email gateway, each alert can consume three Brevo recipient deliveries. The monitor warns at 70 alert emails/day, pauses low-priority emails at 82, and preserves bargain-alert capacity until a hard safety cutoff of 96 alert emails/day, keeping the theoretical maximum below 300 recipient deliveries/day.

## All-watch notification timing

- Open `/timing-audit` for a **read-only timing report across every reservation source**; filter using `?source=dvc-rental-store`, `davids`, `dvc-rental`, `dvc-shop`, or `dvcreservations-rare-finds`. The dashboard also displays a recent-alert timing table and per-site medians.
- For the standard four outbox-based sources, the report reads existing `alert_outbox.created_at` (**qualifying event detected/queued**) and `updated_at` when the status became `sent` (**Brevo acceptance**). Rare Finds uses the existing legacy `alerts.created_at` and `sent_at` records (retained approximately 60 days), which do not preserve the per-event NEW-versus-CHANGED classification.
- DVC Shop can additionally report per-listing WordPress `date_gmt` publication metadata for NEW alerts. Other sources' public feeds have **no verified reservation-level publication timestamps**; show their publication as **unavailable**, not as an invented time.
- Repricing events can be measured from detection to provider acceptance, **not** from when the website actually changed the price (no authoritative edit timestamp verified). The website may be scraped later than publication, and Brevo acceptance is not proof Gmail delivered the message at that instant.
- No additional HTTP checks, source polling, email recipients or write-heavy history are introduced. The reporting queries are indexed and do not modify any reservation snapshots or notification thresholds. Metrics summarize the most recent sampled alerts, not the entire lifetime of the monitor.

## DVC Shop publication-to-alert timing audit

- A separate, read-only five-minute check (staggered two minutes after each five-minute boundary) requests the **100 newest reservation posts** from DVC Shop's public WordPress API, using each listing's `date_gmt`.
- The normal DVC Shop watch records the **first time it discovers each new reservation** and when a previously unavailable listing becomes available. A successful Brevo alert records its **first send/acceptance time**. No additional emails are sent by the publication audit.
- Open `/publication-audit` for a read-only JSON comparison or view the new DVC Shop timing table on the dashboard. The audit flags posts published after monitoring was enabled that remain unseen or unnotified beyond **12 minutes**, subject to current availability.
- An older reservation found in a snapshot when the audit starts remains a historical baseline. Its original first-seen or first-notification time cannot be reconstructed from current D1 snapshots. WordPress post dates are not guaranteed to equal the instant the reservation first became publicly available, and Brevo acceptance time is not the same as inbox delivery.
- The checker uses a small 100-post metadata response and writes only new publication records, newly seen reservations, and actual accepted alerts—rather than rewriting the entire inventory every five minutes. Its health appears as `dvc-shop-publication-audit`.

## Storage

The deploy workflow creates or reuses a D1 database named `dvc-monitor-state`, applies `migrations/0001_init.sql`, binds it to the Worker as `DB`, and deploys the Worker.

## Required GitHub Actions secrets

For the **Deploy DVC monitor** workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `BREVO_API_KEY`
- `EMAIL_TO`
- `EMAIL_FROM`
- `PUSHOVER_EMAIL` (optional; Pushover email gateway)
- `DVC_MONITOR_INGEST_TOKEN`
- `DVC_MONITOR_ADMIN_TOKEN`
- `DVC_GITHUB_DISPATCH_TOKEN`

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
4. Run the browser workflows manually once to establish baselines.
5. Open the Worker URL to confirm health.
6. Keep ChangeDetection enabled while comparing alerts until the replacement monitor has demonstrated stable operation.

## Manual checks

Protected Worker endpoint examples:

- `POST /run?mode=rental-store` — Rental Store API + all-reservations cycle
- `POST /run?mode=slow` — David's + DVC Shop
- `POST /run?mode=dvc-rental-direct` — direct structured DVC-Rental check
- `POST /run?mode=rare-finds` — DVCReservations Rare Finds check
- `POST /run?mode=website-backup-dispatch` — request Rental Store browser backup
- `POST /run?mode=test-email` — send one test email

Use `Authorization: Bearer <DVC_MONITOR_ADMIN_TOKEN>`.