// Shared local-stack connection config. Everything points at the docker-compose
// services on localhost. Dummy AWS creds — dynamodb-local ignores them.
// Hosts are env-overridable so the same code runs two ways: directly on the
// host (the defaults below, unchanged) and inside docker-compose, where
// containers reach each other by service name rather than localhost. Without
// this, a containerised process resolves "localhost" to its own container.
const env = process.env;

export const REGION = env.AWS_REGION || 'ap-south-1';
export const DDB_ENDPOINT = env.DDB_ENDPOINT || 'http://localhost:8000';
export const AWS_CREDS = { accessKeyId: 'local', secretAccessKey: 'local' };

export const MYSQL = {
  host: env.MYSQL_HOST || '127.0.0.1',
  port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER || 'root',
  password: env.MYSQL_PASSWORD || 'local',
  database: env.MYSQL_DATABASE || 'predictor',
  multipleStatements: true,
};

export const REDIS = {
  host: env.REDIS_HOST || '127.0.0.1',
  port: Number(env.REDIS_PORT || 6379),
};

// table names (match matching-engine Constants defaults)
export const TABLES = {
  market: 'market',
  pendingBids: 'bb_pending_bids',
  users: 'bb_users',
  availableBidsPrefix: 'bb_available_bids_', // + {yes|no}_{marketId}, created per market
};

// MMP house user + a couple of test users
export const MMP_USER_ID = 999999999;
export const TEST_USERS = [100001, 100002, 100003];
