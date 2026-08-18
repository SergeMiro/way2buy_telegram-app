// Copying a catalogue photo into storage.
//
// The rule this file is really about: persist() must never throw. It runs inside
// the sync, and a sync that dies because one picture could not be copied is
// worse than a sync that keeps the old expiring link — the card still arrives,
// looking exactly as it would have before any of this existed.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as photos from '../server/photos.js';

const withStorage = async (fn) => {
  const before = { ref: process.env.SUPABASE_PROJECT_REF, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_PROJECT_REF = 'testref';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'testkey';
  try { return await fn(); } finally {
    before.ref ? (process.env.SUPABASE_PROJECT_REF = before.ref) : delete process.env.SUPABASE_PROJECT_REF;
    before.key ? (process.env.SUPABASE_SERVICE_ROLE_KEY = before.key) : delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
};

const image = (bytes = 1000) => ({
  ok: true, status: 200,
  headers: new Map([['content-type', 'image/jpeg']]),
  arrayBuffer: async () => new ArrayBuffer(bytes),
  text: async () => '',
});

test('the key is stable, so a second import overwrites instead of duplicating', () => {
  assert.equal(photos.keyFor('bags', 71609, 0), 'bags/71609-0.jpg');
  assert.equal(photos.keyFor('bags', 71609, 2), 'bags/71609-2.jpg');
  // A channel key is part of a path; nothing exotic may travel into it.
  assert.equal(photos.keyFor('../../etc', 1, 0), '______etc/1-0.jpg');
});

test('a stored URL is recognisable as one that will not expire', () => withStorage(async () => {
  const url = photos.publicUrl('bags/1-0.jpg');
  assert.ok(photos.isStored(url), url);
  assert.ok(!photos.isStored('https://cdn4.telesco.pe/file/abc'));
  assert.ok(!photos.isStored('AgACAgIAAyEF...'));
  assert.ok(!photos.isStored(null));
}));

test('the cover is copied and the row now points at the copy', () => withStorage(async () => {
  const calls = [];
  const r = await photos.persist('bags', 71609, ['https://cdn4.telesco.pe/file/a', 'https://cdn4.telesco.pe/file/b'], {
    fetchImpl: async (url, opts) => {
      calls.push(opts?.method || 'GET');
      return opts?.method === 'POST' ? { ok: true, status: 200, text: async () => '' } : image();
    },
  });
  assert.equal(r.stored, 1, 'only the cover — the other seven are the storage budget');
  assert.ok(photos.isStored(r.photos[0]));
  assert.equal(r.photos[1], 'https://cdn4.telesco.pe/file/b', 'the rest are left as they were');
  assert.deepEqual(calls, ['GET', 'POST']);
}));

test('a photo already in storage is not copied again', () => withStorage(async () => {
  const stored = photos.publicUrl('bags/71609-0.jpg');
  let called = 0;
  const r = await photos.persist('bags', 71609, [stored], { fetchImpl: async () => { called += 1; return image(); } });
  assert.equal(called, 0, 're-running the import must be cheap');
  assert.equal(r.stored, 0);
  assert.equal(r.photos[0], stored);
}));

test('a Telegram file_id is left alone — it never expires', () => withStorage(async () => {
  let called = 0;
  const r = await photos.persist('bags', 1, ['AgACAgIAAyEFAASeG1YH'], { fetchImpl: async () => { called += 1; return image(); } });
  assert.equal(called, 0);
  assert.equal(r.photos[0], 'AgACAgIAAyEFAASeG1YH');
}));

test('an expired source link is skipped, not fatal', () => withStorage(async () => {
  const r = await photos.persist('bags', 1, ['https://cdn4.telesco.pe/file/gone'], {
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '' }),
  });
  assert.equal(r.stored, 0);
  assert.equal(r.photos[0], 'https://cdn4.telesco.pe/file/gone', 'the card keeps what it had');
}));

test('a failing upload leaves the card exactly as it was', () => withStorage(async () => {
  // The whole point: the sync goes on. A card with an old link beats no card.
  const r = await photos.persist('bags', 1, ['https://cdn4.telesco.pe/file/a'], {
    fetchImpl: async (url, opts) => (opts?.method === 'POST'
      ? { ok: false, status: 500, text: async () => 'boom' }
      : image()),
  });
  assert.equal(r.stored, 0);
  assert.equal(r.photos[0], 'https://cdn4.telesco.pe/file/a');
}));

test('an absurdly large file is refused before it reaches the bucket', () => withStorage(async () => {
  let posted = false;
  const r = await photos.persist('bags', 1, ['https://cdn4.telesco.pe/file/huge'], {
    fetchImpl: async (url, opts) => {
      if (opts?.method === 'POST') { posted = true; return { ok: true, status: 200, text: async () => '' }; }
      return image(50 * 1024 * 1024);
    },
  });
  assert.equal(posted, false);
  assert.equal(r.stored, 0);
}));

test('with no storage configured nothing is attempted and nothing is lost', async () => {
  const before = { ref: process.env.SUPABASE_PROJECT_REF, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.SUPABASE_PROJECT_REF;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    assert.equal(photos.configured(), false);
    const urls = ['https://cdn4.telesco.pe/file/a'];
    const r = await photos.persist('bags', 1, urls, { fetchImpl: async () => { throw new Error('не має викликатись'); } });
    assert.deepEqual(r.photos, urls);
    assert.equal(r.stored, 0);
  } finally {
    if (before.ref) process.env.SUPABASE_PROJECT_REF = before.ref;
    if (before.key) process.env.SUPABASE_SERVICE_ROLE_KEY = before.key;
  }
});
