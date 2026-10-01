import { removeContentFromIndex, reindexContent } from '../search/index';
import {
  insertCatalogChangeStatement,
  readContentItem,
  setContentEnabledStatement,
  setPrivateEnabledStatement,
  type CatalogOperation,
  type ContentItemRow
} from './repository';

/**
 * Atomic publication boundary for F-14 / AC-17.
 *
 * Raw `source_records` are never catalogue rows: the only thing that becomes visible is the
 * `content_items` row a record was linked to, and every visibility flip is written together with its
 * `public_catalog_changes` row in one `db.batch` unit. The revision handed back is the AUTOINCREMENT id
 * the change table allocated inside that same unit.
 */

export type IngestPublishErrorCode = 'PRIVATE_CONTENT' | 'PUBLIC_CONTENT' | 'CONTENT_NOT_FOUND';

export class IngestPublishError extends Error {
  readonly code: IngestPublishErrorCode;
  readonly contentId: string;

  constructor(code: IngestPublishErrorCode, contentId: string, message: string) {
    super(message);
    this.name = 'IngestPublishError';
    this.code = code;
    this.contentId = contentId;
  }
}

async function requireContent(db: D1Database, contentId: string): Promise<ContentItemRow> {
  const row = await readContentItem(db, contentId);
  if (row === null) {
    throw new IngestPublishError('CONTENT_NOT_FOUND', contentId, `content ${contentId} does not exist`);
  }
  return row;
}

/**
 * AC-02 hard boundary: 个人探索 items are catalogued for the admitted device only, so a public
 * publication attempt on a private work is refused before a single statement is issued.
 */
async function requirePublicContent(db: D1Database, contentId: string): Promise<void> {
  const row = await requireContent(db, contentId);
  if (row.channel_id === 'private') {
    throw new IngestPublishError('PRIVATE_CONTENT', contentId, 'private works must never enter public_catalog_changes');
  }
}

async function writeAtomically(
  db: D1Database,
  contentId: string,
  enabled: number,
  firstPublishedStamp: number | null,
  operation: CatalogOperation,
  nowSeconds: number
): Promise<number> {
  const [flip, change] = await db.batch([
    setContentEnabledStatement(db, contentId, enabled, firstPublishedStamp, nowSeconds),
    insertCatalogChangeStatement(db, contentId, operation, enabled, nowSeconds)
  ]);
  // Zero rows on the flip means the id is gone (or turned private mid-flight); the guarded change
  // insert wrote nothing either, so the committed unit is empty and nothing has to be undone.
  if (Number(flip.meta.changes) !== 1) {
    throw new IngestPublishError('CONTENT_NOT_FOUND', contentId, `content ${contentId} vanished during ${operation}`);
  }
  if (Number(change.meta.changes) !== 1) {
    throw new IngestPublishError('PRIVATE_CONTENT', contentId, `refused to write a public ${operation} for ${contentId}`);
  }
  const revision = Number(change.meta.last_row_id);
  if (revision <= 0) {
    throw new Error(`public_catalog_changes allocated no revision for ${operation} on ${contentId}`);
  }
  return revision;
}

export async function publish(db: D1Database, contentId: string, nowSeconds: number): Promise<number> {
  await requirePublicContent(db, contentId);
  const revision = await writeAtomically(db, contentId, 1, nowSeconds, 'upsert', nowSeconds);
  // The lexical index is a candidate source only, and every search read re-validates the row against
  // `content_items`, so indexing after the committed flip is safe: a crash here can hide a published
  // work from search but can never surface an unpublished or private one. Publish is idempotent, so a
  // refusal propagates instead of being swallowed — the caller re-runs it and gets the same revision.
  await reindexContent(db, contentId);
  return revision;
}

/**
 * Unlisting keeps `first_published_at` (SPEC §6: 最新上线只依据此字段) and emits the delete tombstone in
 * the same unit, so a client can never observe an enabled row without its change event.
 */
export async function unpublish(db: D1Database, contentId: string, nowSeconds: number): Promise<number> {
  await requirePublicContent(db, contentId);
  const revision = await writeAtomically(db, contentId, 0, null, 'delete', nowSeconds);
  // AC-16: a takedown must leave no lexical candidate behind, even though the read filter would hide it.
  await removeContentFromIndex(db, contentId);
  return revision;
}

/**
 * Private-catalogue visibility: flips `enabled` for an in-app 个人探索 row and by construction touches
 * no public table, which is why it is a separate function instead of a branch inside `publish`.
 */
async function flipPrivateVisibility(db: D1Database, contentId: string, enabled: number, nowSeconds: number): Promise<void> {
  const row = await requireContent(db, contentId);
  if (row.channel_id !== 'private') {
    throw new IngestPublishError('PUBLIC_CONTENT', contentId, `${contentId} is a public work; use publish/unpublish`);
  }
  const result = await setPrivateEnabledStatement(db, contentId, enabled, nowSeconds).run();
  if (Number(result.meta.changes) !== 1) {
    throw new IngestPublishError('CONTENT_NOT_FOUND', contentId, `private visibility flip for ${contentId} matched no row`);
  }
}

export async function publishToPrivateCatalog(db: D1Database, contentId: string, nowSeconds: number): Promise<void> {
  await flipPrivateVisibility(db, contentId, 1, nowSeconds);
}

export async function unpublishFromPrivateCatalog(db: D1Database, contentId: string, nowSeconds: number): Promise<void> {
  await flipPrivateVisibility(db, contentId, 0, nowSeconds);
}
