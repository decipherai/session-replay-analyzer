import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { generateSystemPrompt } from "./prompts";
import { type eventWithTime } from "@rrweb/types";
import { ErrorData } from "./types";
import { TextBlock } from "@anthropic-ai/sdk/resources";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_SECRET_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_SECRET_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  maxRetries: 2,
});

const models = {
  haiku: "claude-3-haiku-20240307",
  sonnet: "claude-3-sonnet-20240229",
  gpt4: "gpt-4o",
};

async function callAnthropic(
  model: string,
  system_prompt: string,
  user_prompt: string
) {
  const message = await anthropic.messages.create({
    max_tokens: 800,
    system: system_prompt,
    messages: [
      {
        role: "user",
        content: user_prompt,
      },
      {
        role: "assistant",
        content: "{",
      },
    ],
    model: model,
  });

  if (!message.content || message.content.length === 0) {
    throw new Error("No content received from Anthropic API.");
  }

  return "{" + (message.content[0] as TextBlock).text;
}

async function callOpenAI(
  model: string,
  system_prompt: string,
  user_prompt: string
) {
  const chatCompletion = await openai.chat.completions.create({
    messages: [
      { role: "system", content: system_prompt },
      { role: "user", content: user_prompt },
    ],
    model: model,
  });

  if (!chatCompletion.choices || chatCompletion.choices.length === 0) {
    throw new Error("No content received from OpenAI API.");
  }

  return chatCompletion.choices[0].message.content;
}

export async function analyzeSession(
  errorData: ErrorData,
  events: eventWithTime[],
  model: string = models.sonnet
) {
  const bufferSizes = [10000, 7500, 5000, 2500]; // Different buffer sizes to try
  let filteredEvents, lastClickNode, result;

  for (let buffer of bufferSizes) {
    try {
      [filteredEvents, lastClickNode] = filterEvents(
        events,
        new Date(errorData.timestamp).getTime(),
        buffer
      );
      if (model === "gpt-4o") {
        result = await callOpenAI(
          model,
          generateSystemPrompt(errorData),
          generateUserPrompt(filteredEvents, errorData, lastClickNode)
        );
      } else {
        result = await callAnthropic(
          model,
          generateSystemPrompt(errorData),
          generateUserPrompt(filteredEvents, errorData, lastClickNode)
        );
      }
      return result; // Return the result if successful
    } catch (error: any) {
      if (error.message && error.message.includes("prompt is too long")) {
        continue; // Try the next buffer size
      } else {
        throw error; // If the error is not related to prompt length, throw it
      }
    }
  }

  throw new Error(
    "All buffer sizes attempted, but the prompt is still too long."
  );
}

function generateUserPrompt(
  filteredEvents: eventWithTime[],
  errorData: ErrorData,
  lastClickNode: any
) {
  //Compress events, removing extra lines and tabs from the error data to
  const compressedFilteredEvents = JSON.stringify(filteredEvents, null, 2)
    .replace(/\n/g, "")
    .replace(/\t/g, "")
    .replace(/\s{2,}/g, " ");

  // Include the last click node and the error data if they exist
  if (errorData && lastClickNode) {
    return `Here is the RRWeb Session ${compressedFilteredEvents} \n and the error that happened at ${new Date(
      errorData.timestamp
    ).getTime()} you are focused on ${JSON.stringify(errorData.data)}. \n
        and the last click before the error was on ${JSON.stringify(
          lastClickNode
        )}`;
  } else if (errorData.timestamp && errorData.data) {
    return `Here is the RRWeb Session ${compressedFilteredEvents} \n and the error that happened at ${new Date(
      errorData.timestamp
    ).getTime()} you are focused on ${JSON.stringify(
      errorData.data
    )}. Please note, there was no click in this interaction. \n`;
  } else {
    return `Here is the RRWeb Session ${compressedFilteredEvents}. Please note, there was no click in this interaction.`;
  }
}

// Get events before the definition of the clicked node and everything up to the error itself
function filterEvents(
  events: eventWithTime[],
  timestamp: number,
  buffer: number
): any[] {
  // Iterate over all the events and find the last event which were clicks
  let lastClickID = null;

  console.log("Events", JSON.stringify(events));

  for (let i = events.length - 1; i >= 0; i--) {
    // Event.type = 3 | IncrementalSnapshot
    // Data.source = 2 | MouseInteraction
    // Data.type = 1 | MouseDown
    // Data.type = 2 | Click
    // Data.type = 4 | Double Click

    const eventData = events[i].data as any;
    if (
      events[i].type === 3 &&
      (eventData.type === 2 || eventData.type === 4 || eventData.type === 1) &&
      eventData.source === 2 &&
      events[i].timestamp <= timestamp
    ) {
      lastClickID = eventData.id;
      break;
    }
  }

  let [clickedNode, clickedNodeTimestamp] = getFirstEventWithID(
    events,
    lastClickID
  );

  // Check if the last click timestamp is within 10 seconds of the error timestamp
  if (
    clickedNodeTimestamp &&
    Math.abs(timestamp - clickedNodeTimestamp) > 10000
  ) {
    clickedNode = null;
    clickedNodeTimestamp = null;
  }

  const eventsNearClickedNodeAndNearError = events.filter((event) => {
    return (
      (event.timestamp > clickedNodeTimestamp &&
        Math.abs(event.timestamp - clickedNodeTimestamp) <= buffer) ||
      (event.timestamp < timestamp && timestamp - event.timestamp <= buffer * 2)
    );
  });

  return [eventsNearClickedNodeAndNearError, clickedNode];
}

function getFirstEventWithID(events: eventWithTime[], idToFind: string) {
  function traverseNodes(node: any, parentTimestamp: number): any | number[] {
    // Check if the node itself matches the ID we're looking for
    if (node.id === idToFind) {
      return [node, parentTimestamp];
    }

    // Traverse child nodes if they exist
    if (node.childNodes) {
      for (const child of node.childNodes) {
        const [resultNode, resultTimestamp] = traverseNodes(
          child,
          parentTimestamp
        );
        if (resultNode !== null) {
          return [resultNode, resultTimestamp];
        }
      }
    }

    // Traverse adds if they exist
    if (node.adds) {
      for (const add of node.adds) {
        const [resultNode, resultTimestamp] = traverseNodes(
          add.node,
          parentTimestamp
        );
        if (resultNode !== null) {
          return [resultNode, resultTimestamp];
        }
      }
    }

    // Traverse node attribute if it exists
    if (node.node) {
      const [resultNode, resultTimestamp] = traverseNodes(
        node.node,
        parentTimestamp
      );
      if (resultNode !== null) {
        return [resultNode, resultTimestamp];
      }
    }

    return [null, null];
  }

  for (const event of events) {
    if (event.data) {
      const [node, timestamp] = traverseNodes(event.data, event.timestamp);
      if (node !== null) {
        return [node, timestamp];
      }
    }
  }

  return [null, null];
}
