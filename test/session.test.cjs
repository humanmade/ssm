const assert = require('node:assert/strict');
const test = require('node:test');

class WebSocket {
  constructor() { this.readyState = 0; this.sent = []; this.pings = []; }
  send(data) { this.sent.push(typeof data === 'string' ? data : Uint8Array.from(data)); }
  ping(data) { this.pings.push(data); }
  open() { this.readyState = 1; this.onopen({}); }
  receive(data) { this.onmessage({ data: Uint8Array.from(data).buffer }); }
  close() { this.readyState = 3; this.onclose({ reason: '' }); }
}
const wsPath = require.resolve('isomorphic-ws');
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: WebSocket };
const Session = require('../build/aws-ssm-session').default;
const { encode, decode } = require('../build/agent-message');
const { MessageType, PayloadType, PayloadTypeFlag, ActionStatus } = require('../build/channel-messages');
function create(t, opened = true) {
  const session = new Session('wss://example.test', 'test-session', 'test-token');
  t.after(() => session.close());
  if (opened) { session.webSocket.open(); session.webSocket.sent = []; }
  return session;
}
function incoming(session, payload, type = PayloadType.Output, seq = session.expectedSequenceNumber, messageType = MessageType.OutputStreamDataMessage) {
  session.webSocket.receive(encode({ MessageType: messageType, PayloadType: type, SequenceNumber: seq,
    Payload: typeof payload === 'object' && !(payload instanceof Uint8Array) ? JSON.stringify(payload) : payload }));
}
function control(session, type) {
  const bytes = new Uint8Array(120); bytes.set(Buffer.from(type), 4); session.webSocket.receive(bytes);
}
function sent(session, type = MessageType.InputStreamDataMessage) {
  return session.webSocket.sent.filter(data => typeof data !== 'string').map(decode).filter(message => message.MessageType === type);
}
function ack(session, sequence) {
  incoming(session, { AcknowledgedMessageSequenceNumber: sequence }, PayloadType.Output, 0, MessageType.AcknowledgeMessage);
}

test('large binary writes are split into 1024-byte frames and preserve all bytes including lone LF', t => {
  const session = create(t);
  const data = Uint8Array.from({ length: 65539 }, (_, i) => i % 256);
  session.writeRaw(data);
  const messages = sent(session);
  assert.equal(messages.length, 65);
  assert.ok(messages.every(message => message.PayloadBytes.length <= 1024));
  assert.deepEqual(Buffer.concat(messages.map(message => Buffer.from(message.PayloadBytes))), Buffer.from(data));
  assert.deepEqual(messages.map(message => message.SequenceNumber), Array.from({ length: 65 }, (_, i) => i));
  session.writeRaw(Uint8Array.of(10));
  assert.deepEqual(Array.from(sent(session).at(-1).PayloadBytes), [10]);
});

test('binary output remains ordered and duplicate frames are acknowledged without redelivery', t => {
  const session = create(t);
  const output = [];
  session.on('rawOutput', bytes => output.push(...bytes));
  incoming(session, Uint8Array.of(255), PayloadType.Output, 2);
  incoming(session, Uint8Array.of(0), PayloadType.Output, 0);
  incoming(session, Uint8Array.of(128), PayloadType.Output, 1);
  incoming(session, Uint8Array.of(128), PayloadType.Output, 1);
  assert.deepEqual(output, [0, 128, 255]);
  assert.equal(sent(session, MessageType.AcknowledgeMessage).length, 4);
});

test('terminal output still preserves split UTF-8 and NUL bytes', t => {
  const session = create(t);
  let output = '';
  session.on('output', text => { output += text; });
  incoming(session, Uint8Array.of(0xe2));
  incoming(session, Uint8Array.of(0x82));
  incoming(session, Uint8Array.of(0xac, 0));
  assert.equal(output, '€\0');
});

test('manual port handshake sends one response, exposes completion, and does not emit control JSON as raw data', t => {
  const session = create(t);
  const raw = [];
  let complete;
  session.on('rawOutput', data => raw.push(data));
  session.on('handshake', request => {
    assert.equal(request.RequestedClientActions[0].ActionParameters.SessionType, 'Port');
    session.sendHandshakeResponse({ ClientVersion: '1.1.69', Errors: [],
      ProcessedClientActions: [{ ActionType: 'SessionType', ActionStatus: ActionStatus.Success }] });
  });
  session.on('handshakeComplete', data => { complete = data; });
  incoming(session, { RequestedClientActions: [{ ActionType: 'SessionType', ActionParameters: { SessionType: 'Port' } }] }, PayloadType.HandshakeRequest);
  incoming(session, { CustomerMessage: 'Ready' }, PayloadType.HandshakeComplete);
  assert.equal(sent(session).filter(message => message.PayloadType === PayloadType.HandshakeResponse).length, 1);
  assert.deepEqual(complete, { CustomerMessage: 'Ready' });
  assert.deepEqual(raw, []);
});

test('automatic terminal handshake remains available and rejects KMS encryption and unknown session types', t => {
  const session = create(t);
  incoming(session, { RequestedClientActions: [
    { ActionType: 'SessionType', ActionParameters: { SessionType: 'Standard_Stream' } },
    { ActionType: 'KMSEncryption', ActionParameters: {} },
    { ActionType: 'SessionType', ActionParameters: { SessionType: 'Unknown' } },
  ] }, PayloadType.HandshakeRequest);
  const response = JSON.parse(sent(session)[0].Payload);
  assert.deepEqual(response.ProcessedClientActions.map(action => action.ActionStatus), [1, 3, 3]);
  assert.equal(response.Errors.length, 2);
});

test('a Port handshake without an explicit consumer is not silently accepted', t => {
  const session = create(t);
  incoming(session, { RequestedClientActions: [{ ActionType: 'SessionType', ActionParameters: { SessionType: 'Port' } }] }, PayloadType.HandshakeRequest);
  assert.equal(JSON.parse(sent(session)[0].Payload).ProcessedClientActions[0].ActionStatus, ActionStatus.Unsupported);
});

test('publication pause queues data, resume flushes it in order, and sequence numbers never rewind', t => {
  const session = create(t);
  session.writeRaw(Uint8Array.of(1));
  control(session, 'pause_publication');
  session.writeRaw(Uint8Array.of(2)); session.writeRaw(Uint8Array.of(3));
  assert.equal(sent(session).length, 1);
  control(session, 'start_publication');
  session.writeRaw(Uint8Array.of(4));
  assert.deepEqual(sent(session).map(message => message.SequenceNumber), [0, 1, 2, 3]);
  assert.deepEqual(sent(session).map(message => message.PayloadBytes[0]), [1, 2, 3, 4]);
});

test('acknowledgements use sequence 0 and flags 3 without advancing the outgoing stream', t => {
  const session = create(t);
  incoming(session, 'x');
  const bytes = Buffer.from(session.webSocket.sent[0]);
  assert.equal(bytes.readBigUInt64BE(48), 0n);
  assert.equal(bytes.readBigUInt64BE(56), 3n);
  assert.equal(session.outgoingSequenceNumber, 0);
});

test('unacknowledged binary data is retransmitted unchanged and stops after acknowledgement', t => {
  const session = create(t);
  session.writeRaw(Uint8Array.of(0, 255));
  session.outgoingMessageBuffer[0].lastSentTime = Date.now() - 2000;
  session.resendUnacknowledgedMessage();
  assert.deepEqual(session.webSocket.sent[0], session.webSocket.sent[1]);
  ack(session, 0);
  session.resendUnacknowledgedMessage();
  assert.equal(session.webSocket.sent.length, 2);
  assert.equal(session.outgoingMessageBuffer.length, 0);
});

test('publication pause also suspends retransmission', t => {
  const session = create(t);
  session.writeRaw(Uint8Array.of(1));
  session.outgoingMessageBuffer[0].lastSentTime = Date.now() - 2000;
  control(session, 'pause_publication');
  session.resendUnacknowledgedMessage();
  assert.equal(sent(session).length, 1);
});

test('full outgoing buffers reject an entire binary write without dropping queued frames', t => {
  const session = create(t);
  const pending = { sequenceNumber: 0, data: Uint8Array.of(1), lastSentTime: 0, sent: true, resendAttempts: 0 };
  session.outgoingMessageBuffer = Array(9999).fill(pending);
  assert.throws(() => session.writeRaw(new Uint8Array(1025)), /partially write/);
  assert.equal(session.outgoingMessageBuffer.length, 9999);
  assert.equal(session.webSocket.sent.length, 0);
  assert.equal(session.outgoingSequenceNumber, 0);
});

test('write before WebSocket open fails instead of silently discarding data', t => {
  const session = create(t, false);
  assert.throws(() => session.writeRaw(Uint8Array.of(1)), /not open/);
  assert.equal(session.outgoingSequenceNumber, 0);
});

test('WebSocket keepalives never enter the SSM application stream', t => {
  const session = create(t);
  session.ping();
  assert.deepEqual(session.webSocket.pings, ['keepalive']);
  assert.equal(session.webSocket.sent.length, 0);
  assert.equal(session.outgoingSequenceNumber, 0);
});

test('control flags use their own payload type and a 32-bit big-endian value', t => {
  const session = create(t);
  session.sendFlag(PayloadTypeFlag.DisconnectToPort);
  session.sendFlag(PayloadTypeFlag.TerminateSession);
  assert.deepEqual(sent(session).map(message => message.PayloadType), [10, 10]);
  assert.deepEqual(sent(session).map(message => Array.from(message.PayloadBytes)), [[0, 0, 0, 1], [0, 0, 0, 2]]);
  let flag;
  session.on('flag', value => { flag = value; });
  incoming(session, Uint8Array.of(0, 0, 0, 3), PayloadType.Flag);
  assert.equal(flag, PayloadTypeFlag.ConnectToPortError);
});

test('corrupted frames are not acknowledged or delivered and disconnect without leaking payloads', t => {
  const session = create(t);
  let reason;
  session.on('disconnect', value => { reason = value; });
  session.on('rawOutput', () => assert.fail('Corrupted data must not be delivered'));
  const frame = encode({ MessageType: MessageType.OutputStreamDataMessage, SequenceNumber: 0,
    PayloadType: PayloadType.Output, Payload: 'secret' });
  frame[120] ^= 1;
  session.webSocket.receive(frame);
  assert.equal(session.webSocket.sent.length, 0);
  assert.equal(session.connectionClosed, true);
  assert.ok(!reason.includes('secret'));
});

test('WebSocket errors notify disconnect once and clear both timers', t => {
  const session = create(t);
  let disconnects = 0;
  session.on('disconnect', () => { disconnects++; });
  session.webSocket.onerror({ message: 'test-token' });
  session.webSocket.onclose({ reason: '' });
  assert.equal(disconnects, 1);
  assert.equal(session.resendTimer, undefined);
  assert.equal(session.keepaliveTimer, undefined);
});

test('retransmission exhaustion fails the connection rather than retrying forever', t => {
  const session = create(t);
  let reason;
  session.on('disconnect', value => { reason = value; });
  session.writeRaw(Uint8Array.of(1));
  session.outgoingMessageBuffer[0].lastSentTime = Date.now() - 2000;
  session.outgoingMessageBuffer[0].resendAttempts = 300;
  session.resendUnacknowledgedMessage();
  assert.match(reason, /timed out/);
  assert.equal(session.connectionClosed, true);
});

test('channel_closed closes the WebSocket and clears the retransmission state', t => {
  const session = create(t);
  incoming(session, {}, PayloadType.Output, 0, MessageType.ChannelClosedMessage);
  assert.equal(session.connectionTerminated, true);
  assert.equal(session.connectionClosed, true);
  assert.equal(session.keepaliveTimer, undefined);
});

test('automatic keepalive matches AWS five-minute interval and is cancelled on close', () => {
  const originalSet = global.setInterval;
  const originalClear = global.clearInterval;
  const timers = [];
  let session;
  try {
    global.setInterval = (callback, interval) => {
      const timer = { callback, interval, cleared: false };
      timers.push(timer);
      return timer;
    };
    global.clearInterval = timer => { timer.cleared = true; };
    session = new Session('wss://example.test', 'test-session', 'test-token');
    session.webSocket.open();
    const keepalive = timers.find(timer => timer.interval === 300000);
    assert.ok(keepalive);
    keepalive.callback();
    assert.deepEqual(session.webSocket.pings, ['keepalive']);
    session.close();
    assert.ok(timers.every(timer => timer.cleared));
  } finally {
    session?.close();
    global.setInterval = originalSet;
    global.clearInterval = originalClear;
  }
});

test('large terminal input shares binary-safe framing and retains UTF-8 bytes', t => {
  const session = create(t);
  const text = '€\0'.repeat(1000);
  session.write(text);
  assert.deepEqual(Buffer.concat(sent(session).map(message => Buffer.from(message.PayloadBytes))), Buffer.from(text));
  assert.ok(sent(session).every(message => message.PayloadBytes.length <= 1024));
});
