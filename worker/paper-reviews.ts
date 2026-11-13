import { Failure } from './exchange';

const prefix = 'binance-review:';

export async function listPaperReviews(db: D1Database) {
  const {results} = await db.prepare(
    "SELECT id,created_at,data FROM ai_logs WHERE id LIKE 'binance-review:%' ORDER BY created_at DESC,id DESC LIMIT 30"
  ).all<{id:string;created_at:string;data:string}>();
  return results.map(row => ({ ...JSON.parse(row.data), id:row.id.slice(prefix.length), createdAt:row.created_at }));
}

export async function savePaperReview(db: D1Database, input: Record<string, unknown>) {
  if (!input || typeof input.requestId !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.requestId)) {
    throw new Failure('PAPER_REVIEW_REQUEST_ID_REQUIRED');
  }
  function field(value: unknown, limit: number) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit) throw new Failure('PAPER_REVIEW_INVALID');
    return value.trim();
  }
  const id = input.requestId.toLowerCase();
  const title = field(input.title, 100);
  const summary = field(input.summary, 2500);
  const lessons = field(input.lessons, 1500);
  const nextSteps = field(input.nextSteps, 1500);
  const data = JSON.stringify({title,summary,lessons,nextSteps});
  const lookup = db.prepare('SELECT created_at,data FROM ai_logs WHERE id=?').bind(prefix+id);
  await db.prepare('INSERT OR IGNORE INTO ai_logs (id,created_at,data) VALUES (?,?,?)')
    .bind(prefix+id,new Date().toISOString(),data).run();
  const saved = await lookup.first<{created_at:string;data:string}>();
  if (!saved || saved.data !== data) throw new Failure('PAPER_REVIEW_REQUEST_CONFLICT',409);
  return {id,createdAt:saved.created_at,status:'SAVED'};
}
