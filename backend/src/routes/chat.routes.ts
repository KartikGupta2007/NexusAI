import { Router } from "express";
import { tavily } from "@tavily/core";
import { PROMPT_TEMPLATE } from "../constants.ts";
import { generateClaudeResponse } from "../services/claude.services.ts";

const chatRouter = Router();



chatRouter.post("/NexusAI-ask", async (req, res, next) => {

    // 1. get the query from the user
    // 2. make sure the user have access and credits to make the request
    // 3. check if we have the websearch indexed for the related query, 
    // 4. if not, make a websearch and gather the sources
    // 5. do some context engeneering to make the prompt for the LLM and also add the websearch result to the prompt
    // 6. send the prompt to the LLM and stream the response back to the user
    // 7. also to stream back the sources used for the response to the user and also follow-up questions
    
    try {
        const query = req.body.query;

        if (typeof query !== "string" || query.trim().length === 0) {
            return res.status(400).json({
                success: false,
                message: "query is required and must be a non-empty string",
            });
        }

        if (!process.env.TAVILY_API_KEY) {
            return res.status(500).json({
                success: false,
                message: "TAVILY_API_KEY is not configured",
            });
        }

        if (!process.env.ANTHROPIC_API_KEY) {
            return res.status(500).json({
                success: false,
                message: "ANTHROPIC_API_KEY is not configured",
            });
        }

        const client = tavily({ apiKey: process.env.TAVILY_API_KEY });
        const webSearchResponse = await client.search(query.trim(), {
            searchDepth: "advanced",
        });
        const webSearchResult = webSearchResponse.results;

        const prompt = PROMPT_TEMPLATE
            .replace("{{WEB_SEARCH_RESULTS}}", JSON.stringify(webSearchResult))
            .replace("{{USER_QUERY}}", query);

        const result = generateClaudeResponse(prompt);
        const output = await result.output;
        console.log("Claude output:", prompt);
        res.json({
            success: true,
            data: output,
            sources: webSearchResult,
        });
    } catch (error) {
        next(error);
    }
});



export default chatRouter;
