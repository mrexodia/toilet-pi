export function groupCollapsedHistory(history) {
	const groups = [];
	let turnMessages = [];

	const flushTurn = () => {
		if (turnMessages.length === 0) return;
		if (turnMessages.some(isCollapsedTurnPhaseMessage)) {
			const finalMessage = turnMessages.at(-1);
			const hasFinalAssistantMessage = isFinalAssistantMessage(finalMessage);
			const collapsedMessages = hasFinalAssistantMessage
				? turnMessages.slice(0, -1)
				: turnMessages;

			if (collapsedMessages.length > 0) {
				groups.push({ type: "collapsedTurn", messages: collapsedMessages });
			}
			if (hasFinalAssistantMessage) {
				groups.push({ type: "message", message: finalMessage });
			}
		} else {
			for (const message of turnMessages) {
				groups.push({ type: "message", message });
			}
		}
		turnMessages = [];
	};

	for (const message of Array.isArray(history) ? history : []) {
		if (isAssistantTurnMessage(message)) {
			turnMessages.push(message);
			continue;
		}

		flushTurn();
		groups.push({ type: "message", message });
	}

	flushTurn();
	return groups;
}

function isAssistantTurnMessage(message) {
	return message?.role === "assistant" || message?.role === "toolResult";
}

function isCollapsedTurnPhaseMessage(message) {
	return message?.role === "toolResult"
		|| (message?.role === "assistant" && message?.stopReason === "toolUse");
}

function isFinalAssistantMessage(message) {
	return message?.role === "assistant" && message?.stopReason !== "toolUse";
}
