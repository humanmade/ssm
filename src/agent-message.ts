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
	Payload: string;
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
 * Decode a UTF-8 byte sequence to a string.
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
	const bytes = buffer.slice( start, end );
	return bytes.reduce( ( acc, byte ) => {
		return ( acc << 8 ) + byte;
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
 * We cheat here; JS doesn't support 64-bit integers (aka longs), so we can
 * just use putInt with a 4 byte offset.
 */
function putLong( buffer: Uint8Array, pos: number, value: number ) {
	putInt( buffer, pos + 4, value );
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
	return {
		MessageType: decodeText( buffer, Offset.MessageType, Offset.MessageType + Length.MessageType ).trimEnd() as MessageType,
		SequenceNumber: decodeInt( buffer, Offset.SequenceNumber, Offset.SequenceNumber + Length.SequenceNumber ),
		MessageId: decodeUuid( buffer, Offset.MessageId, Offset.MessageId + Length.MessageId ),
		PayloadType: decodeInt( buffer, Offset.PayloadType, Offset.PayloadType + Length.PayloadType ),
		Payload: decodeText( buffer, headerLength + Length.PayloadLength ),
	};
}

export type EncodeableAgentMessage = Omit<AgentMessage, 'MessageId'>;

/**
 * Encode a message.
 */
export function encode( message: EncodeableAgentMessage ) {
	const payloadLength = message.Payload.length;
	const totalLength = Offset.PayloadLength + payloadLength + 4;

	// | HL|         MessageType           |Ver|  CD   |  Seq  | Flags |
	// |         MessageId                     |           Digest              |PayType| PayLen|
	// |         Payload      			|
	const data = new Uint8Array( totalLength );

	putInt( data, Offset.HL, Offset.PayloadLength );
	putString( data, Offset.MessageType, Offset.MessageType + Length.MessageType, message.MessageType );
	putInt( data, Offset.SchemaVersion, 1 );
	putLong( data, Offset.CreatedDate, Date.now() );
	putLong( data, Offset.SequenceNumber, message.SequenceNumber );
	putLong( data, Offset.Flags, message.SequenceNumber > 0 ? 0b00 : 0b01 );

	// Generate a UUID.
	uuidv4( {}, data, Offset.MessageId );

	// Generate the digest.
	data.set( sha256.update( message.Payload ).digest(), Offset.PayloadDigest );

	// Set the payload.
	putInt( data, Offset.PayloadType, message.PayloadType );
	putInt( data, Offset.PayloadLength, payloadLength );
	putString( data, Offset.Payload, totalLength, message.Payload );

	return data;
}
