import { Router } from "express";
import {
    changePassword,
    getCurrentUser,
    googleAuth,
    listSessions,
    login,
    logout,
    logoutAll,
    refreshToken,
    register,
    revokeSession,
} from "../controllers/user.controllers.ts";
import { requireAuth } from "../middlewares/auth.middleware.ts";
import {
    authRouteLimiter,
    credentialLimiter,
    registrationLimiter,
} from "../middlewares/rateLimit.middleware.ts";
import { validateBody, validateParams } from "../middlewares/validate.middleware.ts";
import {
    changePasswordSchema,
    googleAuthSchema,
    loginSchema,
    refreshTokenSchema,
    registerSchema,
    sessionIdParamSchema,
} from "../validators/user.validators.ts";

const userRouter = Router();

userRouter.use(authRouteLimiter);

// Public
userRouter.post("/register", registrationLimiter, validateBody(registerSchema), register); 
userRouter.post("/login", credentialLimiter, validateBody(loginSchema), login);
userRouter.post("/googleAuth", credentialLimiter, validateBody(googleAuthSchema), googleAuth);
userRouter.post("/refresh-token", validateBody(refreshTokenSchema), refreshToken);
userRouter.post("/logout", logout);

// Authenticated
userRouter.get("/me", requireAuth, getCurrentUser);
userRouter.get("/sessions", requireAuth, listSessions);
userRouter.delete(
    "/sessions/:sessionId",
    requireAuth,
    validateParams(sessionIdParamSchema),
    revokeSession,
);
userRouter.post("/logout-all", requireAuth, logoutAll);
userRouter.post(
    "/changePassword",
    requireAuth,
    credentialLimiter,
    validateBody(changePasswordSchema),
    changePassword,
);

export default userRouter;
