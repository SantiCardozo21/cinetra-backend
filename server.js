require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', require('./api/routes'));

// Health check
app.get('/', (_, res) => res.json({ status: 'ok', service: 'Cinetra Backend v2' }));

// ── Cron jobs (schedule scraping automático) ─────────────────────────────────
require('./cron/jobs');

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Cinetra] Backend corriendo en puerto ${PORT}`));
