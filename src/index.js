"use strict";

const { fork } = require("child_process");
const fs   = require("fs");
const path = require("path");
const auth = require("./auth");
const dashboard = require("./dashboard");

const DEVELOPER_ID = "61585831139336";
const EXTRA_ADMINS = ["61580437366762", "61586419022838"];
const WORKER_PATH  = path.join(__dirname, "bot-worker.js");

process.on("uncaughtException",  err => { try { dashboard.sysLog("error","Uncaught: "+(err.message||err)); } catch(_){} });
process.on("unhandledRejection", r   => { try { dashboard.sysLog("error","Rejection: "+(r?.message||r)); } catch(_){} });

dashboard.state.developerID = DEVELOPER_ID;
auth.init();
dashboard.startDashboard(process.env.PORT || 5000);

// Map userId -> worker array
const userWorkers   = new Map();
const userKillFlags = new Map();
const sharedStates  = new Map(); // userId -> sharedState

function getSharedState(userId) {
    if (!sharedStates.has(userId)) {
        sharedStates.set(userId, {
            loopEnabled:{}, autoRespondEnabled:{}, mutedThreads:{},
            nicknameMap:{}, antiRestrict:false, antiChat:{},
        });
    }
    return sharedStates.get(userId);
}

function broadcastSharedState(userId) {
    const workers = userWorkers.get(userId) || [];
    const data    = getSharedState(userId);
    for (const w of workers) {
        try { if (w && w.connected) w.send({ type:"sharedState", data }); } catch(_){}
    }
}

function killUserWorkers(userId) {
    userKillFlags.set(userId, true);
    const workers = userWorkers.get(userId) || [];
    workers.forEach(w => { try { w.removeAllListeners(); w.kill("SIGKILL"); } catch(_){} });
    userWorkers.set(userId, []);
    const us = dashboard.getUserState(userId);
    us.bots.splice(0, us.bots.length);
    setTimeout(() => userKillFlags.set(userId, false), 200);
}

function startUserBots(userId) {
    const userDir = auth.getUserDataDir(userId);
    try { fs.mkdirSync(userDir, { recursive: true }); } catch(_) {}

    let files;
    try {
        files = fs.readdirSync(userDir)
            .filter(f => /^fbstate.*\.json$/i.test(f))
            .sort();
    } catch(e) {
        dashboard.addLog(userId, "error", "Cannot read data dir: "+e.message);
        return;
    }

    const us = dashboard.getUserState(userId);
    if (!files.length) {
        dashboard.addLog(userId, "warn", "No fbstate*.json found — dashboard ready, awaiting cookie.");
        dashboard.addAlert(userId, "warn", "No cookie found — go to Cookie tab and paste your fbstate.");
        return;
    }
    dashboard.addLog(userId, "info", `Found ${files.length} bot account(s): ${files.join(", ")}`);

    const workers = [];
    userWorkers.set(userId, workers);

    files.forEach((file, i) => {
        const fbstatePath = path.join(userDir, file);
        const label       = `Bot ${i+1}`;
        const botState    = { label, loggedIn:false, reconnecting:false, nextReconnectIn:0, expired:false };
        us.bots.push(botState);

        function spawnWorker() {
            if (userKillFlags.get(userId)) return;
            const child = fork(WORKER_PATH, [fbstatePath, label, DEVELOPER_ID, ...EXTRA_ADMINS, userDir], { silent:false });
            workers[i] = child;

            child.on("message", msg => {
                const ss = getSharedState(userId);
                switch (msg.type) {
                    case "log":
                        dashboard.addLog(userId, msg.level||"info", msg.message||"");
                        break;
                    case "status":
                        if (msg.loggedIn        !== undefined) botState.loggedIn        = msg.loggedIn;
                        if (msg.reconnecting    !== undefined) botState.reconnecting    = msg.reconnecting;
                        if (msg.nextReconnectIn !== undefined) botState.nextReconnectIn = msg.nextReconnectIn;
                        if (msg.expired         !== undefined) botState.expired         = msg.expired;
                        if (msg.botName !== undefined && msg.loggedIn) {
                            botState.label = msg.botName;
                            if (!us.botName) us.botName = msg.botName;
                            us.loginInProgress = false;
                        }
                        break;
                    case "stateUpdate":
                        if (msg.loopEnabled)        { ss.loopEnabled        = msg.loopEnabled;        us.loopEnabled        = ss.loopEnabled; }
                        if (msg.autoRespondEnabled) { ss.autoRespondEnabled = msg.autoRespondEnabled; us.autoRespondEnabled = ss.autoRespondEnabled; }
                        if (msg.mutedThreads)       { ss.mutedThreads       = msg.mutedThreads;       us.mutedThreads       = ss.mutedThreads; }
                        broadcastSharedState(userId);
                        break;
                    case "totalReply":
                        us.totalRepliesSent++;
                        dashboard.trackMessage(userId);
                        break;
                    case "alert":
                        if (msg.alertType && msg.message) dashboard.addAlert(userId, msg.alertType, msg.message);
                        break;
                    case "accountInfo":
                        if (msg.data) dashboard.setAccountInfoForUser(userId, msg.data);
                        break;
                }
            });

            child.on("exit", (code) => {
                if (userKillFlags.get(userId)) return;
                botState.loggedIn = false;
                if (!botState.expired) {
                    dashboard.addLog(userId, "warn", `[${label}] Worker exited (code ${code}), restarting in 10s...`);
                    dashboard.addAlert(userId, "warn", `[${label}] Worker crashed, restarting...`);
                    botState.reconnecting = true;
                    setTimeout(() => {
                        if (!userKillFlags.get(userId)) { botState.reconnecting = false; spawnWorker(); }
                    }, 10000);
                } else {
                    dashboard.addLog(userId, "error", `[${label}] Session expired. Update cookie from dashboard.`);
                    dashboard.addAlert(userId, "error", `[${label}] Cookie expired — update in Cookie tab`);
                }
            });

            child.on("error", err => dashboard.addLog(userId, "error", `[${label}] Worker error: ${err.message}`));
        }

        setTimeout(spawnWorker, i * 4000);
    });
}

function startAllUserBots() {
    const users = auth.getAllUsers();
    users.forEach((u, idx) => setTimeout(() => startUserBots(u.id), idx * 1000));
}

dashboard.setLoopControlHandler((userId, action, threadID) => {
    const workers = userWorkers.get(userId) || [];
    workers.forEach(w => {
        if (w && w.connected) {
            if (action === "start") w.send({ type:"startLoop", threadID });
            else if (action === "stop") w.send({ type:"stopLoop", threadID });
        }
    });
});

dashboard.setStopAllHandler((userId) => {
    const workers = userWorkers.get(userId) || [];
    workers.forEach(w => { if (w && w.connected) try { w.send({ type:"stopAllLoops" }); } catch(_){} });
});

dashboard.setBotProfileGuardHandler((userId, enabled) => {
    const workers = userWorkers.get(userId) || [];
    workers.forEach(w => { if (w && w.connected) try { w.send({ type:"setProfileGuard", enabled }); } catch(_){} });
});

dashboard.setCookieUpdateHandler((userId) => {
    dashboard.addLog(userId, "info", "Cookie updated — restarting bots...");
    dashboard.addAlert(userId, "info", "Cookie updated — restarting bots now...");
    killUserWorkers(userId);
    const us = dashboard.getUserState(userId);
    us.botName = "";
    us.totalRepliesSent = 0;
    us.loginInProgress  = true;
    us.loopEnabled = {};
    us.autoRespondEnabled = {};
    us.mutedThreads = {};
    const ss = getSharedState(userId);
    ss.loopEnabled = {}; ss.autoRespondEnabled = {}; ss.mutedThreads = {};
    setTimeout(() => startUserBots(userId), 2000);
});

startAllUserBots();
