// AWS Secrets Manager stub — stands in for the secret the distribution engine
// fetches at boot (src/awsSecrets.ts → GetSecretValue).
//
// WHY THIS EXISTS: gb-trading-distribution-engine-se hardcodes `app.port = 3000`
// and `wallet.base_url = 'http://localhost:3000'` in src/config.ts. Locally that
// is self-contradictory — it would bind :3000 and then call ITSELF for wallet
// payouts, colliding with our wallet-stub. loadConfig() only overrides those two
// (SERVER_PORT / WALLET_BASE_URL) when Secrets Manager returns a non-empty
// secret. So rather than patch their repo (off-limits), we answer the secret
// call locally and hand back the right ports. Same spirit as wallet-stub /
// elasticmq / dynamodb-local: their code runs unmodified, we supply the edges.
//
// The distribution engine reaches this via AWS SDK v3's endpoint override:
//   AWS_ENDPOINT_URL_SECRETS_MANAGER=http://localhost:4566
//
//   node drivers/secrets-stub/index.mjs   (listens on :4566)
import http from 'node:http';

const PORT = Number(process.env.SECRETS_STUB_PORT || 4566);

// Mirrors the `Secrets` shape consumed by distribution-engine src/config.ts.
const SECRET = {
  ENVIRONMENT: 'local',
  // The whole point: move the engine off :3000 so wallet-stub can own it.
  SERVER_PORT: 3010,
  WALLET_BASE_URL: 'http://localhost:3000',

  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: 6379,

  // matching DB (MySQL) — same predictor DB the matcher/trading-api use
  MYSQL_HOST: '127.0.0.1',
  MYSQL_PORT: 3306,
  MYSQL_USER: 'root',
  MYSQL_PASSWORD: 'local',
  MYSQL_DATABASE: 'predictor',

  // wallet ledger DB (Postgres) — docker-compose `postgres` service
  WALLET_MySQL_HOST: '127.0.0.1',
  WALLET_MySQL_PORT: 5432,
  WALLET_MySQL_USER: 'root',
  WALLET_MySQL_PASSWORD: '12345678',
  WALLET_MySQL_DATABASE: 'user',

  AWS_REGION: 'ap-south-1',
  PRE_DISTRIBUTION_THRESHOLD: 100,
  ALERT_URL: '',

  // local elasticmq queues (see localstack/elasticmq.conf)
  SQS_QUEUE_URL: 'http://localhost:9324/000000000000/distribution-sqs.fifo',
  MARKET_EVENT_QUEUE_URL: 'http://localhost:9324/000000000000/market-events-queue',

  MATCH_SERVICE_BASE_URL: 'http://localhost:7001',
  MATCH_SERVICE_TOKEN: '',
};

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const target = String(req.headers['x-amz-target'] || '');
    // Only GetSecretValue is exercised; anything else gets a benign empty reply
    // so an unexpected call can't wedge the engine's boot.
    if (target.includes('GetSecretValue')) {
      let secretId = 'unknown';
      try { secretId = JSON.parse(body || '{}').SecretId ?? 'unknown'; } catch { /* ignore */ }
      console.log(`  [secrets] GetSecretValue ${secretId} → SERVER_PORT=${SECRET.SERVER_PORT} WALLET_BASE_URL=${SECRET.WALLET_BASE_URL}`);
      res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.1' });
      return res.end(JSON.stringify({
        ARN: `arn:aws:secretsmanager:ap-south-1:000000000000:secret:${secretId}`,
        Name: secretId,
        VersionId: 'local',
        SecretString: JSON.stringify(SECRET),
        VersionStages: ['AWSCURRENT'],
      }));
    }
    res.writeHead(200, { 'Content-Type': 'application/x-amz-json-1.1' });
    res.end('{}');
  });
}).listen(PORT, () => console.log(`[secrets-stub] listening on :${PORT} (GetSecretValue → local distribution-engine config)`));
