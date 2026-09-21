'use strict';
/*
 * Background jobs, in memory.
 *
 * A sideload runs for minutes: the browser cannot hold the request open for it (and should not —
 * that is the problem we are escaping). So the route starts the work, answers immediately with a
 * job id, and the page polls this store to see how it is going.
 *
 * In memory is the right amount of machinery here. A restart loses running jobs, and the admin
 * sees "this job is no longer running" and starts it again — the temp file is swept by
 * storage.sweepTemp() and nothing is half-imported, because the import itself is transactional.
 * Persisting jobs would buy a nicer message for a rare case and a schema to maintain forever.
 */
const KEEP_MS = 30 * 60 * 1000;      // finished jobs stay readable this long
const MAX_JOBS = 200;

const jobs = new Map();

function sweep() {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.endedAt && now - j.endedAt > KEEP_MS) jobs.delete(id);
  while (jobs.size > MAX_JOBS) jobs.delete(jobs.keys().next().value);
}

/**
 * Start tracking a job. Returns a handle the worker updates:
 *
 *   j.step('Downloading…')      the headline, what is happening now
 *   j.progress({ pct, note })   detail under it, called freely
 *   j.done({ redirect, message })
 *   j.fail(error)
 */
function create(kind, meta = {}) {
  sweep();
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id, kind, meta,
    state: 'running',
    step: 'Starting…',
    note: '',
    pct: null,
    startedAt: Date.now(),
    endedAt: null,
    message: null,
    redirect: null,
    error: null,
  };
  jobs.set(id, job);
  return {
    id,
    step(text) { job.step = text; job.note = ''; job.pct = null; },
    progress(p = {}) {
      if (p.pct !== undefined) job.pct = p.pct;
      if (p.note !== undefined) job.note = p.note;
    },
    done({ redirect, message } = {}) {
      job.state = 'done'; job.endedAt = Date.now();
      job.step = 'Finished'; job.pct = 100;
      job.message = message || null; job.redirect = redirect || null;
    },
    fail(err) {
      job.state = 'error'; job.endedAt = Date.now();
      job.error = (err && err.message) || String(err) || 'something went wrong';
      job.step = 'Failed';
    },
  };
}

const get = id => jobs.get(id) || null;

/** What the polling endpoint sends — the job, minus anything internal. */
function view(id) {
  const j = jobs.get(id);
  if (!j) return null;
  return {
    id: j.id, state: j.state, step: j.step, note: j.note, pct: j.pct,
    elapsedSec: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000),
    message: j.message, redirect: j.redirect, error: j.error,
  };
}

module.exports = { create, get, view };
