import { ObjectId } from "mongodb";
import { jwtVerify, SignJWT } from "jose";

const frontend = "mentorlagbe:frontend";
const backend = "mentorlagbe:jobs";
const algorithm = "HS256";
const lifetime = "30s";
const cookieName = "mentorlagbe_jobs";
const jobsJwtReceiptHeader = "x-mentorlagbe-jobs-receipt";

function getJobsJwtKey() {
    const secret = process.env.JWT_SECRET?.trim();
    if (!secret) return null;
    const key = new TextEncoder().encode(secret);
    return key.byteLength >= 32 ? key : null;
}

async function verifyJobsRequest(req, key) {
    const prefix = cookieName + "=";
    const cookies = (req.get("Cookie") ?? "").split(";").map(cookie => cookie.trim());
    const credentials = cookies.filter(cookie => cookie.startsWith(prefix));
    if (credentials.length !== 1) return null;

    try {
        const { payload } = await jwtVerify(credentials[0].slice(prefix.length), key, {
            algorithms: [algorithm],
            issuer: frontend,
            audience: backend,
            typ: "JWT",
            requiredClaims: ["iat", "exp", "jti", "method", "resource"],
            maxTokenAge: lifetime,
            clockTolerance: 5,
        });
        if (typeof payload.jti !== "string" || !payload.jti ||
            payload.method !== req.method || payload.resource !== req.originalUrl) return null;
        if (payload.sub === undefined) {
            return payload.role === undefined && payload.adminVerified === undefined ? payload : null;
        }
        if (typeof payload.sub !== "string" || !payload.sub ||
            typeof payload.role !== "string" || typeof payload.adminVerified !== "boolean") return null;
        return payload;
    } catch {
        return null;
    }
}

function signJobsReceipt(requestId, key) {
    return new SignJWT({})
        .setProtectedHeader({ alg: algorithm, typ: "JWT" })
        .setIssuer(backend)
        .setAudience(frontend)
        .setJti(requestId)
        .setIssuedAt()
        .setExpirationTime(lifetime)
        .sign(key);
}

export function roleOf(user) {
    return user ? String(user.role ?? "student").toLowerCase() : null;
}

export function createJobsAuthMiddleware(users) {
    return async (req, res, next) => {
        res.set("Cache-Control", "private, no-store");
        const fail = (status, message) => res.status(status).json({ success: false, message });
        const key = getJobsJwtKey();
        if (!key) return fail(503, "Jobs service authentication is not configured.");

        const identity = await verifyJobsRequest(req, key);
        if (!identity) return fail(401, "Jobs service authentication failed.");
        res.set(jobsJwtReceiptHeader, await signJobsReceipt(identity.jti, key));

        const userId = identity.sub;
        if (userId) {
            const ids = /^[a-f0-9]{24}$/i.test(userId) ? [new ObjectId(userId), userId] : [userId];
            const user = await users.findOne({ _id: { $in: ids } });
            if (!user) return fail(401, "User account not found.");
            const role = roleOf(user);
            if (role !== identity.role || (role === "admin" && !identity.adminVerified)) {
                return fail(403, "Sign in again to continue.");
            }
            req.currentUser = user;
        }
        next();
    };
}
