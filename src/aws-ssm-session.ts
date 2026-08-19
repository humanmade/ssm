import { v4 as uuidv4 } from 'uuid';
import WebSocket from 'isomorphic-ws';

import { AgentMessage, decode, encode, EncodeableAgentMessage } from './agent-message';
import { ActionStatus, MessageType, PayloadType } from './channel-messages';

// Sent to the agent in handshake responses. Keep in sync with package.json.
const CLIENT_VERSION = '0.0.2';

// Maximum number of out-of-order inbound messages held while waiting for the
// gap before them to be filled. Matches the reference client's
// IncomingMessageBufferCapacity.
const INCOMING_MESSAGE_BUFFER_CAPACITY = 10000;

// Maximum number of sent-but-unacknowledged messages kept for
// retransmission. Matches the reference client's
// OutgoingMessageBufferCapacity.
const OUTGOING_MESSAGE_BUFFER_CAPACITY = 10000;

// How often to check whether the oldest unacknowledged message needs
// resending. Matches the reference client's ResendSleepInterval.
const RESEND_CHECK_INTERVAL = 100;

// How long to wait for an acknowledgement before resending. The reference
// client starts at 200ms and tunes this from measured round-trip times; we
// don't measure RTT, so use a conservative fixed value.
const RETRANSMISSION_TIMEOUT = 1000;

interface Handler {
	event: 'output' | 'connect' | 'disconnect' | 'pause' | 'resume',
	callback: Function
}

interface OutgoingMessage {
	sequenceNumber: number,
	data: Uint8Array,
	lastSentTime: number,
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
	// The sequence number we expect from the next inbound stream message.
	// Messages arriving ahead of it are held in incomingMessageBuffer until
	// the gap before them is filled; messages behind it are duplicates and
	// are re-acknowledged but not re-processed.
	expectedSequenceNumber = 0;
	incomingMessageBuffer: Map<number, AgentMessage> = new Map();
	connectionClosed = false;
	connectionTerminated = false;
	// Each message that is sent with a sequenceNumber is replied to with an
	// acknowledgement from the SSM remote agent. We keep track of the latest
	// sequenceNumber that has been acknowledged, so we know which of our sent
	// messages the remote agent has received.
	lastAcknowledgedSequenceNumber: number | undefined;
	// Sent messages we haven't received an acknowledgement for yet, oldest
	// first, kept so they can be retransmitted.
	outgoingMessageBuffer: OutgoingMessage[] = [];
	resendTimer?: ReturnType<typeof setInterval>;
	handlers: Handler[] = [];
	paused: boolean = false;

	constructor( streamUrl: string, sessionId: string, tokenValue: string ) {
		this.streamUrl = streamUrl;
		this.tokenValue = tokenValue;
		this.sessionId = sessionId;
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
					if ( message.SequenceNumber === this.expectedSequenceNumber ) {
						this.acknowledgeMessage( message.MessageType, message.MessageId, message.SequenceNumber );
						this.handleOutputMessage( message );
						this.expectedSequenceNumber++;

						// Process any buffered messages which are now in sequence.
						let next;
						while ( ( next = this.incomingMessageBuffer.get( this.expectedSequenceNumber ) ) !== undefined ) {
							this.incomingMessageBuffer.delete( this.expectedSequenceNumber );
							this.handleOutputMessage( next );
							this.expectedSequenceNumber++;
						}
					} else if ( message.SequenceNumber > this.expectedSequenceNumber ) {
						// Out-of-order message: acknowledge it and hold it until the
						// gap before it is filled.
						if ( this.incomingMessageBuffer.size < INCOMING_MESSAGE_BUFFER_CAPACITY ) {
							this.acknowledgeMessage( message.MessageType, message.MessageId, message.SequenceNumber );
							this.incomingMessageBuffer.set( message.SequenceNumber, message );
						}
					} else {
						// Already processed (e.g. a resend after our acknowledgement
						// was lost): re-acknowledge, but don't re-emit.
						this.acknowledgeMessage( message.MessageType, message.MessageId, message.SequenceNumber );
					}
					break
				}
				case 'start_publication': {
					// Note: the sequence number deliberately continues from where it
					// left off. It must never rewind: an acknowledgement for sequence
					// number N means the remote agent has received N, so re-using an
					// acknowledged number would be discarded as a duplicate. The
					// reference client keeps its counter monotonic even across full
					// websocket reconnects.
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
						const payloadData = JSON.parse( message.Payload );
						const acknowledged = payloadData.AcknowledgedMessageSequenceNumber;
						if ( this.lastAcknowledgedSequenceNumber === undefined || this.lastAcknowledgedSequenceNumber < acknowledged ) {
							this.lastAcknowledgedSequenceNumber = acknowledged;
						}

						// The message has been received; no need to keep it around
						// for retransmission.
						this.outgoingMessageBuffer = this.outgoingMessageBuffer.filter( m => m.sequenceNumber !== acknowledged );
					}
					break;
				}
				case 'input_stream_data': {
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
			if ( this.resendTimer !== undefined ) {
				clearInterval( this.resendTimer );
				this.resendTimer = undefined;
			}

			this.emit( 'disconnect', ev.reason );
		};

		// Retransmit unacknowledged messages, like the reference client's
		// ResendStreamDataMessageScheduler.
		this.resendTimer = setInterval( () => this.resendUnacknowledgedMessage(), RESEND_CHECK_INTERVAL );
	}

	// Resend the oldest unacknowledged message if its acknowledgement is
	// overdue. Duplicates are safe: the receiver re-acknowledges and drops
	// messages below its expected sequence number.
	private resendUnacknowledgedMessage() {
		const head = this.outgoingMessageBuffer[ 0 ];
		if ( ! head || this.webSocket.readyState !== 1 ) {
			return;
		}
		if ( Date.now() - head.lastSentTime < RETRANSMISSION_TIMEOUT ) {
			return;
		}

		head.lastSentTime = Date.now();
		this.webSocket.send( head.data );
	}

	send( message: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | Blob ) {
		if ( this.webSocket.readyState !== 1 ) {
			console.warn( 'WebSocket is not yet ready.' );
			return;
		}

		// Keep sequential messages around until they're acknowledged, so they
		// can be retransmitted if the acknowledgement doesn't arrive.
		if ( message instanceof Uint8Array ) {
			this.outgoingMessageBuffer.push( {
				sequenceNumber: this.outgoingSequenceNumber,
				data: message,
				lastSentTime: Date.now(),
			} );
			if ( this.outgoingMessageBuffer.length > OUTGOING_MESSAGE_BUFFER_CAPACITY ) {
				this.outgoingMessageBuffer.shift();
			}
		}

		this.outgoingSequenceNumber++;
		this.webSocket.send( message )
	}

	on( eventName: 'output' | 'connect' | 'disconnect' | 'pause' | 'resume', callback: Function ) {
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

	emit( eventName: 'output' | 'connect' | 'disconnect' | 'pause' | 'resume', data: string | ArrayBuffer | SharedArrayBuffer | ArrayBufferView | Blob ) {
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

	// Process an output_stream_data message according to its payload type.
	// Only data payloads are terminal output; handshake payloads are part of
	// session setup and must not be shown to the user.
	private handleOutputMessage( message: AgentMessage ) {
		switch ( message.PayloadType ) {
			case PayloadType.Output:
			case PayloadType.Error:
			case PayloadType.StdErr: {
				this.emit( 'output', message.Payload );
				break;
			}
			case PayloadType.HandshakeRequest: {
				this.handleHandshakeRequest( message );
				break;
			}
			case PayloadType.HandshakeComplete: {
				const payloadData = JSON.parse( message.Payload );
				if ( payloadData.CustomerMessage ) {
					this.emit( 'output', payloadData.CustomerMessage + '\r\n' );
				}
				break;
			}
			default: {
				console.error( `Unhandled payload type ${ message.PayloadType }.` );
			}
		}
	}

	// Respond to a handshake request from the agent.
	//
	// We can satisfy the SessionType action; anything else (notably
	// KMSEncryption) is unsupported, which the agent treats as a failed
	// handshake, and it will cancel the session.
	private handleHandshakeRequest( message: AgentMessage ) {
		const request = JSON.parse( message.Payload );
		const errors: string[] = [];
		const actions = ( request.RequestedClientActions || [] ).map( ( action: { ActionType: string } ) => {
			if ( action.ActionType === 'SessionType' ) {
				return {
					ActionType: action.ActionType,
					ActionStatus: ActionStatus.Success,
				};
			}

			const error = `Unsupported action ${ action.ActionType }`;
			errors.push( error );
			return {
				ActionType: action.ActionType,
				ActionStatus: ActionStatus.Unsupported,
				Error: error,
			};
		} );

		const response = {
			ClientVersion: CLIENT_VERSION,
			ProcessedClientActions: actions,
			Errors: errors,
		};
		this.send( encode( {
			MessageType: MessageType.InputStreamDataMessage,
			SequenceNumber: this.outgoingSequenceNumber,
			Payload: JSON.stringify( response ),
			PayloadType: PayloadType.HandshakeResponse,
		} ) );
	}

	private acknowledgeMessage( messageType: MessageType, messageId: string, messageSequenceNumber: number ) {
		const message: EncodeableAgentMessage = {
			MessageType: MessageType.AcknowledgeMessage,
			// Acknowledgements aren't part of the sequential stream; the
			// reference client sends them with sequence number 0 and flags 3.
			SequenceNumber: 0,
			Flags: 3,
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
