// AWS-SDK v2 preload — points DynamoDB + SQS at our local docker stores over
// HTTP, WITHOUT touching their code. Load with `node -r <this> index.js`.
// Runs before any app module, so it patches the SDK before DocumentClient.js
// (which builds `new DynamoDB.DocumentClient` with an https agent + no endpoint).
// resolve aws-sdk from the APP's node_modules (cwd), not this file's folder
const AWS = require(require.resolve('aws-sdk', { paths: [process.cwd(), ...module.paths] }));

const REGION = process.env.AWS_REGION || 'ap-south-1';
AWS.config.update({ region: REGION, accessKeyId: 'local', secretAccessKey: 'local' });

const DDB_ENDPOINT = process.env.DYNAMO_ENDPOINT || 'http://localhost:8000';
const SQS_ENDPOINT = process.env.SQS_ENDPOINT || 'http://localhost:9324';

// force local endpoint + plain http (strip the keepAlive https agent) on every
// DynamoDB / DocumentClient the app constructs.
function localize(opts = {}) {
  return { ...opts, endpoint: DDB_ENDPOINT, sslEnabled: false, httpOptions: {} };
}
const OrigDDB = AWS.DynamoDB;
const OrigDoc = AWS.DynamoDB.DocumentClient;
function DDB(opts) { return new OrigDDB(localize(opts)); }
DDB.DocumentClient = function DocumentClient(opts) { return new OrigDoc(localize(opts)); };
DDB.DocumentClient.prototype = OrigDoc.prototype;
Object.setPrototypeOf(DDB, OrigDDB);
AWS.DynamoDB = DDB;

const OrigSQS = AWS.SQS;
// aws-sdk v2 SQS derives the request host from params.QueueUrl (ignoring the
// client endpoint). SqsService hardcodes https://sqs.<region>.amazonaws.com/…,
// so rewrite any such QueueUrl to our local elasticmq, keeping only the path.
function localQueueUrl(qurl) {
  if (typeof qurl !== 'string' || qurl.startsWith(SQS_ENDPOINT)) return qurl;
  try { return SQS_ENDPOINT + new URL(qurl).pathname; } catch { return qurl; }
}
// v2 attaches operation methods (sendMessage…) to the instance/prototype lazily,
// so patch each constructed instance here rather than the prototype at preload.
function wrapInstance(inst) {
  for (const m of ['sendMessage', 'receiveMessage', 'deleteMessage', 'getQueueUrl', 'sendMessageBatch']) {
    const orig = inst[m];
    if (typeof orig !== 'function') continue;
    inst[m] = function patched(params, cb) {
      if (params && params.QueueUrl) params = { ...params, QueueUrl: localQueueUrl(params.QueueUrl) };
      return orig.call(this, params, cb);
    };
  }
  return inst;
}
AWS.SQS = function SQS(opts = {}) { return wrapInstance(new OrigSQS({ ...opts, endpoint: SQS_ENDPOINT, sslEnabled: false })); };
Object.setPrototypeOf(AWS.SQS, OrigSQS);

console.log(`[aws-local] DynamoDB → ${DDB_ENDPOINT}  SQS → ${SQS_ENDPOINT}  (http, region ${REGION})`);
