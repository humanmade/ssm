const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');
const { Server } = require('ws');
const Session = require('../build/aws-ssm-session').default;
const { encode, decode } = require('../build/agent-message');
const { MessageType, PayloadType } = require('../build/channel-messages');

test('real WebSocket handshake and binary round trip preserve bytes across frame boundaries', { timeout: 10000 }, async t => {
  const server = new Server({ host: '127.0.0.1', port: 0 });
  let session;
  t.after(async () => {
    session?.close();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
  });
  await once(server, 'listening');
  const expected = Buffer.from(Array.from({ length: 8195 }, (_, i) => i % 256));
  let responseCount = 0;
  const complete = new Promise((resolve, reject) => {
    server.on('connection', socket => {
      let authenticated = false;
      let sequence = 0;
      socket.on('message', data => {
        try {
          if (!authenticated) {
            assert.equal(JSON.parse(data.toString()).TokenValue, 'synthetic-token');
            authenticated = true;
            socket.send(encode({ MessageType: MessageType.OutputStreamDataMessage, SequenceNumber: sequence++, PayloadType: PayloadType.HandshakeRequest,
              Payload: JSON.stringify({ RequestedClientActions: [{ ActionType: 'SessionType', ActionParameters: { SessionType: 'Port', Properties: { type: 'LocalPortForwarding' } } }] }) }));
            return;
          }
          const message = decode(new Uint8Array(data));
          if (message.MessageType === MessageType.AcknowledgeMessage) return;
          socket.send(encode({ MessageType: MessageType.AcknowledgeMessage, SequenceNumber: 0, Flags: 3,
            PayloadType: PayloadType.Output, Payload: JSON.stringify({ AcknowledgedMessageSequenceNumber: message.SequenceNumber }) }));
          if (message.PayloadType === PayloadType.HandshakeResponse) {
            responseCount++;
            assert.equal(JSON.parse(message.Payload).ClientVersion, '1.1.69');
            socket.send(encode({ MessageType: MessageType.OutputStreamDataMessage, SequenceNumber: sequence++, PayloadType: PayloadType.HandshakeComplete, Payload: '{}' }));
          } else {
            assert.equal(message.PayloadType, PayloadType.Output);
            assert.ok(message.PayloadBytes.length <= 1024);
            socket.send(encode({ MessageType: MessageType.OutputStreamDataMessage, SequenceNumber: sequence++, PayloadType: PayloadType.Output, Payload: message.PayloadBytes }));
          }
        } catch (error) { reject(error); }
      });
    });
    session = new Session(`ws://127.0.0.1:${server.address().port}`, 'synthetic-session', 'synthetic-token');
    const received = [];
    let count = 0;
    session.on('disconnect', reason => { if (count !== expected.length) reject(new Error(reason || 'Premature disconnect')); });
    session.on('handshake', () => session.sendHandshakeResponse({ ClientVersion: '1.1.69', Errors: [], ProcessedClientActions: [{ ActionType: 'SessionType', ActionStatus: 1 }] }));
    session.on('handshakeComplete', () => session.writeRaw(expected));
    session.on('rawOutput', data => {
      received.push(Buffer.from(data)); count += data.length;
      if (count === expected.length) {
        try {
          assert.deepEqual(Buffer.concat(received), expected);
          assert.equal(responseCount, 1);
          resolve();
        } catch (error) { reject(error); }
      }
    });
  });
  await complete;
});
