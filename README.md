# PulseScan

Cloudflare Workers migration of the PulseScan Solana intelligence and paper-trading terminal.

## Included
- Precision Momentum v5 paper strategy
- Fresh-token and breakout scanning
- Paper positions, dynamic stops, break-even, trailing and time decay
- X Sniper with fallback mode
- FOMO Intelligence
- Shiba AI due diligence
- Shiba alert-card generation
- D1 persistence
- Cloudflare Cron every 5 minutes
- Mobile-first PulseScan UI

## Cloudflare setup
1. Create/use D1 database `pulsescan-db`.
2. Apply `migrations/0001_pulsescan_records.sql`.
3. In Worker Settings > Bindings, add D1 database binding named `DB` pointing at `pulsescan-db`.
4. Add secrets: `APP_PASSWORD`, `BOT_TICK_SECRET`. Optional: `X_BEARER_TOKEN`, `BIRDEYE_API_KEY`.
5. In Workers Builds use `npm run build` and `npx wrangler deploy`.

The Cron Trigger is `*/5 * * * *`. Cloudflare executes Cron schedules in UTC.

No AppDeploy SDK is required in this repository.
