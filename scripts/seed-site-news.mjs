import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";

const runtimeConfigPath = path.join(process.cwd(), "config", "phis-runtime.json");
const runtimeConfig = JSON.parse(readFileSync(runtimeConfigPath, "utf8"));
const connectionString = runtimeConfig?.database?.uri?.trim();

if (!connectionString) {
  throw new Error("Missing database.uri in config/phis-runtime.json.");
}

const pool = new Pool({ connectionString });

const siteNewsSeeds = [
  {
    siteKey: "phi-systems",
    items: [
      {
        slug: "v1-news-api",
        created: "2024-09-20",
        title: "News API v1 is live",
        subtitle: "External clients can fetch structured updates.",
        content:
          "The Phi news endpoint now exposes a stable schema with token guard.",
        link: "https://phi.systems/whitepaper",
        tags: ["api", "release"],
      },
      {
        slug: "phi-vision-update",
        created: "2024-10-02",
        title: "Phi vision update",
        subtitle: "Clearer path for the automation OS.",
        content:
          "We clarified the long-term roadmap around adapters, channels, and automation graphs.",
        tags: ["roadmap"],
      },
    ],
  },
  {
    siteKey: "phisys",
    items: [
      {
        slug: "dev-site-bootstrap",
        created: "2026-03-19",
        title: "Phisys dev site bootstrap",
        subtitle: "The new frontend is now connected to the shared phis backend.",
        content:
          "dev.phisys.com now fetches its news feed from api-dev.phi-systems.tech using the shared site-aware content model.",
        tags: ["dev", "bootstrap", "integration"],
      },
    ],
  },
];

function computeMessageHash(msg) {
  return createHash("sha256").update(msg.slice(0, 50)).digest();
}

async function getSiteId(client, siteKey) {
  const { rows } = await client.query(
    "SELECT id FROM phis.sites WHERE key = $1 LIMIT 1",
    [siteKey],
  );

  if (!rows[0]?.id) {
    throw new Error(`Site not found: ${siteKey}`);
  }

  return rows[0].id;
}

async function upsertSiteMessage(client, siteId, siteKey, slug, fieldName, msg) {
  const ctx = `News article ${fieldName}`;
  const msgHash = computeMessageHash(msg);

  const existing = await client.query(
    `SELECT id, msg
     FROM phis.tr_site_msg
     WHERE site_id = $1
       AND msg_hash = $2
       AND ctx = $3
     LIMIT 1`,
    [siteId, msgHash, ctx],
  );

  if (existing.rows[0]) {
    if (existing.rows[0].msg !== msg) {
      throw new Error(`Hash collision detected for ${ctx}`);
    }

    return existing.rows[0].id;
  }

  const inserted = await client.query(
    `INSERT INTO phis.tr_site_msg (site_id, msg, msg_hash, ctx)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [siteId, msg, msgHash, ctx],
  );

  return inserted.rows[0].id;
}

async function upsertNewsItem(client, siteId, siteKey, item) {
  const meta = {
    link: item.link ?? null,
    tags: item.tags ?? [],
  };

  const contentResult = await client.query(
    `INSERT INTO phis.site_content (
       site_id,
       type,
       slug,
       status,
       published_at,
       meta
     )
     VALUES ($1, 'news', $2, 'published', $3::timestamptz, $4::jsonb)
     ON CONFLICT (site_id, type, slug)
     DO UPDATE SET
       status = EXCLUDED.status,
       published_at = EXCLUDED.published_at,
       meta = EXCLUDED.meta,
       updated_at = NOW()
     RETURNING id`,
    [siteId, item.slug, item.created, JSON.stringify(meta)],
  );

  const contentId = contentResult.rows[0].id;
  const versionResult = await client.query(
    `INSERT INTO phis.site_content_versions (content_id, version_no, meta)
     VALUES (
       $1,
       COALESCE((SELECT MAX(version_no) + 1 FROM phis.site_content_versions WHERE content_id = $1), 1),
       '{}'::jsonb
     )
     RETURNING id`,
    [contentId],
  );
  const versionId = versionResult.rows[0].id;

  const fields = [
    ["title", item.title],
    ["subtitle", item.subtitle],
    ["content", item.content],
  ];

  for (const [fieldName, value] of fields) {
    const msgId = await upsertSiteMessage(client, siteId, siteKey, item.slug, fieldName, value);

    await client.query(
      `INSERT INTO phis.site_content_version_text (version_id, field_name, msg_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (version_id, field_name)
       DO UPDATE SET msg_id = EXCLUDED.msg_id`,
      [versionId, fieldName, msgId],
    );
  }

  await client.query(
    `UPDATE phis.site_content
     SET current_version_id = $2,
         published_version_id = $2,
         updated_at = NOW()
     WHERE id = $1`,
    [contentId, versionId],
  );
}

async function main() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const siteSeed of siteNewsSeeds) {
      const siteId = await getSiteId(client, siteSeed.siteKey);

      for (const item of siteSeed.items) {
        await upsertNewsItem(client, siteId, siteSeed.siteKey, item);
      }
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
