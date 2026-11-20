import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { connectDB, db } from "./db.js";
import { createJobsRouter } from "./jobs.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Styled API Home Page
app.get("/", (req, res) => {
    res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>MentorLagbe API</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #09090b;
            color: #fafafa;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 1.5rem;
          }
          .card {
            max-width: 480px;
            width: 100%;
            background: #18181b;
            border: 1px solid #27272a;
            border-radius: 16px;
            padding: 2rem;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
          }
          .badge {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: rgba(16, 185, 129, 0.12);
            color: #34d399;
            border: 1px solid rgba(16, 185, 129, 0.3);
            padding: 4px 12px;
            border-radius: 999px;
            font-size: 0.75rem;
            font-weight: 600;
            margin-bottom: 1rem;
          }
          .dot {
            width: 8px;
            height: 8px;
            background: #10b981;
            border-radius: 50%;
          }
          h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
          p { color: #a1a1aa; font-size: 0.925rem; line-height: 1.5; margin-bottom: 1.5rem; }
          .meta {
            background: #09090b;
            border: 1px solid #27272a;
            border-radius: 10px;
            padding: 1rem;
            font-family: monospace;
            font-size: 0.85rem;
            color: #d4d4d8;
            display: grid;
            gap: 0.6rem;
          }
          .row { display: flex; justify-content: space-between; }
          .label { color: #71717a; }
          a { color: #38bdf8; text-decoration: none; }
          a:hover { text-decoration: underline; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge"><span class="dot"></span> API ONLINE</div>
          <h1>MentorLagbe Server API</h1>
          <p>Backend service is active and ready to handle client requests.</p>
          <div class="meta">
            <div class="row"><span class="label">Status</span><span>200 OK</span></div>
            <div class="row"><span class="label">Environment</span><span>${process.env.NODE_ENV || "development"}</span></div>
            <div class="row"><span class="label">Health Check</span><a href="/api/health">GET /api/health</a></div>
          </div>
        </div>
      </body>
    </html>
  `);
});

app.use("/jobs", createJobsRouter(db));

// Combined Server Health & MongoDB Connection Check
app.get("/api/health", async (req, res) => {
    try {
        await db.command({ ping: 1 });

        res.status(200).json({
            success: true,
            service: "MentorLagbe API",
            database: {
                name: "mentor-lagbe",
                status: "connected",
            },
            uptime: `${Math.floor(process.uptime())}s`,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        res.status(503).json({
            success: false,
            service: "MentorLagbe API",
            database: {
                name: "mentor-lagbe",
                status: "disconnected",
                error: error.message,
            },
            uptime: `${Math.floor(process.uptime())}s`,
            timestamp: new Date().toISOString(),
        });
    }
});

// Connect to MongoDB first, then start server with banner
connectDB()
    .then(() => {
        app.listen(PORT, () => {
            const c = {
                reset: "\x1b[0m",
                bold: "\x1b[1m",
                cyan: "\x1b[36m",
                green: "\x1b[32m",
                gray: "\x1b[90m",
            };

            console.log(`
${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.bold}MentorLagbe API Server${c.reset}  ${c.green}● ONLINE${c.reset}
${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
  ${c.gray}Home Page :${c.reset}  ${c.bold}http://localhost:${PORT}${c.reset}
  ${c.gray}Health API:${c.reset}  http://localhost:${PORT}/api/health
  ${c.gray}MongoDB Connection :${c.reset}  ${c.bold}Connected${c.reset}
  ${c.gray}Database  :${c.reset}  mentor-lagbe ${c.green}(connected)${c.reset}
  ${c.gray}Mode      :${c.reset}  ${process.env.NODE_ENV || "development"}
${c.cyan}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${c.reset}
      `);
        });
    })
    .catch((err) => {
        console.error("Failed to connect to MongoDB", err);
        process.exit(1);
    });

export default app;