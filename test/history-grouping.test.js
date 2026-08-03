import assert from "node:assert/strict";
import test from "node:test";
import { groupCollapsedHistory } from "../server/public/history-grouping.js";

test("collapses tool work but leaves the final assistant message visible", () => {
  const user = { role: "user", text: "inspect it" };
  const thinking = {
    role: "assistant",
    thinkingText: "I should inspect the file",
    stopReason: "toolUse",
  };
  const firstTool = { role: "toolResult", toolCallId: "tool-1", text: "first" };
  const followUp = {
    role: "assistant",
    thinkingText: "I should inspect another file",
    stopReason: "toolUse",
  };
  const secondTool = { role: "toolResult", toolCallId: "tool-2", text: "second" };
  const finalResponse = {
    role: "assistant",
    text: "I found the issue.",
    stopReason: "stop",
  };

  const groups = groupCollapsedHistory([
    user,
    thinking,
    firstTool,
    followUp,
    secondTool,
    finalResponse,
  ]);

  assert.deepEqual(groups, [
    { type: "message", message: user },
    {
      type: "collapsedTurn",
      messages: [thinking, firstTool, followUp, secondTool],
    },
    { type: "message", message: finalResponse },
  ]);
});

test("uses user and non-agent messages as turn boundaries", () => {
  const firstUser = { role: "user", text: "first" };
  const toolUse = { role: "assistant", stopReason: "toolUse" };
  const toolResult = { role: "toolResult", toolCallId: "tool-1" };
  const finalWithoutStopReason = { role: "assistant", text: "done" };
  const system = { role: "system", text: "interrupted" };
  const secondUser = { role: "user", text: "second" };
  const plainResponse = { role: "assistant", text: "no tools" };

  assert.deepEqual(
    groupCollapsedHistory([
      firstUser,
      toolUse,
      toolResult,
      finalWithoutStopReason,
      system,
      secondUser,
      plainResponse,
    ]),
    [
      { type: "message", message: firstUser },
      {
        type: "collapsedTurn",
        messages: [toolUse, toolResult],
      },
      { type: "message", message: finalWithoutStopReason },
      { type: "message", message: system },
      { type: "message", message: secondUser },
      { type: "message", message: plainResponse },
    ],
  );
});

test("keeps unfinished tool work collapsed when there is no final assistant message", () => {
  const toolUse = { role: "assistant", stopReason: "toolUse" };
  const toolResult = { role: "toolResult", toolCallId: "tool-1" };

  assert.deepEqual(groupCollapsedHistory([toolUse, toolResult]), [
    { type: "collapsedTurn", messages: [toolUse, toolResult] },
  ]);
});
