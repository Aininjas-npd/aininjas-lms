// Tiny express-session store backed by the app's SQLite database.
module.exports = function (session) {
  const Store = session.Store;
  class SqliteStore extends Store {
    constructor({ db }) {
      super();
      this.db = db;
      db.exec(`CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)`);
      this.get_ = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?');
      this.set_ = db.prepare('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess=excluded.sess, expires=excluded.expires');
      this.del_ = db.prepare('DELETE FROM sessions WHERE sid = ?');
      setInterval(() => db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()), 3600 * 1000).unref();
    }
    get(sid, cb) { try { const r = this.get_.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); } }
    set(sid, sess, cb) {
      try {
        const exp = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
        this.set_.run(sid, JSON.stringify(sess), exp); cb && cb(null);
      } catch (e) { cb && cb(e); }
    }
    destroy(sid, cb) { try { this.del_.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
    touch(sid, sess, cb) { this.set(sid, sess, cb); }
  }
  return SqliteStore;
};
