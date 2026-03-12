/**
 * One-time batch backfill for tokens.logo_url (Postgres).
 *
 * - Selects tokens where logo_url is NULL/empty.
 * - Fetches DexScreener by CA.
 * - Updates logo_url using fallback order:
 *   pair.info?.imageUrl || pair.baseToken?.logoURI || pair.quoteToken?.logoURI
 * - Processes 5 rows at a time, waits 1s between batches.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." node scripts/backfill_logo_url.js
 * Optional:
 *   BATCH_SIZE=5 SLEEP_MS=1000 LIMIT=500 node scripts/backfill_logo_url.js
 */

const { Pool } = require('pg');

const BATCH_SIZE = Number(process.env.BATCH_SIZE || 5);
const SLEEP_MS = Number(process.env.SLEEP_MS || 1000);
const LIMIT = process.env.LIMIT != null ? Number(process.env.LIMIT) : null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pickLogoUrl(pair) {
  if (!pair) return null;
  return (
    pair.info?.imageUrl ||
    pair.baseToken?.logoURI ||
    pair.quoteToken?.logoURI ||
    null
  );
}

async function fetchDexLogoUrl(ca) {
  const url =
    'https://api.dexscreener.com/latest/dex/tokens/' + encodeURIComponent(ca);
  const res = await fetch(url);
  if (!res.ok) return null;
  const dex = await res.json();
  const pair = dex?.pairs?.[0];
  const logoUrl = pickLogoUrl(pair);
  return typeof logoUrl === 'string' && logoUrl.trim() ? logoUrl.trim() : null;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    await pool.query('ALTER TABLE tokens ADD COLUMN IF NOT EXISTS logo_url TEXT');

    let updated = 0;
    let processed = 0;

    // Loop until no more rows, or LIMIT reached.
    // We re-query each batch so newly updated rows are excluded.
    while (true) {
      if (LIMIT != null && processed >= LIMIT) break;

      const remaining = LIMIT != null ? Math.max(0, LIMIT - processed) : null;
      const take = remaining != null ? Math.min(BATCH_SIZE, remaining) : BATCH_SIZE;

      const { rows } = await pool.query(
        `
          SELECT ca
          FROM tokens
          WHERE ca IS NOT NULL
            AND (logo_url IS NULL OR BTRIM(logo_url) = '')
          ORDER BY created_at DESC NULLS LAST
          LIMIT $1
        `,
        [take]
      );

      if (!rows.length) break;

      // Process this batch sequentially (keeps request rate sane)
      for (const row of rows) {
        processed += 1;
        const ca = row.ca;
        if (!ca) continue;

        let logoUrl = null;
        try {
          logoUrl = await fetchDexLogoUrl(ca);
        } catch (e) {
          // ignore fetch errors
        }

        if (logoUrl) {
          await pool.query(
            `UPDATE tokens SET logo_url = $2 WHERE ca = $1`,
            [ca, logoUrl]
          );
          updated += 1;
          console.log(`[logo_url] updated ${ca} -> ${logoUrl}`);
        } else {
          console.log(`[logo_url] not found for ${ca}`);
        }
      }

      await sleep(SLEEP_MS);
    }

    console.log(`Done. processed=${processed} updated=${updated}`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

