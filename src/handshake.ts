import { ActionStatus } from './channel-messages';

export interface HandshakeRequestPayload {
	AgentVersion?: string;
	RequestedClientActions: {
		ActionType: string;
		ActionParameters?: { SessionType?: string; Properties?: Record<string, unknown>; [key: string]: unknown };
	}[];
}

export interface HandshakeResponsePayload {
	ClientVersion: string;
	ProcessedClientActions: {
		ActionType: string;
		ActionStatus: ActionStatus;
		ActionResult?: unknown;
		Error?: string;
	}[];
	Errors: string[] | null;
}
