const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { encode, decode } = require('../build/agent-message');
const { MessageType, PayloadType } = require('../build/channel-messages');

function frame(payload, sequence = 0) {
  // Independent construction from AWS's ClientMessage offsets, including the
  // least-significant UUID half first. No use of this package's encoder.
  const bytes = Buffer.alloc(120 + payload.length);
  bytes.writeUInt32BE(116, 0);
  bytes.write('output_stream_data', 4, 'ascii');
  bytes.writeUInt32BE(1, 36);
  bytes.writeBigUInt64BE(1700000000000n, 40);
  bytes.writeBigUInt64BE(BigInt(sequence), 48);
  Buffer.from('8899aabbccddeeff0011223344556677', 'hex').copy(bytes, 64);
  crypto.createHash('sha256').update(payload).digest().copy(bytes, 80);
  bytes.writeUInt32BE(PayloadType.Output, 112);
  bytes.writeUInt32BE(payload.length, 116);
  payload.copy(bytes, 120);
  return bytes;
}

test('decodes the AWS wire layout with binary payloads and 64-bit sequence numbers', () => {
  const payload = Buffer.from([0, 255, 128, 10, 0]);
  const message = decode(frame(payload, 4294967297));
  assert.equal(message.MessageId, '00112233-4455-6677-8899-aabbccddeeff');
  assert.equal(message.SequenceNumber, 4294967297);
  assert.deepEqual(Buffer.from(message.PayloadBytes), payload);
});

test('encodes correct byte lengths and SHA-256 for binary and Unicode text', () => {
  for (const payload of ['é€\0', Uint8Array.from([0, 255, 128, 10])]) {
    const bytes = Buffer.from(encode({ MessageType: MessageType.InputStreamDataMessage,
      SequenceNumber: 4294967297, PayloadType: PayloadType.Output, Payload: payload }));
    const expected = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload);
    assert.equal(bytes.readUInt32BE(0), 116);
    assert.equal(bytes.readUInt32BE(116), expected.length);
    assert.equal(bytes.readBigUInt64BE(48), 4294967297n);
    assert.deepEqual(bytes.subarray(120), expected);
    assert.deepEqual(bytes.subarray(80, 112), crypto.createHash('sha256').update(expected).digest());
    assert.ok(bytes.readBigUInt64BE(40) > 2n ** 32n);
  }
});

test('rejects truncated headers, invalid lengths, corrupted payloads, and imprecise sequences', () => {
  const valid = frame(Buffer.from('secret'));
  const shortHeader = valid.subarray(0, 119);
  const badHeader = Buffer.from(valid); badHeader.writeUInt32BE(999, 0);
  const badLength = Buffer.from(valid); badLength.writeUInt32BE(1, 116);
  const corrupt = Buffer.from(valid); corrupt[120] ^= 1;
  const unsafeSequence = Buffer.from(valid); unsafeSequence.writeBigUInt64BE(2n ** 53n, 48);
  for (const bytes of [shortHeader, badHeader, badLength, corrupt, unsafeSequence]) {
    assert.throws(() => decode(bytes), error => !error.message.includes('secret'));
  }
});

test('accepts empty-payload frames without a digest, as the AWS validator does', () => {
  const bytes = frame(Buffer.alloc(0)); bytes.fill(0, 80, 112);
  assert.equal(decode(bytes).PayloadBytes.length, 0);
});

test('accepts zeroed publication-control metadata without treating it as application data', () => {
  for (const type of ['start_publication', 'pause_publication']) {
    const bytes = Buffer.alloc(120);
    bytes.write(type, 4, 'ascii');
    assert.equal(decode(bytes).MessageType, type);
    assert.equal(decode(bytes).PayloadBytes.length, 0);
  }
});
