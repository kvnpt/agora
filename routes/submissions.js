const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { getDb } = require('../db');
const { requireAuth, requireRole } = require('../auth');

const router = Router();

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'data', 'posters'),
  filename: (req, file, cb) => {
    const hash = crypto.randomBytes(8).toString('hex');
    const ext = path.extname(file.originalname);
    cb(null, `${hash}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// POST /api/submissions — submit an event (manual or poster upload)
router.post('/', requireAuth, upload.single('poster'), async (req, res) => {
  const db = getDb();
  const { parish_id, title, description, start_utc, end_utc, event_type, source_url } = req.body;

  if (!parish_id || !title || !start_utc) {
    return res.status(400).json({ error: 'parish_id, title, and start_utc are required' });
  }

  // Validate parish exists
  const parish = db.prepare('SELECT id FROM parishes WHERE id = ?').get(parish_id);
  if (!parish) return res.status(400).json({ error: 'Invalid parish_id' });

  const imagePath = req.file ? req.file.filename : null;

  const result = db.prepare(`
    INSERT INTO event_submissions (submitted_by, parish_id, title, description, start_utc, end_utc, event_type, source_url, image_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.session.user.id,
    parish_id,
    title,
    description || null,
    start_utc,
    end_utc || null,
    event_type || 'other',
    source_url || null,
    imagePath
  );

  const submission = db.prepare('SELECT * FROM event_submissions WHERE id = ?').get(result.lastInsertRowid);

  // If poster was uploaded, try to parse it with Claude Vision
  if (imagePath) {
    try {
      const posterAdapter = require('../adapters/whatsapp-poster');
      const fullPath = path.join(__dirname, '..', 'data', 'posters', imagePath);
      const parsed = await posterAdapter.parseImage(fullPath, parish_id);

      if (parsed.length > 0) {
        // Create additional submissions from parsed events
        const insertParsed = db.prepare(`
          INSERT INTO event_submissions (submitted_by, parish_id, title, description, start_utc, end_utc, event_type, image_path, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
        `);

        const tx = db.transaction(() => {
          for (const evt of parsed) {
            insertParsed.run(
              req.session.user.id,
              parish_id,
              evt.title,
              evt.description,
              evt.start_utc,
              evt.end_utc,
              evt.event_type,
              imagePath
            );
          }
        });
        tx();

        return res.status(201).json({
          submission,
          parsed_events: parsed.length,
          message: `Poster parsed: ${parsed.length} events extracted and pending review`
        });
      }
    } catch (err) {
      console.error('[submissions] Poster parsing failed:', err.message);
      // Continue — the manual submission is still valid
    }
  }

  res.status(201).json(submission);
});

// GET /api/submissions — list submissions (admin sees all, contributor sees own)
router.get('/', requireAuth, (req, res) => {
  const db = getDb();
  const user = req.session.user;

  let submissions;
  if (user.role === 'admin') {
    submissions = db.prepare(`
      SELECT s.*, u.name as submitter_name
      FROM event_submissions s
      LEFT JOIN users u ON s.submitted_by = u.id
      ORDER BY s.created_at DESC LIMIT 100
    `).all();
  } else {
    submissions = db.prepare(`
      SELECT * FROM event_submissions WHERE submitted_by = ? ORDER BY created_at DESC LIMIT 50
    `).all(user.id);
  }

  res.json(submissions);
});

// PATCH /api/submissions/:id — approve/reject (admin only)
router.patch('/:id', requireRole('admin'), (req, res) => {
  const db = getDb();
  const { status } = req.body;

  if (!['approved', 'rejected'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved or rejected' });
  }

  const submission = db.prepare('SELECT * FROM event_submissions WHERE id = ?').get(req.params.id);
  if (!submission) return res.status(404).json({ error: 'Submission not found' });

  db.prepare('UPDATE event_submissions SET status = ?, reviewed_by = ? WHERE id = ?')
    .run(status, req.session.user.id, req.params.id);

  res.json({ id: submission.id, status });
});

module.exports = router;
