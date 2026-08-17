// Wallet stub — stands in for the external wallet API the distribution engine
// calls (POST /wallet/batch-process). Credits winners' balances in our local
// bb_users (MySQL) so the settlement loop closes with a real balance change,
// without standing up the whole wallet microservice.
//
//   node drivers/wallet-stub/index.mjs   (listens on :3000)
import http from 'node:http';
import mysql from 'mysql2/promise';
import { MYSQL } from '../../setup/local.mjs';

const PORT = process.env.WALLET_STUB_PORT || 3000;
const db = await mysql.createPool(MYSQL);

// Ledger. Every balance mutation funnels through this service (placeBid debit,
// settlement credit), so recording here captures the complete history with no
// way for a movement to bypass it. Amounts are stored in POINTS, the same unit
// as bb_users.unused_amount (100 points = $1) — the API converts for display.
await db.query(`CREATE TABLE IF NOT EXISTS bb_wallet_txns (
  txn_id     BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  kind       VARCHAR(16) NOT NULL,          -- debit | credit
  amount     DECIMAL(16,2) NOT NULL,        -- signed, POINTS
  balance_after DECIMAL(16,2) NOT NULL,     -- POINTS, after this movement
  note       VARCHAR(190) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_user_time (user_id, txn_id)
)`);

// Record a movement and return the resulting balance. Reads the balance back
// inside the same call so `balance_after` is the real post-update figure rather
// than a recomputed guess.
async function recordTxn(userId, signedPoints, note) {
  try {
    const [[row]] = [await db.query('SELECT unused_amount FROM bb_users WHERE user_id = ?', [userId])];
    const after = Number(row?.[0]?.unused_amount ?? 0);
    await db.query(
      'INSERT INTO bb_wallet_txns (user_id, kind, amount, balance_after, note) VALUES (?,?,?,?,?)',
      [userId, signedPoints < 0 ? 'debit' : 'credit', signedPoints, after, (note || '').slice(0, 190)]);
  } catch (e) { console.error('  [wallet] ledger write failed:', e.message); }
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const money = (points) => `$${(Number(points) / 100).toFixed(2)}`;

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x');

    // GET /wallet/fetch-wallet?userId= — trading-api reads balance before debiting
    if (req.method === 'GET' && u.pathname === '/wallet/fetch-wallet') {
      const uid = u.searchParams.get('userId');
      const [rows] = await db.query('SELECT unused_amount, credits FROM bb_users WHERE user_id = ?', [uid]);
      const w = rows[0] || { unused_amount: 0, credits: 0 };
      return json(res, 200, { userWallet: { unused: Number(w.unused_amount), winning: Number(w.credits), otherPromo: 0, currency: 'INR' } });
    }

    if (req.method !== 'POST') return json(res, 404, { error: 'not found' });
    const body = await readBody(req);

    // POST /wallet/debit | /wallet/credit — the placeBid debit path
    if (u.pathname === '/wallet/debit' || u.pathname === '/wallet/credit') {
      const m = JSON.parse(body || '{}');
      // amount lives on the txn model; pull the first sensible number we recognise
      const amt = Number(m.amount ?? m.debitAmount ?? m.investment ?? m.totalAmount ?? m.txnAmount ?? 0);
      const uid = m.user_id ?? m.userId ?? m.userid;
      const sign = u.pathname.endsWith('debit') ? -1 : 1;
      if (uid && amt) {
        await db.query('UPDATE bb_users SET unused_amount = unused_amount + ? WHERE user_id = ?', [sign * amt, uid]);
        await recordTxn(uid, sign * amt, m.note || m.market_id || (sign < 0 ? 'order placed' : 'credit'));
        console.log(`  [wallet] ${sign < 0 ? 'debit' : 'credit'} user ${uid} ${sign < 0 ? '-' : '+'}${money(amt)}`);
      }
      // the controller reads walletResp.walletBifurcation.{unused,winning,otherPromo}
      return json(res, 200, { walletBifurcation: { unused: amt, winning: 0, otherPromo: 0 }, transaction_id: m.transaction_id || 'local' });
    }

    // POST /wallet/batch-process — settlement payout path (unchanged)
    if (u.pathname.startsWith('/wallet/batch-process')) {
      const { batchId, txn = [] } = JSON.parse(body || '{}');
      let credited = 0;
      for (const t of txn) {
        const uid = t.user_id ?? t.userId;
        const amt = Number(t.unused ?? t.creditAmount ?? t.amount ?? 0);
        if (uid && amt) {
          await db.query('UPDATE bb_users SET unused_amount = unused_amount + ? WHERE user_id = ?', [amt, uid]);
          await recordTxn(uid, amt, t.note || (t.market_id ? `settlement ${t.market_id}` : `payout ${batchId}`));
          credited += amt;
          console.log(`  [wallet] credited user ${uid} +${money(amt)} (batch ${batchId})`);
        }
      }
      return json(res, 200, { success: true, batchId, credited, processed: txn.length });
    }
    return json(res, 404, { error: 'not found' });
  } catch (e) {
    json(res, 500, { success: false, error: String(e) });
  }
}).listen(PORT, () => console.log(`[wallet-stub] listening on :${PORT} (fetch-wallet · debit/credit · batch-process)`));
