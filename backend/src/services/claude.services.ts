import { streamText, Output } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";
import { SYSTEM_PROMPT } from "../constants.ts";

export const generateClaudeResponse = (prompt: string) => {
    const result = streamText({
        model: anthropic("claude-sonnet-4-5"),

        system: SYSTEM_PROMPT,

        prompt,

        output: Output.object({
            schema: z.object({
                followUps: z.array(z.string()),
                answer: z.string(),
            }),
        }),
    });

    return result;
};
