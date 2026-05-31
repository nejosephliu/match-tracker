const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const MATCHES_DIR = path.join(__dirname, 'matches');
if (!fs.existsSync(MATCHES_DIR)) {
  fs.mkdirSync(MATCHES_DIR, { recursive: true });
}

// ─── CSV Format ─────────────────────────────────────────────────────────────
// Columns: round_num, type, winner, loser1, tai1, loser2, tai2, loser3, tai3
//
// META row (round_num=0):
//   winner=p1, loser1=p2, tai1=p3, loser2=p4, tai2=date, loser3=status
//
// ONE round:  winner, loser1, tai1  (loser2/tai2/loser3/tai3 empty)
// ALL round:  winner, loser1, tai1, loser2, tai2, loser3, tai3
// ────────────────────────────────────────────────────────────────────────────

const CSV_HEADERS = ['round_num', 'type', 'winner', 'loser1', 'tai1', 'loser2', 'tai2', 'loser3', 'tai3'];

function parseMatchFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').trim();
  const lines = content.split('\n');
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj = {};
    CSV_HEADERS.forEach((h, i) => { obj[h] = vals[i] !== undefined ? vals[i] : ''; });
    return obj;
  });
  const metaRow = rows.find(r => r.type === 'META');
  const rounds  = rows.filter(r => r.type === 'ONE' || r.type === 'ALL');
  return { metaRow, rounds };
}

function writeMatchFile(filePath, metaRow, rounds) {
  const lines = [CSV_HEADERS.join(',')];
  lines.push([
    '0', 'META',
    metaRow.p1, metaRow.p2, metaRow.p3, metaRow.p4,
    metaRow.date, metaRow.status, ''
  ].join(','));
  for (const r of rounds) {
    lines.push([
      r.round_num, r.type, r.winner,
      r.loser1 || '', r.tai1 !== undefined ? r.tai1 : '',
      r.loser2 || '', r.tai2 !== undefined ? r.tai2 : '',
      r.loser3 || '', r.tai3 !== undefined ? r.tai3 : ''
    ].join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n'));
}

// Parse META row (column reuse: winner=p1, loser1=p2, tai1=p3, loser2=p4, tai2=date, loser3=status)
function metaToInfo(metaRow) {
  return {
    p1: metaRow.winner, p2: metaRow.loser1,
    p3: metaRow.tai1,   p4: metaRow.loser2,
    date: metaRow.tai2, status: metaRow.loser3
  };
}

function getMatchPath(id) {
  return path.join(MATCHES_DIR, `${id}.csv`);
}

function computeScores(players, rounds) {
  const scores = {};
  players.forEach(p => { scores[p] = 0; });

  const history = [];

  for (const round of rounds) {
    const before = { ...scores };
    const pts = {};

    if (round.type === 'ONE') {
      const tai    = parseInt(round.tai1) || 0;
      const points = 5 + 2 * tai;
      scores[round.winner] += points;
      scores[round.loser1] -= points;
      pts[round.winner] = points;
      pts[round.loser1] = -points;

    } else if (round.type === 'ALL') {
      const losers = [
        { name: round.loser1, tai: parseInt(round.tai1) || 0 },
        { name: round.loser2, tai: parseInt(round.tai2) || 0 },
        { name: round.loser3, tai: parseInt(round.tai3) || 0 },
      ].filter(l => l.name);

      let totalWon = 0;
      for (const l of losers) {
        const p = 5 + 2 * l.tai;
        scores[l.name]       -= p;
        totalWon             += p;
        pts[l.name]           = -p;
      }
      scores[round.winner] += totalWon;
      pts[round.winner]     = totalWon;
    }

    history.push({
      round_num: parseInt(round.round_num),
      type:      round.type,
      winner:    round.winner,
      loser1:    round.loser1 || null,
      tai1:      round.tai1   || null,
      loser2:    round.loser2 || null,
      tai2:      round.tai2   || null,
      loser3:    round.loser3 || null,
      tai3:      round.tai3   || null,
      before,
      after:     { ...scores },
      pts
    });
  }

  return { scores, history };
}

function computePlayerStats(filterIds) {
  const statsMap = {};

  function ensurePlayer(key, displayName) {
    if (!statsMap[key]) {
      statsMap[key] = {
        name: displayName,
        netPoints: 0,
        oneWins: 0,
        allWins: 0,
        oneLosses: 0,
        allLosses: 0,
      };
    }
    return statsMap[key];
  }

  const files = fs.readdirSync(MATCHES_DIR).filter(f => f.endsWith('.csv'));

  for (const f of files) {
    const id = f.replace('.csv', '');
    if (filterIds && !filterIds.includes(id)) continue;

    const { metaRow, rounds } = parseMatchFile(path.join(MATCHES_DIR, f));
    const info = metaToInfo(metaRow);
    const players = [info.p1, info.p2, info.p3, info.p4];
    const { scores } = computeScores(players, rounds);

    if (rounds.length > 0) {
      for (const p of players) {
        const key = p.toLowerCase();
        ensurePlayer(key, p).netPoints += scores[p];
      }
    }

    for (const round of rounds) {
      const wKey = round.winner.toLowerCase();
      ensurePlayer(wKey, round.winner);

      if (round.type === 'ONE') {
        statsMap[wKey].oneWins++;
        if (round.loser1) {
          ensurePlayer(round.loser1.toLowerCase(), round.loser1).oneLosses++;
        }
      } else if (round.type === 'ALL') {
        statsMap[wKey].allWins++;
        for (const loser of [round.loser1, round.loser2, round.loser3]) {
          if (loser) ensurePlayer(loser.toLowerCase(), loser).allLosses++;
        }
      }
    }
  }

  return Object.values(statsMap)
    .filter(p => p.netPoints || p.oneWins || p.allWins || p.oneLosses || p.allLosses)
    .sort((a, b) => b.netPoints - a.netPoints);
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// GET /api/matches — list all matches
app.get('/api/matches', (req, res) => {
  try {
    const files = fs.readdirSync(MATCHES_DIR).filter(f => f.endsWith('.csv'));
    const matches = files.map(f => {
      const id = f.replace('.csv', '');
      const { metaRow, rounds } = parseMatchFile(path.join(MATCHES_DIR, f));
      const info = metaToInfo(metaRow);
      return {
        id,
        players:    [info.p1, info.p2, info.p3, info.p4],
        date:       info.date,
        status:     info.status,
        roundCount: rounds.length
      };
    });
    matches.sort((a, b) => b.id.localeCompare(a.id));
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats — cumulative player stats (optional ?ids=id1,id2 filter)
app.get('/api/stats', (req, res) => {
  try {
    const filterIds = req.query.ids
      ? req.query.ids.split(',').filter(Boolean)
      : null;
    res.json({ players: computePlayerStats(filterIds) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/matches — create a new match
app.post('/api/matches', (req, res) => {
  try {
    const { players } = req.body;
    if (!players || players.length !== 4) {
      return res.status(400).json({ error: 'Exactly 4 player names required' });
    }
    if (players.some(p => !p || p.includes(','))) {
      return res.status(400).json({ error: 'Player names cannot be empty or contain commas' });
    }

    const date  = new Date().toISOString().split('T')[0];
    const uuid  = uuidv4().replace(/-/g, '').substring(0, 8);
    const id    = `${date}_${uuid}`;

    writeMatchFile(getMatchPath(id), {
      p1: players[0], p2: players[1], p3: players[2], p4: players[3],
      date, status: 'active'
    }, []);

    res.json({ id, players, date, status: 'active' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/matches/:id — get full match data
app.get('/api/matches/:id', (req, res) => {
  try {
    const filePath = getMatchPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Match not found' });

    const { metaRow, rounds } = parseMatchFile(filePath);
    const info    = metaToInfo(metaRow);
    const players = [info.p1, info.p2, info.p3, info.p4];
    const { scores, history } = computeScores(players, rounds);

    res.json({ id: req.params.id, players, date: info.date, status: info.status, scores, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/matches/:id/rounds — add a round
app.post('/api/matches/:id/rounds', (req, res) => {
  try {
    const filePath = getMatchPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Match not found' });

    const { metaRow, rounds } = parseMatchFile(filePath);
    const info = metaToInfo(metaRow);
    if (info.status === 'ended') return res.status(400).json({ error: 'Match has already ended' });

    const { type, winner, loser1, tai1, loser2, tai2, loser3, tai3 } = req.body;
    if (!type || !winner) return res.status(400).json({ error: 'type and winner are required' });
    if (type !== 'ONE' && type !== 'ALL') return res.status(400).json({ error: 'type must be ONE or ALL' });

    rounds.push({
      round_num: String(rounds.length + 1),
      type, winner,
      loser1: loser1 || '', tai1: tai1 !== undefined ? String(tai1) : '0',
      loser2: loser2 || '', tai2: tai2 !== undefined ? String(tai2) : '',
      loser3: loser3 || '', tai3: tai3 !== undefined ? String(tai3) : '',
    });

    writeMatchFile(filePath, info, rounds);

    const players = [info.p1, info.p2, info.p3, info.p4];
    const { scores, history } = computeScores(players, rounds);
    res.json({ scores, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/matches/:id/rounds/last — undo last round
app.delete('/api/matches/:id/rounds/last', (req, res) => {
  try {
    const filePath = getMatchPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Match not found' });

    const { metaRow, rounds } = parseMatchFile(filePath);
    if (rounds.length === 0) return res.status(400).json({ error: 'No rounds to undo' });

    const info = metaToInfo(metaRow);
    rounds.pop();
    writeMatchFile(filePath, info, rounds);

    const players = [info.p1, info.p2, info.p3, info.p4];
    const { scores, history } = computeScores(players, rounds);
    res.json({ scores, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/matches/:id/end — end match
app.post('/api/matches/:id/end', (req, res) => {
  try {
    const filePath = getMatchPath(req.params.id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Match not found' });

    const { metaRow, rounds } = parseMatchFile(filePath);
    const info = metaToInfo(metaRow);
    info.status = 'ended';
    writeMatchFile(filePath, info, rounds);
    res.json({ status: 'ended' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  Match Tracker running at http://localhost:${PORT}\n`);
});
