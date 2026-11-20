import { createHash, timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { ObjectId } from "mongodb";

const JOB_FIELDS = ["title", "description", "subject", "salary", "location", "status"];
const REVIEW_STATUSES = ["accepted", "rejected"];

function fail(res, status, message) {
    return res.status(status).json({ success: false, message });
}

function roleOf(user) {
    return user ? String(user.role ?? "student").toLowerCase() : null;
}

function canManage(job, user) {
    const role = roleOf(user);
    if (role === "admin") return true;
    if (role !== "student") return false;
    if (job.postedBy?.userId) return String(job.postedBy.userId) === String(user._id);
    return Boolean(job.postedBy?.email && job.postedBy.email.toLowerCase() === user.email.toLowerCase());
}

function publicJob(job, user) {
    return {
        _id: String(job._id),
        title: job.title,
        description: job.description,
        subject: job.subject,
        salary: job.salary ?? job.budget ?? null,
        location: job.location,
        status: job.status ?? "open",
        createdAt: job.createdAt,
        postedBy: { name: job.postedBy?.name },
        canManage: canManage(job, user),
    };
}

function readJobFields(body, create = false) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const fields = create ? { status: "open" } : {};
    for (const field of JOB_FIELDS) {
        if (!Object.hasOwn(body, field)) continue;
        const value = body[field];
        if (field === "salary") {
            if (value === "" || value === null) {
                fields.salary = null;
                continue;
            }
            if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(\.\d{1,2})?$/.test(value.trim()))) {
                return null;
            }
            const amount = Number(value);
            if (!Number.isFinite(amount) || amount < 0) return null;
            fields.salary = amount;
            continue;
        }

        if (typeof value !== "string") return null;
        const trimmed = value.trim();
        if (field === "status" && !["open", "closed"].includes(trimmed)) return null;
        if (["title", "description"].includes(field) && !trimmed) return null;
        if (trimmed.length > (field === "description" ? 1500 : 160)) return null;
        fields[field] = trimmed;
    }
    if (create && (!fields.title || !fields.description)) return null;
    return Object.keys(fields).length ? fields : null;
}

function digest(value) {
    return createHash("sha256").update(value).digest();
}

export function createJobsRouter(db) {
    const router = Router();
    const jobs = db.collection("jobs");
    const users = db.collection("user");
    const applications = db.collection("applications");

    router.use(async (req, res, next) => {
        const expected = process.env.JOBS_API_SECRET?.trim();
        const provided = req.get("x-jobs-api-secret");
        if (!expected) return fail(res, 503, "Jobs service authentication is not configured.");
        if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
            return fail(res, 401, "Jobs service authentication failed.");
        }

        const userId = req.get("x-user-id");
        if (userId) {
            const ids = /^[a-f0-9]{24}$/i.test(userId) ? [new ObjectId(userId), userId] : [userId];
            req.currentUser = await users.findOne({ _id: { $in: ids } });
            if (!req.currentUser) return fail(res, 401, "User account not found.");
        }
        next();
    });

    router.param("jobId", async (req, res, next, jobId) => {
        if (!/^[a-z0-9_-]{1,128}$/i.test(jobId)) return fail(res, 404, "Job not found.");
        if (/^[a-f0-9]{24}$/i.test(jobId)) {
            req.job = await jobs.findOne({ _id: new ObjectId(jobId) });
        }
        req.job ??= await jobs.findOne({ _id: jobId });
        if (!req.job) return fail(res, 404, "Job not found.");
        next();
    });

    function requireManager(req, res, next) {
        if (!req.currentUser) return fail(res, 401, "Please sign in to manage this job.");
        if (!canManage(req.job, req.currentUser)) return fail(res, 403, "You cannot manage this job.");
        next();
    }

    function requireMentor(req, res, next) {
        if (!req.currentUser) return fail(res, 401, "Please sign in to apply.");
        if (roleOf(req.currentUser) !== "mentor") return fail(res, 403, "Only mentors can apply.");
        next();
    }

    router.get("/", async (req, res) => {
        const records = await jobs.find({}).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, data: records.map((job) => publicJob(job, req.currentUser)) });
    });

    router.post("/", async (req, res) => {
        if (!req.currentUser) return fail(res, 401, "Please sign in to post a job.");
        const role = roleOf(req.currentUser);
        if (role !== "student" && role !== "admin") {
            return fail(res, 403, "Only students and admins can post jobs.");
        }

        const fields = readJobFields(req.body, true);
        if (!fields) return fail(res, 400, "Enter a title, description, and valid job details.");
        const job = {
            ...fields,
            postedBy: {
                userId: String(req.currentUser._id),
                name: req.currentUser.name,
                email: req.currentUser.email,
                role,
            },
            createdAt: new Date(),
        };
        const { insertedId } = await jobs.insertOne(job);
        res.status(201).json({ success: true, data: publicJob({ ...job, _id: insertedId }, req.currentUser) });
    });

    router.get("/:jobId", async (req, res) => {
        const data = publicJob(req.job, req.currentUser);
        const jobId = data._id;
        const application = roleOf(req.currentUser) === "mentor"
            ? await applications.findOne({ jobId, userId: String(req.currentUser._id) })
            : null;
        const applicants = data.canManage
            ? await applications.find({ jobId }).sort({ createdAt: -1 }).toArray()
            : [];

        res.json({
            success: true,
            data,
            application: application ? { status: application.status } : null,
            applicants: applicants.map(({ _id, name, message, status }) => ({ _id: String(_id), name, message, status })),
        });
    });

    async function updateJob(req, res) {
        const fields = readJobFields(req.path.endsWith("/status") ? { status: req.body?.status } : req.body);
        if (!fields) return fail(res, 400, "Enter valid job details or status.");
        if ("salary" in fields) {
            // Older listings use budget. Clear it when a fee is explicitly changed.
            fields.budget = null;
        }
        const job = await jobs.findOneAndUpdate(
            { _id: req.job._id },
            { $set: { ...fields, updatedAt: new Date() } },
            { returnDocument: "after" },
        );
        if (!job) return fail(res, 404, "Job not found.");
        res.json({ success: true, data: publicJob(job, req.currentUser) });
    }

    router.put("/:jobId", requireManager, updateJob);
    router.patch("/:jobId", requireManager, updateJob);
    router.patch("/:jobId/status", requireManager, updateJob);

    router.delete("/:jobId", requireManager, async (req, res) => {
        const result = await jobs.deleteOne({ _id: req.job._id });
        if (!result.deletedCount) return fail(res, 404, "Job not found.");
        res.json({ success: true });
    });

    router.post("/:jobId/applications", requireMentor, async (req, res) => {
        if (req.job.status === "closed") return fail(res, 409, "This job is closed to applications.");

        const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
        if (!message || message.length > 1000) {
            return fail(res, 400, "Enter an application message between 1 and 1,000 characters.");
        }

        const jobId = String(req.job._id);
        const userId = String(req.currentUser._id);
        const existing = await applications.findOne({ jobId, userId });
        if (existing) return res.json({ success: true, data: { status: existing.status } });

        // The deterministic MongoDB key allows only one application under concurrent submissions.
        const key = createHash("sha256").update(JSON.stringify([jobId, userId])).digest("hex");
        const query = { _id: key };
        let application;
        try {
            application = await applications.findOneAndUpdate(
                query,
                { $setOnInsert: { jobId, userId, name: req.currentUser.name, message, status: "pending", createdAt: new Date() } },
                { upsert: true, returnDocument: "after" },
            );
        } catch (error) {
            if (error.code !== 11000) throw error;
            application = await applications.findOne(query);
            if (!application) throw error;
        }
        res.json({ success: true, data: { status: application.status } });
    });

    router.patch("/:jobId/applications/:applicationId", requireManager, async (req, res) => {
        const { applicationId } = req.params;
        const status = req.body?.status;
        if (!REVIEW_STATUSES.includes(status)) return fail(res, 400, "Choose accepted or rejected.");
        if (!/^(?:[a-f0-9]{24}|[a-f0-9]{64})$/i.test(applicationId)) return fail(res, 404, "Application not found.");

        const id = applicationId.length === 24 ? new ObjectId(applicationId) : applicationId;
        const application = await applications.findOneAndUpdate(
            { _id: id, jobId: String(req.job._id) },
            { $set: { status, updatedAt: new Date() } },
            { returnDocument: "after" },
        );
        if (!application) return fail(res, 404, "Application not found.");
        res.json({ success: true, data: { status: application.status } });
    });

    router.use((error, req, res, next) => {
        if (res.headersSent) return next(error);
        console.error("Jobs request failed:", error.message);
        return fail(res, 500, "Could not complete the jobs request.");
    });

    return router;
}
