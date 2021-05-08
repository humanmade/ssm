// Ported from https://github.com/aws/amazon-ssm-agent/blob/7ca3c5bc019da3801023c54ef3514d5cdceac9f0/agent/session/contracts/model.go

export enum MessageType {
	// InteractiveShellMessage message type for interactive shell.
	InteractiveShellMessage = "interactive_shell",
	// TaskReplyMessage represents message type for task reply
	TaskReplyMessage = "agent_task_reply",
	// TaskCompleteMessage represents message type for task complete
	TaskCompleteMessage = "agent_task_complete",
	// AcknowledgeMessage represents message type for acknowledge
	AcknowledgeMessage = "acknowledge",
	// AgentSessionState represents status of session
	AgentSessionState = "agent_session_state",
	// ChannelClosedMessage represents message type for ChannelClosed
	ChannelClosedMessage = "channel_closed",
	// OutputStreamDataMessage represents message type for outgoing stream data
	OutputStreamDataMessage = "output_stream_data",
	// InputStreamDataMessage represents message type for incoming stream data
	InputStreamDataMessage = "input_stream_data",
	// PausePublicationMessage message type for pause sending data packages.
	PausePublicationMessage = "pause_publication",
	// StartPublicationMessage message type for start sending data packages.
	StartPublicationMessage = "start_publication",
}

export enum PayloadType {
	Output               = 1,
	Error                = 2,
	Size                 = 3,
	Parameter            = 4,
	HandshakeRequest     = 5,
	HandshakeResponse    = 6,
	HandshakeComplete    = 7,
	EncChallengeRequest  = 8,
	EncChallengeResponse = 9,
	Flag                 = 10,
}
