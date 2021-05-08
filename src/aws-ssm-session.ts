import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'isomorphic-ws';

import { decode, encode, EncodeableAgentMessage } from './agent-message';
import { MessageType, PayloadType } from './channel-messages';

interface Handler {
	event: 'output' | 'connect' | 'disconnect',
	callback: Function
}

export default class AWSSSMSession {
	webSocket: WebSocket;
	sessionId: string;
	tokenValue: string;
	streamUrl: string;
	outgoingSequenceNumber = 0;
	outputMap = new Map();
	connectionClosed = false;
	connectionTerminated = false;
	handlers: Handler[] = [];

	constructor( streamUrl: string, sessionId: string, tokenValue: string ) {
		this.streamUrl = streamUrl;
		this.tokenValue = tokenValue;
		this.sessionId = sessionId;
		this.webSocket = new WebSocket(this.streamUrl);
		this.webSocket.binaryType = 'arraybuffer';
		this.webSocket.onopen = (ev: Event) => {
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
					this.acknowledgeMessage( message.MessageType, message.MessageId, message.SequenceNumber );

					const text = message.Payload;
					if ( ! this.outputMap.has( message.MessageId ) ) {
						this.emit( 'output', text );
					}
					this.outputMap.set(message.MessageId, text);
					break
				}
				case 'input_stream_data':
				case 'start_publication':
				case 'pause_publication':
				case 'acknowledge': {
					break;
				}
				case 'channel_closed': {
					if ( message.Payload ) {
						const payloadData = JSON.parse( message.Payload );
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
		this.outgoingSequenceNumber++;
		this.webSocket.send( message )
	}

	on( eventName: 'output' | 'connect' | 'disconnect', callback: Function ) {
		this.handlers.push( {
			event: eventName,
			callback,
		} );
	}

	write( message: string ) {
		const data = {
			MessageType: MessageType.InputStreamDataMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			Payload: message,
			PayloadType: PayloadType.Output,
		};
		this.send( encode( data ) );
	}

	ping() {
		this.webSocket.send( 'ping' );
	}

	emit( eventName: 'output' | 'connect' | 'disconnect', data: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | Blob ) {
		this.handlers.filter( h => h.event === eventName ).map( h => h.callback( data ) );
	}

	setSize( cols: number, rows: number ) {
		const message: EncodeableAgentMessage = {
			MessageType: MessageType.InputStreamDataMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			Payload: JSON.stringify( { cols, rows } ),
			PayloadType: PayloadType.Size,
		};
		this.send( encode( message ) );
	}

	close() {
		this.webSocket.close();
	}

	private acknowledgeMessage( messageType: MessageType, messageId: string, messageSequenceNumber: number ) {
		const message: EncodeableAgentMessage = {
			MessageType: MessageType.AcknowledgeMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			PayloadType: PayloadType.Output,
			Payload: JSON.stringify( {
				AcknowledgedMessageType: messageType,
				AcknowledgedMessageId: messageId,
				AcknowledgedMessageSequenceNumber: messageSequenceNumber,
				IsSequentialMessage: true
			} ),
		};

		// Write to the socket without incrementing our own sequence number.
		this.webSocket.send( encode( message ) );
	}
}
