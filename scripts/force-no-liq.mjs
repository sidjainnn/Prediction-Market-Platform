import mysql from 'mysql2/promise';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { REGION, DDB_ENDPOINT, AWS_CREDS, MYSQL, MMP_USER_ID } from '../setup/local.mjs';
import { cancelRestingRows } from '../drivers/lib/pricing.mjs';

const marketId = process.argv[2];
const db = await mysql.createPool(MYSQL);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION, endpoint: DDB_ENDPOINT, credentials: AWS_CREDS }));

const n = await cancelRestingRows(marketId, 'no', MMP_USER_ID, db, ddb);
console.log(`cancelled ${n} NO-side house rows for ${marketId}`);
process.exit(0);
