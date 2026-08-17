// SQS → matcher bridge. In QA the matching-engine lambda is triggered by the
// place-bid SQS queue. Locally there is no lambda trigger, so this poller reads
// matching-engine.fifo (elasticmq) and POSTs each message body to the matcher's
// /handle route — exactly the record the lambda would receive.
//
//   node drivers/sqs-bridge/index.mjs
import { SQSClient, GetQueueUrlCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { REGION } from '../../setup/local.mjs';

const SQS_ENDPOINT = process.env.SQS_ENDPOINT || 'http://localhost:9324';
const MATCHER_URL = process.env.MATCHER_URL || 'http://localhost:7001';
// matcher /handle runs the MatchingEngine, which handles buy (bidType 0) AND
// sell (bidType 1). Cancel is a separate lambda not exposed over HTTP, so we
// don't drain cancel-order.fifo here (that would need a repo change → Stage 1).
const QUEUE_NAMES = (process.env.BRIDGE_QUEUES || 'matching-engine.fifo,sell-order.fifo').split(',');

const sqs = new SQSClient({ region: REGION, endpoint: SQS_ENDPOINT, credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });

const queues = [];
for (const name of QUEUE_NAMES) {
  try { const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: name })); queues.push({ name, QueueUrl }); }
  catch (e) { console.error(`[sqs-bridge] skip ${name}: ${e.message}`); }
}
console.log(`[sqs-bridge] polling [${queues.map((q) => q.name).join(', ')}] → ${MATCHER_URL}/handle`);

async function forward(q, msg) {
  const bid = JSON.parse(msg.Body);
  // the matcher /handle expects the raw bid body (the SQS record's body)
  const r = await fetch(`${MATCHER_URL}/handle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bid),
  });
  const txt = await r.text();
  const kind = bid.bidType === 1 ? 'sell' : 'buy';
  console.log(`  → [${q.name}] ${kind} ${bid.bidId} (u${bid.userId} opt${bid.optionId} x${bid.bidCount}) → matcher ${r.status} ${txt.slice(0, 120)}`);
  await sqs.send(new DeleteMessageCommand({ QueueUrl: q.QueueUrl, ReceiptHandle: msg.ReceiptHandle }));
}

while (true) {
  for (const q of queues) {
    try {
      const { Messages } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: q.QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30,
      }));
      for (const m of Messages || []) {
        try { await forward(q, m); } catch (e) { console.error('  forward error:', e.message); }
      }
    } catch (e) {
      console.error(`[sqs-bridge] poll error (${q.name}):`, e.message);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
