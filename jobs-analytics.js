const timeZone = "Asia/Dhaka";
const monthFormat = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
});

function dashboardMonths(now) {
    const parts = monthFormat.formatToParts(now);
    const year = Number(parts.find(({ type }) => type === "year").value);
    const month = Number(parts.find(({ type }) => type === "month").value);
    return Array.from({ length: 6 }, (_, index) => {
        const date = new Date(Date.UTC(year, month - 6 + index, 1));
        return date.toISOString().slice(0, 7);
    });
}

function monthlyCounts(dateField, range, statusField, statuses) {
    return [
        { $match: { [dateField]: range, ...(statuses && { [statusField]: { $in: statuses } }) } },
        {
            $group: {
                _id: {
                    month: { $dateToString: { format: "%Y-%m", date: "$" + dateField, timezone: timeZone } },
                    ...(statuses && { status: "$" + statusField }),
                },
                count: { $sum: 1 },
            },
        },
    ];
}

async function summarize(collection, filter, { statusField, decisionDate, outcomes, range }) {
    const [result] = await collection.aggregate([
        { $match: filter },
        {
            $facet: {
                totals: [
                    { $group: { _id: { $ifNull: ["$" + statusField, "pending"] }, count: { $sum: 1 } } },
                ],
                created: monthlyCounts("createdAt", range),
                decisions: monthlyCounts(decisionDate, range, statusField, outcomes),
            },
        },
    ]).toArray();

    const totals = Object.fromEntries(result.totals.map(({ _id, count }) => [_id, count]));
    return {
        counts: {
            pending: totals.pending ?? 0,
            [outcomes[0]]: totals[outcomes[0]] ?? 0,
            rejected: totals.rejected ?? 0,
        },
        created: new Map(result.created.map(({ _id, count }) => [_id.month, count])),
        decisions: new Map(result.decisions.map(({ _id, count }) => [_id.month + ":" + _id.status, count])),
    };
}

export async function readDashboardAnalytics(db, user, role, tuitionFilter, now = new Date()) {
    const months = dashboardMonths(now);
    const range = {
        $gte: new Date(months[0] + "-01T00:00:00+06:00"),
        $lte: now,
    };
    const applicationFilter = role === "student"
        ? { studentEmail: user.email }
        : role === "tutor"
            ? { $or: [
                { tutorId: { $in: [user._id, String(user._id)] } },
                { tutorId: null, tutorEmail: user.email },
            ] }
            : {};

    const [applications, tuitions] = await Promise.all([
        summarize(db.collection("applications"), { ...applicationFilter, tuitionId: { $type: "objectId" } }, {
            statusField: "status",
            decisionDate: "updatedAt",
            outcomes: ["accepted", "rejected"],
            range,
        }),
        role === "student" ? null : summarize(db.collection("tuitions"), tuitionFilter, {
            statusField: "approvalStatus",
            decisionDate: "reviewedAt",
            outcomes: ["approved", "rejected"],
            range,
        }),
    ]);

    return {
        role,
        applications: applications.counts,
        tuitions: tuitions?.counts ?? null,
        months: months.map((month) => ({
            month,
            applications: applications.created.get(month) ?? 0,
            acceptedApplications: applications.decisions.get(month + ":accepted") ?? 0,
            rejectedApplications: applications.decisions.get(month + ":rejected") ?? 0,
            tuitions: tuitions?.created.get(month) ?? 0,
            approvedTuitions: tuitions?.decisions.get(month + ":approved") ?? 0,
            rejectedTuitions: tuitions?.decisions.get(month + ":rejected") ?? 0,
        })),
    };
}
