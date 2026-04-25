import Anthropic from "@anthropic-ai/sdk";
import { withActual } from "../bot/actual-query.js";
import { toolDefinitions, toolExecutors } from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";

const MAX_TOOL_ROUNDS = 10;
const MAX_HISTORY = 10;
const MODEL = "claude-sonnet-4-5-20250929";

const client = new Anthropic();

const chatHistories = new Map();

function getHistory(chatId) {
  if (!chatHistories.has(chatId)) {
    chatHistories.set(chatId, []);
  }
  return chatHistories.get(chatId);
}

export function clearHistory(chatId) {
  chatHistories.delete(chatId);
}

function addToHistory(chatId, role, content) {
  const history = getHistory(chatId);
  history.push({ role, content });
  while (history.length > MAX_HISTORY * 2) {
    history.shift();
  }
}

function extractText(response) {
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Runs a Claude tool-use loop with the budget agent's tools.
 * Opens one Actual Budget session for the entire round-trip.
 * Skips opening Actual if the first response has no tool calls.
 *
 * @param {Object} args
 * @param {Object} args.userConfig - User's Actual Budget connection config
 * @param {string} args.systemPrompt - System prompt for this run
 * @param {Array} args.messages - Initial messages array (history + current user message). Mutated by the loop.
 * @param {number} [args.maxTokens=1024] - Max output tokens per Claude call
 * @returns {Promise<string>} The final assistant text
 */
export async function runAgentLoop({ userConfig, systemPrompt, messages, maxTokens = 1024 }) {
  let response = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    tools: toolDefinitions,
    messages,
  });

  if (!response.content.some((b) => b.type === "tool_use")) {
    return extractText(response);
  }

  return await withActual(userConfig, async (api) => {
    let rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;

      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) break;

      messages.push({ role: "assistant", content: response.content });

      const toolResults = [];
      for (const block of toolUseBlocks) {
        console.log(`[agent] Tool call: ${block.name}`, JSON.stringify(block.input));
        const executor = toolExecutors.get(block.name);
        let result;
        if (executor) {
          try {
            result = await executor(api, block.input);
          } catch (err) {
            console.error(`[agent] Tool error (${block.name}):`, err.message);
            result = { error: err.message };
          }
        } else {
          result = { error: `Unknown tool: ${block.name}` };
        }

        console.log(`[agent] Tool result (${block.name}):`, JSON.stringify(result).slice(0, 500));

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });

      response = await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPrompt,
        tools: toolDefinitions,
        messages,
      });

      if (!response.content.some((b) => b.type === "tool_use")) {
        break;
      }
    }

    return extractText(response);
  });
}

/**
 * Ask the AI agent a natural language question about the user's budget.
 * Maintains per-user chat history for follow-ups.
 *
 * @param {Object} userConfig - User's Actual Budget connection config
 * @param {string} question - The user's natural language question
 * @returns {Promise<string>} The agent's text response
 */
export async function askAgent(userConfig, question) {
  const chatId = userConfig.chat_id;
  const history = getHistory(chatId);
  const messages = [...history, { role: "user", content: question }];

  const answer = await runAgentLoop({
    userConfig,
    systemPrompt: buildSystemPrompt(),
    messages,
  });

  addToHistory(chatId, "user", question);
  addToHistory(chatId, "assistant", answer);
  return answer;
}
