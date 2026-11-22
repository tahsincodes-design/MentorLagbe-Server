import { createJobsAuthMiddleware, roleOf } from "./jobs-auth.js";
import { Router } from "express";
import { ObjectId } from "mongodb";

const JOB_FIELDS = ["title", "description", "subject", "salary", "location"];
const REVIEW_STATUSES = ["accepted", "rejected"];
const FREE_TUITION_LIMIT = 2;

function fail(res, status, message) {
    return res.status(status).json({ success: false, message });
}

const PUBLISHED = { approvalStatus: "approved", isActive: true };

function isTutor(user) {
    const role = roleOf(user);
    return role === "mentor" || role === "tutor";
}

function tutorTuitions(user) {
    return {
        $or: [
            { tutorId: user._id },
            { tutorId: String(user._id) },
            { tutorId: null, tutorEmail: user.email },
        ],
    };
}

function hasPremium(doc) {
    const mode = process.env.STRIPE_MEMBERSHIP_MODE === "test" ? "test" : "live";
    const account = process.env.STRIPE_TEST_SANDBOX_ID?.trim();
    if (mode === "test" && account && !/^acct_[a-zA-Z0-9]+$/.test(account)) {
        throw new Error("Invalid Stripe test sandbox account ID");
    }
    const plan = mode === "test" && account ? doc?.testSandboxes?.[account] : doc?.[mode];
    return plan?.plan === "premium" && plan.accessUntil instanceof Date && plan.accessUntil.getTime() > Date.now();
}

function ownsTuition(tuition, user) {
    if (!isTutor(user)) return false;
    if (tuition.tutorId) return String(tuition.tutorId) === String(user._id);
    return Boolean(tuition.tutorEmail && tuition.tutorEmail.toLowerCase() === user.email.toLowerCase());
}

function isPublished(tuition) {
    return tuition.approvalStatus === PUBLISHED.approvalStatus && tuition.isActive === PUBLISHED.isActive;
}

function objectId(value) {
    return /^[a-f0-9]{24}$/i.test(value) ? new ObjectId(value) : null;
}

function summarizeTuition(tuition) {
    return { title: tuition.title, tutorName: tuition.tutorName ?? tuition.postedBy?.name ?? null };
}

function publicTuition(tuition, user) {
    return {
        _id: String(tuition._id),
        title: tuition.title,
        description: tuition.description,
        subject: tuition.subject,
        salary: tuition.salary ?? tuition.budget ?? null,
        location: tuition.location,
        approvalStatus: tuition.approvalStatus ?? "pending",
        isActive: tuition.isActive === true,
        revision: tuition.revision ?? 0,
        createdAt: tuition.createdAt,
        postedBy: { name: tuition.tutorName ?? tuition.postedBy?.name },
        canManage: ownsTuition(tuition, user),
        canModerate: roleOf(user) === "admin",
    };
}

export function ensureTuitionIndexes(db) {
    return db.collection("applications").createIndex(
        { tuitionId: 1, studentEmail: 1 },
        {
            name: "unique_tuition_student_application",
            unique: true,
            partialFilterExpression: {
                tuitionId: { $type: "objectId" },
                studentEmail: { $type: "string" },
            },
        },
    );
}


function readJobFields(body, create = false) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const fields = {};
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
        if (["title", "description"].includes(field) && !trimmed) return null;
        if (trimmed.length > (field === "description" ? 1500 : 160)) return null;
        fields[field] = trimmed;
    }
    if (create && (!fields.title || !fields.description)) return null;
    return fields;
}

export function createJobsRouter(db) {
    const router = Router();
    const tuitions = db.collection("tuitions");
    const applications = db.collection("applications");
    const memberships = db.collection("memberships");

    router.use(createJobsAuthMiddleware(db.collection("user")));

    router.param("jobId", async (req, res, next, value) => {
        const _id = objectId(value);
        if (!_id) return fail(res, 404, "Tuition not found.");
        req.tuition = await tuitions.findOne({ _id });
        if (!req.tuition) return fail(res, 404, "Tuition not found.");
        next();
    });

    function requireOwner(req, res, next) {
        if (!req.currentUser) return fail(res, 401, "Please sign in to manage this tuition.");
        if (!ownsTuition(req.tuition, req.currentUser)) return fail(res, 403, "Only the tutor who posted this tuition can manage it.");
        next();
    }

    router.get("/", async (req, res) => {
        const user = req.currentUser;
        let query = PUBLISHED;
        if (req.query.view === "manage") {
            if (roleOf(user) === "admin") {
                query = {};
            } else if (isTutor(user)) {
                query = tutorTuitions(user);
            } else {
                return fail(res, user ? 403 : 401, "Sign in as a tutor or admin to view this dashboard.");
            }
        }
        const records = await tuitions.find(query).sort({ createdAt: -1 }).toArray();
        let membership;
        if (req.query.view === "manage" && isTutor(user)) {
            const premium = hasPremium(await memberships.findOne({ _id: String(user._id) }));
            membership = {
                plan: premium ? "premium" : "free",
                tuitionCount: records.length,
                tuitionLimit: premium ? null : FREE_TUITION_LIMIT,
                ...(premium ? { insights: {
                    published: records.filter(isPublished).length,
                    applications: records.reduce((total, tuition) => total + (tuition.applicationCount ?? 0), 0),
                } } : {}),
            };
        }
        res.json({ success: true, data: records.map((tuition) => publicTuition(tuition, user)), membership });
    });

    router.post("/", async (req, res) => {
        const user = req.currentUser;
        if (!user) return fail(res, 401, "Please sign in to post a tuition.");
        if (!isTutor(user)) return fail(res, 403, "Only tutors can post tuitions.");

        const fields = readJobFields(req.body, true);
        if (!fields) return fail(res, 400, "Enter a title, description, and valid tuition details.");
        const tuition = {
            ...fields,
            tutorId: user._id,
            tutorName: user.name,
            tutorEmail: user.email,
            approvalStatus: "pending",
            isActive: true,
            revision: 0,
            createdAt: new Date(),
        };
        const memberId = String(user._id);
        try {
            await memberships.updateOne(
                { _id: memberId },
                { $setOnInsert: { live: { plan: "free" }, test: { plan: "free" } } },
                { upsert: true },
            );
        } catch (error) {
            if (error.code !== 11000) throw error;
        }
        const insertedId = await db.client.withSession((session) => session.withTransaction(async () => {
            // Taking a write lock on the membership serializes simultaneous posts and billing changes.
            const membership = await memberships.findOneAndUpdate(
                { _id: memberId },
                { $inc: { tuitionQuotaRevision: 1 } },
                { session, returnDocument: "after" },
            );
            if (!hasPremium(membership)) {
                const count = await tuitions.countDocuments(tutorTuitions(user), { session, limit: FREE_TUITION_LIMIT });
                if (count >= FREE_TUITION_LIMIT) return null;
            }
            const result = await tuitions.insertOne({ ...tuition }, { session });
            return result.insertedId;
        }));
        if (!insertedId) {
            return fail(res, 409, "The Free plan allows two saved tuitions. Delete a tuition to free a slot or upgrade to Pro.");
        }
        res.status(201).json({ success: true, data: publicTuition({ ...tuition, _id: insertedId }, user) });
    });

    router.get("/applications", async (req, res) => {
        const user = req.currentUser;
        if (!user) return fail(res, 401, "Please sign in to view your applications.");
        if (roleOf(user) !== "student") return fail(res, 403, "Only students can view this page.");

        const records = await applications
            .find({ studentEmail: user.email, tuitionId: { $type: "objectId" } }, {
                projection: { tuitionId: 1, tuitionSnapshot: 1, status: 1, createdAt: 1 },
            })
            .sort({ createdAt: -1, _id: -1 })
            .toArray();
        const tuitionIds = [...new Map(records.map(({ tuitionId }) => [String(tuitionId), tuitionId])).values()];
        const listings = tuitionIds.length
            ? await tuitions.find({ _id: { $in: tuitionIds } }, {
                projection: { title: 1, tutorName: 1, "postedBy.name": 1, approvalStatus: 1, isActive: 1 },
            }).toArray()
            : [];
        const listingsById = new Map(listings.map((tuition) => [String(tuition._id), tuition]));

        res.json({
            success: true,
            data: records.map(({ _id, tuitionId, tuitionSnapshot, status, createdAt }) => {
                const tuition = listingsById.get(String(tuitionId));
                const summary = tuitionSnapshot ?? (tuition?.approvalStatus === "approved" ? summarizeTuition(tuition) : null);
                return {
                    _id: String(_id),
                    tuitionId: String(tuitionId),
                    title: summary?.title ?? null,
                    tutorName: summary?.tutorName ?? null,
                    status,
                    createdAt,
                    available: Boolean(tuition && isPublished(tuition)),
                };
            }),
        });
    });

    router.get("/:jobId", async (req, res) => {
        const user = req.currentUser;
        const tuition = req.tuition;
        const data = publicTuition(tuition, user);
        if (!isPublished(tuition) && !data.canManage && !data.canModerate) {
            return fail(res, 404, "Tuition not found.");
        }

        const tuitionId = tuition._id;
        const application = roleOf(user) === "student"
            ? await applications.findOne({ tuitionId, studentEmail: user.email })
            : null;
        const applicants = data.canManage
            ? await applications.find({ tuitionId }).sort({ createdAt: -1 }).toArray()
            : [];

        res.json({
            success: true,
            data,
            application: application ? { status: application.status } : null,
            applicants: applicants.map(({ _id, name, message, status }) => ({ _id: String(_id), name, message, status })),
        });
    });

    async function updateTuition(req, res) {
        const fields = readJobFields(req.body);
        if (!fields) return fail(res, 400, "Enter valid tuition details.");
        const editsContent = Object.keys(fields).length > 0;
        const { isActive } = req.body;
        if ((!editsContent && typeof isActive !== "boolean") || (isActive !== undefined && typeof isActive !== "boolean")) {
            return fail(res, 400, "Enter valid tuition details or an active status.");
        }
        const update = { ...fields, updatedAt: new Date() };
        if (typeof isActive === "boolean") update.isActive = isActive;
        if (editsContent) update.approvalStatus = "pending";
        if ("salary" in fields) update.budget = null;

        const tuition = await tuitions.findOneAndUpdate(
            { _id: req.tuition._id },
            {
                $set: update,
                ...(editsContent ? { $inc: { revision: 1 } } : {}),
            },
            { returnDocument: "after" },
        );
        if (!tuition) return fail(res, 404, "Tuition not found.");
        res.json({ success: true, data: publicTuition(tuition, req.currentUser) });
    }

    router.put("/:jobId", requireOwner, updateTuition);
    router.patch("/:jobId", requireOwner, updateTuition);

    router.patch("/:jobId/approval", async (req, res) => {
        if (!req.currentUser) return fail(res, 401, "Please sign in to review this tuition.");
        if (roleOf(req.currentUser) !== "admin") return fail(res, 403, "Only admins can review tuitions.");
        const { approvalStatus, revision } = req.body ?? {};
        if (!["approved", "rejected"].includes(approvalStatus) || !Number.isSafeInteger(revision) || revision < 0) {
            return fail(res, 400, "Choose a decision for the current tuition revision.");
        }

        const revisionFilter = revision === 0
            ? { $or: [{ revision: 0 }, { revision: { $exists: false } }] }
            : { revision };
        const tuition = await tuitions.findOneAndUpdate(
            { _id: req.tuition._id, ...revisionFilter },
            { $set: { approvalStatus, reviewedAt: new Date() } },
            { returnDocument: "after" },
        );
        if (!tuition) return fail(res, 409, "This tuition changed. Refresh and review the latest version.");
        res.json({ success: true, data: publicTuition(tuition, req.currentUser) });
    });

    router.delete("/:jobId", requireOwner, async (req, res) => {
        const deleted = await db.client.withSession((session) => session.withTransaction(async () => {
            const tuition = await tuitions.findOneAndDelete({ _id: req.tuition._id }, { session });
            if (!tuition) return false;
            if (tuition.approvalStatus === "approved") {
                await applications.updateMany(
                    { tuitionId: tuition._id, tuitionSnapshot: { $exists: false } },
                    { $set: { tuitionSnapshot: summarizeTuition(tuition) } },
                    { session },
                );
            }
            return true;
        }));
        if (!deleted) return fail(res, 404, "Tuition not found.");
        res.json({ success: true });
    });

    router.post("/:jobId/applications", async (req, res) => {
        const user = req.currentUser;
        if (!user) return fail(res, 401, "Please sign in to apply.");
        if (roleOf(user) !== "student") return fail(res, 403, "Only students can apply.");
        if (!isPublished(req.tuition)) return fail(res, 409, "This tuition is not open for applications.");

        const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
        if (!message || message.length > 1000) {
            return fail(res, 400, "Enter an application message between 1 and 1,000 characters.");
        }

        const tutorEmail = req.tuition.tutorEmail;
        if (typeof tutorEmail !== "string" || !tutorEmail.trim()) {
            return fail(res, 409, "This tuition is missing its tutor account details.");
        }
        const tuitionId = req.tuition._id;
        const studentEmail = user.email;
        const result = await db.client.withSession((session) => session.withTransaction(async () => {
            const existing = await applications.findOne({ tuitionId, studentEmail }, { session });
            if (existing) return { status: existing.status, created: false };

            const tuition = await tuitions.findOneAndUpdate(
                { _id: tuitionId, ...PUBLISHED },
                { $inc: { applicationCount: 1 } },
                { session, returnDocument: "after" },
            );
            if (!tuition) return null;

            const application = {
                tuitionId,
                tutorEmail,
                tuitionSnapshot: summarizeTuition(tuition),
                studentEmail,
                name: user.name,
                message,
                status: "pending",
                createdAt: new Date(),
            };
            await applications.insertOne(application, { session });
            return { status: application.status, created: true };
        }));

        if (!result) return fail(res, 409, "This tuition is not open for applications.");
        res.status(result.created ? 201 : 200).json({ success: true, data: { status: result.status } });
    });

    router.patch("/:jobId/applications/:applicationId", requireOwner, async (req, res) => {
        const _id = objectId(req.params.applicationId);
        if (!_id) return fail(res, 404, "Application not found.");
        const status = req.body?.status;
        if (!REVIEW_STATUSES.includes(status)) return fail(res, 400, "Choose accepted or rejected.");

        const application = await applications.findOneAndUpdate(
            { _id, tuitionId: req.tuition._id },
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
