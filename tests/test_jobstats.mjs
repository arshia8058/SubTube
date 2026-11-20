// Offline tests for guarded job terminal transitions (user_stats integrity)
// and the link-event flood cap.
import assert from "node:assert";

const { createJob, completeJob, failJob, sweepStaleJobs, logLinkEvent } = await import("/tmp/test_bundle.mjs");

function makeFakeDb() {
  const jobs = [];
  const stats = new Map();
  let seq = 0;
  const norm = (sql) => sql.replace(/\s+/g, " ");
  return {
    jobs, stats,
    prepare(sql) {
      const q = norm(sql);
      return {
        bind: (...args) => ({
          run: async () => {
            if (q.startsWith("INSERT INTO jobs")) {
              const row = { id: ++seq, telegram_id: args[0], video_id: args[1], status: "processing", created_at: new Date().toISOString() };
              jobs.push(row);
              return { success: true, meta: { changes: 1, last_row_id: row.id } };
            }
            if (q.includes("SET status = 'completed'")) {
              const row = jobs.find((j) => j.id === args[0]);
              if (row && row.status === "processing") { row.status = "completed"; return { success: true, meta: { changes: 1 } }; }
              return { success: true, meta: { changes: 0 } };
            }
            if (q.includes("SET status = 'failed'")) {
              const row = jobs.find((j) => j.id === args[0]);
              if (row && row.status === "processing") { row.status = "failed"; return { success: true, meta: { changes: 1 } }; }
              return { success: true, meta: { changes: 0 } };
            }
            if (q.startsWith("INSERT INTO user_stats")) {
              const s = stats.get(args[0]) || { total_jobs: 0, successful_jobs: 0, failed_jobs: 0 };
              s.total_jobs += 1;
              if (q.includes("VALUES (?1, 1, 1, 0")) s.successful_jobs += 1; else s.failed_jobs += 1;
              stats.set(args[0], s);
              return { success: true, meta: { changes: 1 } };
            }
            throw new Error("fake db: unexpected run SQL: " + q.slice(0, 90));
          },
          first: async () => null,
          all: async () => {
            if (q.includes("FROM jobs") && q.includes("status = 'processing'")) {
              const cutoff = Date.now() - 10 * 60 * 1000;
              return { results: jobs.filter((j) => j.telegram_id === args[0] && j.status === "processing" && Date.parse(j.created_at) < cutoff).map((j) => ({ id: j.id, video_id: j.video_id })) };
            }
            throw new Error("fake db: unexpected all SQL: " + q.slice(0, 90));
          }
        })
      };
    }
  };
}

const U = 555;
// a) completing twice counts once
{
  const db = makeFakeDb();
  const id = await createJob(db, { telegramId: U, videoId: "e7fnVYzW8Ko", videoUrl: "https://www.youtube.com/watch?v=e7fnVYzW8Ko" });
  assert.strictEqual(await completeJob(db, id, U), true);
  assert.strictEqual(await completeJob(db, id, U), false, "second completion is a no-op");
  assert.deepStrictEqual(db.stats.get(U), { total_jobs: 1, successful_jobs: 1, failed_jobs: 0 });
  console.log("double complete counts once: PASS");
}
// b) fail then complete: the failure stands, no double count
{
  const db = makeFakeDb();
  const id = await createJob(db, { telegramId: U, videoId: "e7fnVYzW8Ko", videoUrl: "u" });
  assert.strictEqual(await failJob(db, id, U, "boom"), true);
  assert.strictEqual(await completeJob(db, id, U), false);
  assert.strictEqual(db.jobs[0].status, "failed");
  assert.deepStrictEqual(db.stats.get(U), { total_jobs: 1, successful_jobs: 0, failed_jobs: 1 });
  console.log("fail-then-complete counts once: PASS");
}
// c) a swept (timed-out) job counts as failed once; a late completion cannot flip it
{
  const db = makeFakeDb();
  const id = await createJob(db, { telegramId: U, videoId: "e7fnVYzW8Ko", videoUrl: "u" });
  db.jobs[0].created_at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const swept = await sweepStaleJobs(db, U);
  assert.strictEqual(swept.length, 1);
  assert.strictEqual(swept[0].id, id);
  assert.deepStrictEqual(db.stats.get(U), { total_jobs: 1, successful_jobs: 0, failed_jobs: 1 });
  assert.strictEqual(await completeJob(db, id, U), false, "late completion after sweep is a no-op");
  assert.strictEqual(db.jobs[0].status, "failed");
  assert.deepStrictEqual(db.stats.get(U), { total_jobs: 1, successful_jobs: 0, failed_jobs: 1 });
  const swept2 = await sweepStaleJobs(db, U);
  assert.strictEqual(swept2.length, 0, "second sweep finds nothing");
  console.log("sweep counts once + late completion blocked: PASS");
}
// d) a fresh job is never swept
{
  const db = makeFakeDb();
  await createJob(db, { telegramId: U, videoId: "e7fnVYzW8Ko", videoUrl: "u" });
  assert.strictEqual((await sweepStaleJobs(db, U)).length, 0);
  assert.strictEqual(db.stats.get(U), undefined);
  console.log("fresh job untouched by sweep: PASS");
}
// e) link-event flood cap: at most 100 rows per user per hour
{
  let inserts = 0;
  const db = { prepare: () => ({ bind: () => ({ run: async () => { inserts++; return { success: true }; } }) }) };
  const store = new Map();
  const kv = {
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => { store.set(k, String(v)); }
  };
  const user = { id: 42, username: "spammer", first_name: "S" };
  for (let i = 0; i < 105; i++) {
    await logLinkEvent(db, { user, url: "https://www.youtube.com/watch?v=e7fnVYzW8Ko", outcome: "received" }, kv);
  }
  assert.strictEqual(inserts, 100, "logging capped at 100/hour");
  // without a KV handle, logging still works (backwards compatible)
  await logLinkEvent(db, { user, url: "https://youtu.be/e7fnVYzW8Ko", outcome: "received" });
  assert.strictEqual(inserts, 101);
  console.log("link-event flood cap: PASS");
}

console.log("test_jobstats: ALL PASS");
