// From https://github.com/aws/amazon-ssm-agent/blob/7ca3c5bc019da3801023c54ef3514d5cdceac9f0/agent/session/contracts/agentmessage.go
import { sha256 } from 'js-sha256';
import { v4 as uuidv4 } from 'uuid';

import {
	MessageType,
	PayloadType,
} from './channel-messages';

// AgentMessage represents a message for agent to send/receive.
// (These other fields exist, but we don't bother decoding them.)
export type AgentMessage = {
	// HeaderLength: number;
	MessageType: MessageType;
	// SchemaVersion: number;
	// CreatedDate: number;
	SequenceNumber: number;
	// Flags: number;
	MessageId: string;
	// PayloadDigest: string;
	PayloadType: PayloadType;
	// The payload decoded as UTF-8 text; JSON payloads are parsed from this.
	Payload: string;
	// The raw payload bytes. Use these for binary-safe handling, or for
	// streaming text decoding across message boundaries.
	PayloadBytes: Uint8Array;
}

// HL - HeaderLength is a 4 byte integer that represents the header length.
// MessageType is a 32 byte UTF-8 string containing the message type.
// SchemaVersion is a 4 byte integer containing the message schema version number.
// CreatedDate is an 8 byte integer containing the message create epoch millis in UTC.
// SequenceNumber is an 8 byte integer containing the message sequence number for serialized message streams.
// Flags is an 8 byte unsigned integer containing a packed array of control flags:
//   Bit 0 is SYN - SYN is set (1) when the recipient should consider Seq to be the first message number in the stream
//   Bit 1 is FIN - FIN is set (1) when this message is the final message in the sequence.
// MessageId is a 40 byte UTF-8 string containing a random UUID identifying this message.
// Payload digest is a 32 byte containing the SHA-256 hash of the payload.
// Payload Type is a 4 byte integer containing the payload type.
// Payload length is an 4 byte unsigned integer containing the byte length of data in the Payload field.
// Payload is a variable length byte data.
//
// | HL|         MessageType           |Ver|  CD   |  Seq  | Flags |
// |         MessageId                     |           Digest              |PayType| PayLen|
// |         Payload      			|
enum Length {
	HL             = 4,
	MessageType    = 32,
	SchemaVersion  = 4,
	CreatedDate    = 8,
	SequenceNumber = 8,
	Flags          = 8,
	MessageId      = 16,
	PayloadDigest  = 32,
	PayloadType    = 4,
	PayloadLength  = 4,
}
enum Offset {
	HL             = 0,
	MessageType    = Offset.HL + Length.HL,
	SchemaVersion  = Offset.MessageType + Length.MessageType,
	CreatedDate    = Offset.SchemaVersion + Length.SchemaVersion,
	SequenceNumber = Offset.CreatedDate + Length.CreatedDate,
	Flags          = Offset.SequenceNumber + Length.SequenceNumber,
	MessageId      = Offset.Flags + Length.Flags,
	PayloadDigest  = Offset.MessageId + Length.MessageId,
	PayloadType    = Offset.PayloadDigest + Length.PayloadDigest,
	PayloadLength  = Offset.PayloadType + Length.PayloadType,
	Payload        = Offset.PayloadLength + Length.PayloadLength,
}

/**
 * Decode a padded fixed-width header field to a string.
 *
 * Header fields may be padded with NULs or spaces depending on the sender,
 * so strip NULs here (and trim whitespace at the call site). Not for use on
 * the payload, where every byte is meaningful.
 */
function decodeText( buffer: Uint8Array, start: number, end?: number ) {
	const decoder = new TextDecoder( 'utf8' );
	const decoded = decoder.decode( buffer.slice( start, end ) );

	// Strip errant NULs.
	return decoded.replace( /\0/g, '' );
}

function putString( buffer: Uint8Array, start: number, end: number, value: string ) {
	const len = end - start;
	if ( len < value.length ) {
		throw new Error( 'String is too long to encode' );
	}

	for ( let i = 0; i < len; i++ ) {
		const byte = i >= value.length ? 32 : value.charCodeAt( i );
		buffer.set( [ byte ], start + i );
	}
}

/**
 * Decode a byte sequence to an integer.
 */
function decodeInt( buffer: Uint8Array, start: number, end: number ) {
	// Multiply rather than shift; shifts operate on 32-bit integers, which
	// would wrap when decoding 8-byte fields. Exact for values below 2^53.
	const bytes = buffer.slice( start, end );
	return bytes.reduce( ( acc, byte ) => {
		return ( acc * 0x100 ) + byte;
	}, 0 )
}

/**
 * Encode a (32-bit) integer into a byte sequence.
 */
function putInt( buffer: Uint8Array, pos: number, value: number ) {
	const bytes = [
		( value >> 24 ) & 0xff,
		( value >> 16 ) & 0xff,
		( value >> 8 ) & 0xff,
		value & 0xff,
	];
	// console.log( value, bytes );
	buffer.set( bytes, pos );
}

/**
 * Encode a (64-bit) long into a byte sequence.
 *
 * JS numbers are doubles, so this is exact for values up to 2^53 - 1; that
 * comfortably covers epoch milliseconds and sequence numbers.
 */
function putLong( buffer: Uint8Array, pos: number, value: number ) {
	putInt( buffer, pos, Math.floor( value / 0x100000000 ) );
	putInt( buffer, pos + 4, value >>> 0 );
}

/**
 * Decode a UUID field to a string.
 *
 * putUuid splits this into most-significant and least-significant longs, then
 * packs them, so we need to flip back.
 */
function decodeUuid( buffer: Uint8Array, start: number, end: number ) {
	const bytes = buffer.subarray( start, end );
	const leastSignificant = bytes.subarray( 0, 8 );
	const mostSignificant = bytes.subarray( 8, 16 );

	const raw = longToHex( mostSignificant ) + longToHex( leastSignificant );

	// Reformat for display.
	//  8-4-4-4-12
	return [
		raw.substr( 0, 8 ),
		raw.substr( 8, 4 ),
		raw.substr( 12, 4 ),
		raw.substr( 16, 4 ),
		raw.substr( 20 ),
	].join( '-' );
}

/**
 * Convert a long to hexadecimal string.
 */
function longToHex( buffer: Uint8Array ) {
	return buffer.reduce( ( str, byte ) => str + byte.toString( 16 ).padStart( 2, '0' ), '' );
}

/**
 * Decode a message.
 */
export function decode( buffer: Uint8Array ): AgentMessage {
	const headerLength = decodeInt( buffer, Offset.HL, Offset.HL + Length.HL );
	const payloadBytes = buffer.slice( headerLength + Length.PayloadLength );
	return {
		MessageType: decodeText( buffer, Offset.MessageType, Offset.MessageType + Length.MessageType ).trimEnd() as MessageType,
		SequenceNumber: decodeInt( buffer, Offset.SequenceNumber, Offset.SequenceNumber + Length.SequenceNumber ),
		MessageId: decodeUuid( buffer, Offset.MessageId, Offset.MessageId + Length.MessageId ),
		PayloadType: decodeInt( buffer, Offset.PayloadType, Offset.PayloadType + Length.PayloadType ),
		Payload: new TextDecoder( 'utf8' ).decode( payloadBytes ),
		PayloadBytes: payloadBytes,
	};
}

export type EncodeableAgentMessage = Omit<AgentMessage, 'MessageId' | 'PayloadBytes'> & {
	// Packed control flags (see header notes above). Defaults to 0, which is
	// what the reference client sends for all data messages; it uses 3 for
	// acknowledgements.
	Flags?: number;
};

/**
 * Encode a message.
 */
export function encode( message: EncodeableAgentMessage ) {
	// Encode the payload to UTF-8 first; the length, digest, and bytes on the
	// wire must all be computed from the same byte sequence.
	const payload = new TextEncoder().encode( message.Payload );
	const payloadLength = payload.length;
	const totalLength = Offset.Payload + payloadLength;

	// | HL|         MessageType           |Ver|  CD   |  Seq  | Flags |
	// |         MessageId                     |           Digest              |PayType| PayLen|
	// |         Payload      			|
	const data = new Uint8Array( totalLength );

	putInt( data, Offset.HL, Offset.PayloadLength );
	putString( data, Offset.MessageType, Offset.MessageType + Length.MessageType, message.MessageType );
	putInt( data, Offset.SchemaVersion, 1 );
	putLong( data, Offset.CreatedDate, Date.now() );
	putLong( data, Offset.SequenceNumber, message.SequenceNumber );
	putLong( data, Offset.Flags, message.Flags ?? 0 );

	// Generate a UUID. The wire format stores the least-significant 8 bytes
	// first, then the most-significant 8 (see decodeUuid), so flip the halves.
	const messageId = new Uint8Array( 16 );
	uuidv4( {}, messageId, 0 );
	data.set( messageId.subarray( 8, 16 ), Offset.MessageId );
	data.set( messageId.subarray( 0, 8 ), Offset.MessageId + 8 );

	// Generate the digest.
	data.set( sha256.update( payload ).digest(), Offset.PayloadDigest );

	// Set the payload.
	putInt( data, Offset.PayloadType, message.PayloadType );
	putInt( data, Offset.PayloadLength, payloadLength );
	data.set( payload, Offset.Payload );

	return data;
}
