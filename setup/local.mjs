// Shared local-stack connection config. Everything points at the docker-compose
// services on localhost. Dummy AWS creds — dynamodb-local ignores them.
export const REGION = 'ap-south-1';
export const DDB_ENDPOINT = 'http://localhost:8000';
export const AWS_CREDS = { accessKeyId: 'local', secretAccessKey: 'local' };

export const MYSQL = {
  host: '127.0.0.1', port: 3306, user: 'root', password: 'local', database: 'predictor',
  multipleStatements: true,
};

export const REDIS = { host: '127.0.0.1', port: 6379 };

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
