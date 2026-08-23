import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Request, type Response } from "express";
import helmet from "helmet";
import { env } from "./config/env.ts";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware.ts";
import chatRouter from "./routes/chat.routes.ts";
import conversationRouter from "./routes/conversation.routes.ts";
import messageRouter from "./routes/message.routes.ts";
import userRouter from "./routes/user.routes.ts";

const app = express();

// Behind Render/Fly/nginx, req.ip must come from X-Forwarded-For or every rate limiter
// keys on the proxy's address instead of the client's.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(helmet());
app.use(
    cors({
        // Credentialed CORS forbids "*", so the allowlist is explicit. Requests with no
        // Origin (curl, server-to-server, health checks) are allowed through.
        origin(origin, callback) {
            if (!origin || env.corsOrigins.includes(origin)) return callback(null, true);
            callback(new Error(`Origin ${origin} is not allowed by CORS`));
        },
        credentials: true,
    }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(cookieParser());

// Registered on `/` as well as `/health`: platform health checks and uptime monitors probe the
// root by default, and a 404 there reads as "service down". HEAD needs no registration of its
// own — Express answers it from the matching GET handler.
const health = (_req: Request, res: Response) => {
    res.json({ success: true, status: "ok", message: "NexusAI API is running" });
};

app.get("/", health);
app.get("/health", health);

// ROUTES
app.use("/api/v1/user", userRouter);
app.use("/api/v1/chat", chatRouter);
app.use("/api/v1/conversations", conversationRouter);
app.use("/api/v1/messages", messageRouter);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
