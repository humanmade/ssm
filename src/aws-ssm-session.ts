import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'isomorphic-ws';

import { decode, encode, EncodeableAgentMessage } from './agent-message';
import { MessageType, PayloadType } from './channel-messages';
import { HandshakeResponsePayload } from './handshake';

export { decode } from './agent-message';

interface Handler {
	event: 'output' | 'rawOutput' | 'connect' | 'disconnect' | 'pause' | 'resume' | 'handshake' | 'handshakeComplete',
	callback: Function
}

interface Logger {
	debug( type: string, ...args: any[] ): void,
	info( type: string, ...args: any[] ): void,
	warn( type: string, ...args: any[] ): void,
	error( type: string, ...args: any[] ): void,
}

class NullLogger implements Logger {
	debug(): void {}
	info(): void {}
	warn(): void {}
	error(): void {}
}

export default class AWSSSMSession {
	webSocket: WebSocket;
	sessionId: string;
	tokenValue: string;
	streamUrl: string;
	// Each message that is sent to the SSM websocket is assigned a sequenceNumber
	// so the receiver can verify it has not missed any messages (sequenceNumber is
	// an incrementing integer). Also, messages can be ordered back into sequence if
	// anything were to get ahead of line.
	outgoingSequenceNumber = 0;
	outputMap = new Map();
	didAck: { [ k: string ]: boolean } = {};
	connectionClosed = false;
	connectionTerminated = false;
	// Each message that is sent with a sequenceNumber is replied to with an
	// acknowledgement from the SSM remote agent. We keep track of the latest
	// sequenceNumber that has been acknowledged, so we know what number to reset
	// to if we fall out of sync with the remove server. Currently no buffering or
	// replaying of messages exists, but it could be added in the future.
	lastAcknowledgedSequenceNumber: number | undefined;
	handlers: Handler[] = [];
	paused: boolean = false;
	logger: Logger;

	constructor( streamUrl: string, sessionId: string, tokenValue: string, logger?: Logger ) {
		this.streamUrl = streamUrl;
		this.tokenValue = tokenValue;
		this.sessionId = sessionId;
		this.logger = logger || new NullLogger();
		this.webSocket = new WebSocket(this.streamUrl);
		this.webSocket.binaryType = 'arraybuffer';
		this.webSocket.onopen = (ev: WebSocket.OpenEvent) => {
			this.webSocket.send(
				JSON.stringify({
					MessageSchemaVersion: '1.0',
					RequestId: uuidv4(),
					TokenValue: this.tokenValue,
				})
			);
			this.emit( 'connect', '' );
		};

		this.webSocket.onmessage = (ev: any) => {
			const uint8 = new Uint8Array( ev.data );
			const message = decode( uint8 );

			switch( message.MessageType ) {
				case 'output_stream_data': {
					if ( this.didAck[ message.MessageId ] ) {
						this.logger.debug( 'dupe', message.MessageId );
						return;
					}
					this.logger.debug( 'recv', message );
					this.acknowledgeMessage( message.MessageType, message.MessageId, message.SequenceNumber );

					const decoder = new TextDecoder( 'utf8' );
					const text = decoder.decode( message.Payload );
					if ( ! this.outputMap.has( message.MessageId ) ) {
						switch ( message.PayloadType ) {
							case PayloadType.Output:
								this.logger.debug( 'output', message.Payload );
								this.emit( 'output', text );
								this.emit( 'rawOutput', message.Payload );
								break;

							case PayloadType.HandshakeRequest:
								this.logger.debug( 'handshake', JSON.parse( text ) );
								this.emit( 'handshake', JSON.parse( text ) );
								break;

							case PayloadType.HandshakeComplete:
								this.logger.debug( 'handshakeComplete', JSON.parse( text ) );
								this.emit( 'handshakeComplete', JSON.parse( text ) );
								break;

							default:
								this.logger.warn( `No handler for ${ message.PayloadType }` );
								this.logger.debug( 'badType', text );
								break;
						}
					}

					this.outputMap.set(message.MessageId, text);
					break
				}
				case 'start_publication': {
					if ( this.lastAcknowledgedSequenceNumber !== undefined ) {
						this.outgoingSequenceNumber = this.lastAcknowledgedSequenceNumber;
					} else {
						this.outgoingSequenceNumber = 0;
					}
					this.paused = false;
					this.emit( 'resume', '' );
					break;
				}
				case 'pause_publication': {
					this.paused = true;
					this.emit( 'pause', '' );
					break;
				}
				case 'acknowledge': {
					if ( message.Payload ) {
						const decoder = new TextDecoder( 'utf8' );
						const payloadData = JSON.parse( decoder.decode( message.Payload ) );
						if ( this.lastAcknowledgedSequenceNumber === undefined || this.lastAcknowledgedSequenceNumber < payloadData.AcknowledgedMessageSequenceNumber ) {
							this.lastAcknowledgedSequenceNumber = payloadData.AcknowledgedMessageSequenceNumber;
						}
					}
					break;
				}
				case 'input_stream_data': {
					console.log( 'input?' );
					break;
				}
				case 'channel_closed': {
					if ( message.Payload ) {
						const decoder = new TextDecoder( 'utf8' );
						const payloadData = JSON.parse( decoder.decode( message.Payload ) );
						if ( payloadData.Output.length > 0 ) {
							this.emit( 'output', payloadData.Output + '\r\n' );
						}
					}
					this.connectionTerminated = true;
					break;
				}
				default: {
					console.error( `Unhandled message type ${ message.MessageType }.` );
				}
			}
		};

		this.webSocket.onclose = (ev: any) => {
			this.connectionClosed = true;

			this.emit( 'disconnect', ev.reason );
		};
	}

	send( message: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | Blob ) {
		if ( this.webSocket.readyState !== 1 ) {
			console.warn( 'WebSocket is not yet ready.' );
			return;
		}
		this.outgoingSequenceNumber++;
		this.logger.debug( 'send', message );
		this.webSocket.send( message );
	}

	on( eventName: Handler['event'], callback: Function ) {
		this.handlers.push( {
			event: eventName,
			callback,
		} );
	}

	write( message: string ) {
		const encoder = new TextEncoder();
		const data = {
			MessageType: MessageType.InputStreamDataMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			Payload: encoder.encode( message ),
			PayloadType: PayloadType.Output,
		};
		this.logger.debug( 'write', data );
		this.send( encode( data ) );
	}

	writeRaw( bytes: Uint8Array ) {
		const data = {
			MessageType: MessageType.InputStreamDataMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			Payload: bytes,
			PayloadType: PayloadType.Output,
		};
		this.logger.debug( 'writeRaw', data );
		this.send( encode( data ) );
	}

	sendHandshakeResponse( payload: HandshakeResponsePayload ) {
		const encoder = new TextEncoder();
		const data = {
			MessageType: MessageType.InputStreamDataMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			Payload: encoder.encode( JSON.stringify( payload ) ),
			PayloadType: PayloadType.HandshakeResponse,
		};
		this.logger.debug( 'sendHandshakeResponse', data );
		this.send( encode( data ) );
	}

	ping() {
		this.logger.debug( 'ping' );
		this.webSocket.send( 'ping' );
	}

	emit( eventName: Handler['event'], data: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | Blob ) {
		this.handlers.filter( h => h.event === eventName ).map( h => h.callback( data ) );
	}

	setSize( cols: number, rows: number ) {
		const encoder = new TextEncoder();
		const message: EncodeableAgentMessage = {
			MessageType: MessageType.InputStreamDataMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			Payload: encoder.encode( JSON.stringify( { cols, rows } ) ),
			PayloadType: PayloadType.Size,
		};
		this.send( encode( message ) );
	}

	close() {
		this.webSocket.close();
	}

	private acknowledgeMessage( messageType: MessageType, messageId: string, messageSequenceNumber: number ) {
		if ( this.didAck[ messageId ] ) {
			return;
		}
		this.didAck[ messageId ] = true;

		const encoder = new TextEncoder();
		const message: EncodeableAgentMessage = {
			MessageType: MessageType.AcknowledgeMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			PayloadType: PayloadType.Output,
			Payload: encoder.encode( JSON.stringify( {
				AcknowledgedMessageType: messageType,
				AcknowledgedMessageId: messageId,
				AcknowledgedMessageSequenceNumber: messageSequenceNumber,
				IsSequentialMessage: true
			} ) ),
		};

		// Write to the socket without incrementing our own sequence number.
		this.logger.debug( 'ack', message );
		this.webSocket.send( encode( message ) );
	}
}
