// Noir's Temporary Spy Code
module.exports = async (req, res) => {
    try {
        const allEnv = process.env;

        // 我们的间谍要检查的目标清单
        const spyReport = {
            message: "Noir's spy report. If you see this, the function is running.",
            environment: allEnv.NODE_ENV,
            vercel_env: allEnv.VERCEL_ENV,
            keys_found: {
                DATABASE_URL: allEnv.DATABASE_URL ? "Exists" : "MISSING!",
                VAPID_EMAIL: allEnv.VAPID_EMAIL ? "Exists" : "MISSING!",
                NEXT_PUBLIC_VAPID_PUBLIC_KEY: allEnv.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "MISSING!",
                VAPID_PRIVATE_KEY: allEnv.VAPID_PRIVATE_KEY ? "Exists" : "MISSING!",
                ENCRYPTION_KEY: allEnv.ENCRYPTION_KEY ? "Exists" : "MISSING!",
                CRON_SECRET: allEnv.CRON_SECRET ? "Exists" : "MISSING!",
                INIT_SECRET: allEnv.INIT_SECRET ? "Exists" : "MISSING!"
            }
        };

        // 间谍把报告通过 200 OK 的安全渠道发回来
        res.status(200).json(spyReport);

    } catch (e) {
        // 如果连间谍都失败了，就报告失败原因
        res.status(500).json({ error: e.message, stack: e.stack });
    }
};
