import type { Env } from './env';
import { audit } from './lib/audit';
import { parseJson } from './lib/http';
import { getSettings } from './lib/settings';

/**
 * Daily retention job (Cron Trigger): messages and files that were not saved to the archive are purged
 * after the org's retention period (default 12 months, §4.6). Archived files are kept.
 */
export async function runRetention(env: Env, at = Date.now()): Promise<{ orgs: number; messages: number; files: number }> {
  const { results: orgs } = await env.ORG_DB.prepare('SELECT org_id FROM org_settings').all<{ org_id: string }>();
  let messages = 0;
  let files = 0;
  for (const { org_id: orgId } of orgs) {
    const s = await getSettings(env, orgId);
    const cutoff = new Date(at);
    cutoff.setMonth(cutoff.getMonth() - s.retentionMonths);
    const { results: old } = await env.ORG_DB.prepare('SELECT id, file_ids FROM messages WHERE org_id = ? AND created_at < ? LIMIT 2000')
      .bind(orgId, cutoff.getTime()).all<{ id: string; file_ids: string | null }>();
    if (!old.length) continue;
    const fileIds = old.flatMap((m) => parseJson<string[]>(m.file_ids, []));
    const archived = new Set<string>();
    for (let i = 0; i < fileIds.length; i += 90) {
      const chunk = fileIds.slice(i, i + 90);
      const { results } = await env.ORG_DB.prepare(`SELECT file_id FROM archive_docs WHERE removed_at IS NULL AND file_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ file_id: string }>();
      results.forEach((r) => archived.add(r.file_id));
    }
    const purge = fileIds.filter((f) => !archived.has(f));
    for (const f of purge) {
      const keys = ['thumb', 'preview', 'original'].map((v) => `${orgId}/${f}/${v}`);
      await env.FILES.delete(keys);
    }
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < purge.length; i += 90) {
      const chunk = purge.slice(i, i + 90);
      stmts.push(env.ORG_DB.prepare(`UPDATE files SET purged_at = ? WHERE id IN (${chunk.map(() => '?').join(',')})`).bind(at, ...chunk));
    }
    for (const m of old) stmts.push(env.ORG_DB.prepare('DELETE FROM messages WHERE id = ? AND id NOT IN (SELECT message_id FROM archive_docs WHERE removed_at IS NULL)').bind(m.id));
    // Messages that carry archived files keep their row (the archive references them) but lose their text.
    stmts.push(env.ORG_DB.prepare('UPDATE messages SET ciphertext = NULL WHERE org_id = ? AND created_at < ?').bind(orgId, cutoff.getTime()));
    for (let i = 0; i < stmts.length; i += 90) await env.ORG_DB.batch(stmts.slice(i, i + 90));
    messages += old.length;
    files += purge.length;
    await audit(env, { orgId, action: 'retention.purge', meta: { messages: old.length, files: purge.length, cutoff: cutoff.toISOString() } });
  }
  return { orgs: orgs.length, messages, files };
}
