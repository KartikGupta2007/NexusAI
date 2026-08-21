import { z } from "zod";

const email = z
    .string()
    .trim()
    .min(3)
    .max(254)
    .email("Enter a valid email address")
    .transform((value) => value.toLowerCase());

/**
 * Composition rules over a length floor: 8 characters of mixed classes beats an
 * arbitrary 12-character minimum for real-world password quality, and the 72-byte
 * ceiling is bcrypt's — anything past it is silently truncated by the algorithm.
 */
const password = z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(72, "Password must be at most 72 characters")
    .refine((value) => /[a-z]/.test(value), "Password must contain a lowercase letter")
    .refine((value) => /[A-Z]/.test(value), "Password must contain an uppercase letter")
    .refine((value) => /\d/.test(value), "Password must contain a number");

const name = z.string().trim().min(1).max(120).optional();

export const registerSchema = z.object({
    email,
    password,
    name,
});

export const loginSchema = z.object({
    email,
    password: z.string().min(1, "Password is required").max(72),
});

export const googleAuthSchema = z.object({
    // JWT issued by Neon Auth, from `authClient.token()` on the client.
    token: z.string().min(1, "Neon Auth token is required"),
});

export const refreshTokenSchema = z.object({
    refreshToken: z.string().min(1).optional(),
});

export const changePasswordSchema = z
    .object({
        // Optional so a Google-only account can set its first password while authenticated.
        currentPassword: z.string().min(1).max(72).optional(),
        newPassword: password,
    })
    .refine((value) => value.currentPassword !== value.newPassword, {
        message: "New password must differ from the current password",
        path: ["newPassword"],
    });

/**
 * Session ids are `refresh_tokens.family_id`, a UUID. Rejecting non-UUIDs here means a
 * malformed id becomes a clean 400 instead of a Postgres `invalid input syntax for type
 * uuid` bubbling up as a 500.
 */
export const sessionIdParamSchema = z.object({
    sessionId: z.string().uuid("sessionId must be a valid session id"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type GoogleAuthInput = z.infer<typeof googleAuthSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
