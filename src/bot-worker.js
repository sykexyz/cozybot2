"use strict";

const { login } = require("fca-riyad");
const fs   = require("fs");
const path = require("path");
const axios = require("axios");
const { exec } = require("child_process");
const { replies } = require("./replies");
const { handleTempMail }      = require("./tempmail");
const { toggleProfileGuard }  = require("./profileguard");
const { attachCommentApi }    = require("./comment-api");

const FBSTATE_PATH   = process.argv[2];
const BOT_LABEL      = process.argv[3] || "Bot";
const DEVELOPER_ID   = process.argv[4] || "";
const ADMIN_IDS      = new Set(process.argv.slice(4, -1).filter(a => /^\d+$/.test(a)));
const USER_DATA_DIR  = process.argv[process.argv.length - 1];

const PREFIX          = "!"; // legacy prefix (kept for compatibility)
const MIN_RECONNECT   = 5000;
const MAX_RECONNECT   = 60000;

// Natural-language commands (no prefix)
const CMD_JWU          = "jwu";                    // toggle loop on/off
const CMD_JGH          = "jgh";                    // set+lock group banner
const CMD_MCOMMENT     = "haha abno";              // mass comment: "haha abno <posturl> <message>"
const CMD_NICKLOCK_RE  = /^bat\s+ganyan\s+name\s+niyo\s+(.+)$/i; // nickname lock for all

function mcommentDelay() { return (Math.floor(Math.random() * 5) + 1) * 1000; } // random 1-5 sec

function extractPostId(input) {
    if (!input) return null;
    const s = String(input).trim();
    // direct numeric ID
    if (/^\d{5,}$/.test(s)) return s;
    try {
        // /posts/ID, /videos/ID, story_fbid=ID, pfbid, /permalink/ID
        const m = s.match(/(?:posts|videos|permalink|story\.php\?story_fbid=)\/?(\d+)/i)
               || s.match(/[?&](?:story_fbid|fbid|id)=(\d+)/i)
               || s.match(/\/(\d{10,})(?:[/?]|$)/);
        if (m) return m[1];
    } catch (_) {}
    // share links (e.g. facebook.com/share/1Hjkt2gsCA/) can't be resolved without fetching;
    // return the full URL and let postComment attempt it (or the API may accept it via mbasic).
    return s;
}

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
];
function getRandomUA() { return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]; }
const DEFAULT_BANNER_URL = "https://file.garden/aahuG_hIDGRlXD24/image.jpg";

function dataFile(name) { return path.join(USER_DATA_DIR, name); }
function hasBannerUpload() { try { return fs.existsSync(dataFile("banner_upload.jpg")); } catch(_) { return false; } }

const STATE_FILE           = dataFile("bot_state.json");
const CUSTOM_REPLIES_FILE  = dataFile("custom_replies.json");
const BOT_CONFIG_FILE      = dataFile("bot_config.json");
const FBSTATE_FILE         = FBSTATE_PATH;
const CUSTOM_COMMANDS_FILE = dataFile("custom_commands.json");
const WHITELIST_FILE       = dataFile("whitelist.json");
const THREAD_CONFIG_FILE   = dataFile("thread_config.json");

const COLOR_MAP = {
    blue:"196241301102133",pink:"169463077092846",hotpink:"169463077092846",
    aqua:"2442142322678320",purple:"234137870477637",coral:"980963458735625",
    orange:"175615189761153",green:"2136751179887052",lavender:"2058653964378557",
    red:"2129984390566328",yellow:"174636906462322",teal:"1928399724138152",
    berry:"164535220883264",ocean:"736591620215564",love:"741311439775765",
    rose:"1257453361255152",monochrome:"788274591712841",candy:"205488546921017",
    unicorn:"273728810607574",tropical:"262191918210707",default:"3259963564026002",
};

function send(type, payload = {}) { try { process.send({ type, ...payload }); } catch (_) {} }
function log(level, msg)          { send("log", { level, message: `[${BOT_LABEL}] ${msg}` }); }

function loadState() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
        return {
            loopEnabled:        s.loopEnabled        || {},
            autoRespondEnabled: s.autoRespondEnabled  || {},
            mutedThreads:       s.mutedThreads        || {},
            nicknameMap:        s.nicknameMap         || {},
            antiRestrict:       s.antiRestrict        || false,
            antiChat:           s.antiChat            || {},
            lockedBanners:      s.lockedBanners       || {},
            lockedGroupNames:   s.lockedGroupNames    || {},
            profileGuardEnabled: s.profileGuardEnabled || false,
        };
    } catch (_) {
        return { loopEnabled:{}, autoRespondEnabled:{}, mutedThreads:{}, nicknameMap:{}, antiRestrict:false, antiChat:{}, lockedBanners:{}, lockedGroupNames:{}, profileGuardEnabled:false };
    }
}
function saveState() {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            loopEnabled:        sharedState.loopEnabled,
            autoRespondEnabled: sharedState.autoRespondEnabled,
            mutedThreads:       sharedState.mutedThreads,
            nicknameMap:        sharedState.nicknameMap,
            antiRestrict:       sharedState.antiRestrict,
            antiChat:           sharedState.antiChat,
            lockedBanners:      sharedState.lockedBanners,
            lockedGroupNames:   sharedState.lockedGroupNames,
            profileGuardEnabled: sharedState.profileGuardEnabled,
        }, null, 2));
    } catch (_) {}
}
const sharedState = loadState();

let reconnectDelay   = MIN_RECONNECT;
const tempPerms      = {};
const loopActive     = {};
const loopTimers     = {};
const loopIndex      = {};
const loopCounts     = {};
const loopAutoStop   = {};
const pmThreads      = {};
const spamTracker    = {};
const settingBanner      = {};
const settingGroupName   = {};
const settingNicknameLock = {};
const chatGptEnabled     = {};
const lastBotMsgID       = {};

// Mass Comment (triggered by "haha abno <posturl> <message>") — 1-5 sec random delay
const massCommentActive  = { running: false, stop: false, done: 0, lastError: "" };
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function runMassCommentOnce(api, threadID, postUrl, text) {
    if (massCommentActive.running) {
        return;
    }
    const postID = extractPostId(postUrl);
    if (!postID) return;
    if (!text || !String(text).trim()) return;

    massCommentActive.running = true;
    massCommentActive.stop = false;
    massCommentActive.done = 0;
    massCommentActive.lastError = "";

    const wait = mcommentDelay();
    log("info", `MassComment: waiting ${Math.round(wait/1000)}s before commenting on ${postID}`);
    await sleep(wait);
    if (massCommentActive.stop) { massCommentActive.running = false; return; }

    try {
        if (typeof api.postComment === "function") {
            await api.postComment(postID, String(text).trim());
        } else {
            throw new Error("postComment API not available");
        }
        massCommentActive.done = 1;
        log("info", `MassComment: commented on ${postID}`);

    } catch (e) {
        massCommentActive.lastError = e.message || String(e);
        log("error", `MassComment failed on ${postID}: ${massCommentActive.lastError}`);

    }
    massCommentActive.running = false;
}

function stopAllLoops(api) {
    const active = Object.keys(loopActive).filter(t => loopActive[t]);
    if (!active.length) return;
    log("warn", `Stopping ${active.length} active loop(s) due to disconnect.`);
    active.forEach(tid => stopLoop(tid, api));
    send("stateUpdate", { loopEnabled: sharedState.loopEnabled });
}

function getBotConfig() {
    try { return JSON.parse(fs.readFileSync(BOT_CONFIG_FILE, "utf8")); }
        catch (_) {
            return {
                loopReact:"😆",loopDelay:1,imageProbability:20,loopMode:"sequential",
                loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,
                ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,greetMsg:"Welcome! 👋",
                antiSpamEnabled:false,antiSpamMaxMsg:5,antiSpamWindowSec:10,
                autoSeenEnabled:false,typingSimulate:false,silentMode:false,loopSilentMode:false,
                autoReactEnabled:false,autoReactEmoji:"😆",useBuiltinReplies:true,
                // Mass Comment Sender (fca-riyad: postComment/reactToComment, anti-detection)
                massCommentEnabled:false,
                massCommentPostIDs:"",
                massCommentTexts:"Nice post!\nGreat content!\nAwesome! 🔥",
                massCommentDelayMin:15,
                massCommentDelayMax:45,
                massCommentReact:false,
                massCommentReaction:"like",
            };
        }
}
function getCustomReplies() { try{return JSON.parse(fs.readFileSync(CUSTOM_REPLIES_FILE,"utf8"));}catch(_){return [];} }

function getAllReplies() {
    const cfg = getBotConfig();
    const useBuiltin = cfg.useBuiltinReplies !== false;
    const base = useBuiltin ? [...replies] : [];
    const all = [...base, ...getCustomReplies()].filter(r => r && r.trim());
    return all.length ? all : ["Hey!"];
}

function getRandomReply() { const a = getAllReplies(); return a.length ? a[Math.floor(Math.random()*a.length)] : "..."; }

function getImageReplies() {
    const uploadsDir = path.join(USER_DATA_DIR, "uploads");
    try {
        return fs.readdirSync(uploadsDir)
            .filter(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f))
            .map(f => path.join(uploadsDir, f));
    } catch (_) { return []; }
}

function getCustomCommands() { try{return JSON.parse(fs.readFileSync(CUSTOM_COMMANDS_FILE,"utf8"));}catch(_){return[];} }
function getWhitelist()      { try{return JSON.parse(fs.readFileSync(WHITELIST_FILE,"utf8"));}catch(_){return{enabled:false,uids:[]};} }
function getThreadConfig(tid){ try{const all=JSON.parse(fs.readFileSync(THREAD_CONFIG_FILE,"utf8"));return all[tid]||{};}catch(_){return{};} }

function hasTempPerm(uid)   { if(!tempPerms[uid])return false; if(Date.now()>tempPerms[uid]){delete tempPerms[uid];return false;} return true; }
function parseTime(str) {
    const m=str.match(/^(\d+)(s|sec|min|m|h|hr)$/i);
    if(!m)return null;
    const v=parseInt(m[1]),u=m[2].toLowerCase();
    if(u==="s"||u==="sec")return v*1000;
    if(u==="m"||u==="min")return v*60000;
    if(u==="h"||u==="hr")return v*3600000;
    return null;
}
function formatTimeLeft(ms) { const s=Math.ceil(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60); if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`; }

function setGroupBannerUrl(api, imageUrl, threadID, cb) {
    axios.get(imageUrl, { responseType:"arraybuffer", timeout:20000 }).then(r => {
        const buf = Buffer.from(r.data);
        const { Readable } = require("stream");
        const stream = new Readable(); stream.push(buf); stream.push(null);
        api.changeGroupImage(stream, threadID, err => { if(cb) cb(err); });
    }).catch(err => { if(cb) cb(err); });
}

function setGroupBanner(api, imageSource, threadID, cb) {
    if (imageSource && imageSource.startsWith("local:")) {
        const filename = imageSource.slice(6);
        const filePath = dataFile(filename);
        try {
            if (!fs.existsSync(filePath)) return cb && cb(new Error("Banner file not found"));
            api.changeGroupImage(fs.createReadStream(filePath), threadID, err => { if(cb) cb(err); });
        } catch(e) { if(cb) cb(e); }
        return;
    }
    setGroupBannerUrl(api, imageSource, threadID, cb);
}

function checkAntiSpam(senderID,threadID,cfg) {
    if(!cfg.antiSpamEnabled)return false;
    const key=`${senderID}_${threadID}`,now=Date.now(),win=(cfg.antiSpamWindowSec||10)*1000;
    if(!spamTracker[key])spamTracker[key]=[];
    spamTracker[key]=spamTracker[key].filter(t=>now-t<win);
    spamTracker[key].push(now);
    return spamTracker[key].length>(cfg.antiSpamMaxMsg||5);
}
function isUID(str) { return /^\d{10,20}$/.test((str||"").trim()); }

function safeReact(api, emoji, messageID, isGroup) {
    if (!messageID) return;
    setTimeout(() => {
        try {
            api.setMessageReaction(emoji, messageID, err => {
                if (err) log("warn", `React failed: ${err.message||err}`);
            }, true);
        } catch (_) {}
    }, 300);
}

function startLoop(api, threadID, isPM = false) {
    if (loopActive[threadID]) { log("warn",`Loop already active in ${threadID}`); return; }
    if (isPM) pmThreads[threadID] = true;
    loopActive[threadID] = true;
    loopCounts[threadID] = 0;
    if (!loopIndex[threadID]) loopIndex[threadID] = 0;
    sharedState.loopEnabled[threadID] = true;
    send("stateUpdate", { loopEnabled: sharedState.loopEnabled });
    log("info", `Loop STARTED in thread ${threadID} (pm=${isPM})`);

    const cfg0 = getBotConfig();
    const isGroupThread = !pmThreads[threadID];
    const _send = (msg, cb) => api.sendMessage(msg, threadID, cb, null, isGroupThread);


    if (cfg0.autoStopMinutes > 0) {
        if (loopAutoStop[threadID]) clearTimeout(loopAutoStop[threadID]);
        loopAutoStop[threadID] = setTimeout(()=>{ log("info",`Loop auto-stopped in ${threadID}`); stopLoop(threadID,api); }, cfg0.autoStopMinutes*60000);
    }

    function sendNext() {
        if (!loopActive[threadID]) return;
        const cfg = getBotConfig();
        const tcfg = getThreadConfig(threadID);
        const all = getAllReplies();
        const effectiveDelay = tcfg.loopDelay != null ? tcfg.loopDelay : (cfg.loopDelay||1);
        const effectiveReact = tcfg.loopReact || cfg.loopReact || "😆";
        const safeDelay = Math.max(0.5, effectiveDelay);

        if (!all.length) { loopTimers[threadID]=setTimeout(sendNext,safeDelay*1000); return; }
        if (cfg.maxLoopCount>0 && loopCounts[threadID]>=cfg.maxLoopCount) { stopLoop(threadID,api); return; }

        let idx;
        if ((cfg.loopMode||"sequential")==="shuffle") { idx = Math.floor(Math.random()*all.length); }
        else { idx = loopIndex[threadID] % all.length; loopIndex[threadID] = idx + 1; }
        loopCounts[threadID]++;

        const imageFiles = getImageReplies();
        const useImage = !cfg.reactOnlyMode && imageFiles.length > 0 && Math.random() < ((cfg.imageProbability||20)/100);
        const isGrp = !pmThreads[threadID];
        const __send = (msg, cb) => api.sendMessage(msg, threadID, cb, null, isGrp);

        const loopSilent = !!cfg.loopSilentMode;
        const loopMsg = loopSilent ? {body: all[idx], silent: true} : all[idx];

        function onSent(err, msgInfo) {
            if (err) { log("warn",`Loop send error in ${threadID}: ${err.message||err}`); }
            else if (msgInfo && msgInfo.messageID) {
                safeReact(api, effectiveReact, msgInfo.messageID, isGrp);
            }
            send("totalReply");
            if (loopActive[threadID]) loopTimers[threadID] = setTimeout(sendNext, safeDelay*1000);
        }

        if (useImage) {
            const filePath = imageFiles[Math.floor(Math.random()*imageFiles.length)];
            try {
                const stream = fs.createReadStream(filePath);
                __send(loopSilent ? {attachment:stream, silent:true} : {attachment:stream}, onSent);
            } catch (_) {
                __send(loopMsg, onSent);
            }
        } else {
            __send(loopMsg, onSent);
        }
    }
    sendNext();
}

function stopLoop(threadID, api) {
    loopActive[threadID] = false;
    if (loopTimers[threadID])   { clearTimeout(loopTimers[threadID]);   delete loopTimers[threadID]; }
    if (loopAutoStop[threadID]) { clearTimeout(loopAutoStop[threadID]); delete loopAutoStop[threadID]; }
    loopIndex[threadID]  = 0;
    loopCounts[threadID] = 0;
    sharedState.loopEnabled[threadID] = false;
    send("stateUpdate", { loopEnabled: sharedState.loopEnabled });
    log("info", `Loop STOPPED in thread ${threadID}`);
    const cfg = getBotConfig();
    const isGrpStop = !pmThreads[threadID];
    // no feedback
    delete pmThreads[threadID];
}

function sendAutoReply(api, threadID) {
    const cfg = getBotConfig();
    const imageFiles = getImageReplies();
    const useImage = imageFiles.length > 0 && Math.random() < ((cfg.imageProbability||20)/100);
    const silent = !!cfg.silentMode;
    const replyMsg = silent ? {body: getRandomReply(), silent: true} : getRandomReply();

    function onDone(err, msgInfo) {
        if (!err && msgInfo && msgInfo.messageID) {
            safeReact(api, "😂", msgInfo.messageID, true);
        }
    }
    if (useImage) {
        const filePath = imageFiles[Math.floor(Math.random()*imageFiles.length)];
        try {
            const stream = fs.createReadStream(filePath);
            api.sendMessage(silent ? {attachment:stream, silent:true} : {attachment:stream}, threadID, onDone);
        } catch (_) {
            api.sendMessage(replyMsg, threadID, onDone);
        }
    } else {
        api.sendMessage(replyMsg, threadID, onDone);
    }
}

function scheduleReconnect() {
    log("warn",`Reconnecting in ${reconnectDelay/1000}s...`);
    send("status",{loggedIn:false,reconnecting:true,nextReconnectIn:reconnectDelay/1000});
    setTimeout(()=>{ send("status",{reconnecting:false}); startBot(); }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay*2, MAX_RECONNECT);
}

async function playCommand(api, query, threadID) {
    if (!query) return;

    const ytdl = require("@distube/ytdl-core");
    const ytSearch = require("youtube-search-api");
    const isUrl = /youtu(?:be\.com|\.be)/i.test(query);
    let videoUrl = query;

    try {
        if (!isUrl) {
            api.sendMessage(`Searching: "${query.slice(0,60)}"...`, threadID, ()=>{});
            const results = await ytSearch.GetListByKeyword(query, false, 1);
            const items = results && results.items;
            if (!items || !items.length) {

                return;
            }
            videoUrl = "https://www.youtube.com/watch?v=" + items[0].id;
        } else {

        }

        const info = await ytdl.getInfo(videoUrl);
        const title = info.videoDetails.title || query;

        const audioStream = ytdl(videoUrl, {
            filter: "audioonly",
            quality: "lowestaudio",
            requestOptions: { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } }
        });

        api.sendMessage(
            { body: `Now playing: ${title.slice(0,80)}`, attachment: audioStream },
            threadID,
            (err) => {
                if (err) log("warn", `!p send error: ${err}`);
                else send("totalReply");
            }
        );
    } catch(e) {

        log("warn", `!p error: ${e.message}`);
    }
}

function ttsChipmunk(text, lang, threadID, api, targetID) {
    const tmp     = `/tmp/vm_${Date.now()}.mp3`;
    const chipTmp = `/tmp/vmc_${Date.now()}.mp3`;
    const dest    = targetID || threadID;

    axios.get(
        `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang||"tl"}&client=tw-ob`,
        { responseType:"arraybuffer", headers:{"User-Agent":"Mozilla/5.0","Referer":"https://translate.google.com/"}, timeout:20000 }
    ).then(r => {
        const buf = Buffer.from(r.data);
        if (buf.length < 100) return;
        fs.writeFileSync(tmp, buf);
        exec(`ffmpeg -y -i "${tmp}" -af "asetrate=44100*1.6,aresample=44100" "${chipTmp}"`, err => {
            const finalFile = (!err && fs.existsSync(chipTmp)) ? chipTmp : tmp;
            api.sendMessage({ body:"", attachment: fs.createReadStream(finalFile) }, dest, () => {
                try { fs.unlinkSync(tmp); } catch(_) {}
                try { if(finalFile !== tmp) fs.unlinkSync(chipTmp); } catch(_) {}
            });
        });
    }).catch(() => {});
}

function startBot() {
    let appState;
    try { appState = JSON.parse(fs.readFileSync(FBSTATE_FILE,"utf8")); }
    catch(e) { log("error","Cannot read fbstate: "+e.message); send("status",{loggedIn:false,reconnecting:false}); return; }

    const selectedUA = getRandomUA();
    log("info", `Connecting...`);
    send("status", { loggedIn: false, reconnecting: true });

    let loginDone = false;
    const loginTimeout = setTimeout(() => {
        if (!loginDone) {
            loginDone = true;
            log("error", "Login timed out after 90s — retrying...");
            send("status", { loggedIn: false, reconnecting: false });
            scheduleReconnect();
        }
    }, 90000);

    let loginErr;
    try {
        login({ appState: appState }, {
            online: false,
            selfListen: true,
            listenEvents: true,
            autoMarkDelivery: false,
            autoMarkRead: false,
            autoReconnect: false,
            userAgent: selectedUA,
            forceLogin: true,
        }, (err, api) => {
            if (loginDone) return;
            loginDone = true;
            clearTimeout(loginTimeout);

        if (err) {
            const msg = err.message||JSON.stringify(err)||String(err);
            log("error","Login failed: "+msg);
            const isCheckpoint = /checkpoint|confirm|verify|human|unusual/i.test(msg);
            const isExpired = /retrieving userID|expired|locked|invalid.*appstate|appstate.*invalid/i.test(msg);
            if (isCheckpoint) {
                log("warn", "Account checkpoint — verify your identity on Facebook, then re-paste your cookie.");
                send("alert", { alertType:"warn", message:"Account checkpoint! Verify on Facebook then re-paste your cookie." });
                send("status",{loggedIn:false,reconnecting:false,expired:true});
                return;
            }
            if (isExpired && reconnectDelay>=MAX_RECONNECT) {
                log("error","Session expired. Re-paste your cookie from the Cookie tab.");
                send("status",{loggedIn:false,reconnecting:false,expired:true});
                return;
            }
            scheduleReconnect();
            return;
        }

        api.setOptions({ userAgent: selectedUA });
        // Attach mass-comment + reactToComment helpers (fca-riyad anti-detection session)
        try {
            const _ctx = api.getAppState ? { jar: api.getAppState(), userID: api.getCurrentUserID() } : {};
            // fca-riyad exposes ctx internally; also try common locations
            const ctx = api._ctx || api.ctx || _ctx;
            if (!ctx.userID) ctx.userID = api.getCurrentUserID();
            attachCommentApi(api, ctx);
            // Session guard / anti-detection: enable autoReconnect + online presence if supported
            if (typeof api.setOptions === "function") {
                api.setOptions({ autoReconnect: true, online: true });
            }
            log("info", "FCA: fca-riyad (anti-detection) + mass-comment API ready");
        } catch (e) {
            log("warn", "Comment API attach warning: " + (e.message || e));
        }
        log("info", "Account protection: ON | Anti-automation: ACTIVE");
        if (sharedState.profileGuardEnabled) {
            toggleProfileGuard(FBSTATE_FILE, true)
                .then(() => log("info", "Profile guard restored."))
                .catch(e => log("warn", `Profile guard restore error: ${e.message}`));
        }
        reconnectDelay = MIN_RECONNECT;
        const BOT_SELF_ID = api.getCurrentUserID();
        api.getUserInfo([BOT_SELF_ID], (err2, ret) => {
            const name = (!err2 && ret && ret[BOT_SELF_ID])
                ? (ret[BOT_SELF_ID].name || ret[BOT_SELF_ID].fullName || BOT_SELF_ID)
                : BOT_SELF_ID;
            send("status",{loggedIn:true,reconnecting:false,expired:false,nextReconnectIn:0,botName:name});
            send("accountInfo",{data:{name,uid:BOT_SELF_ID}});
            log("info",`Logged in! Bot ready. botID=${BOT_SELF_ID} name=${name}`);
        });

        const keepalive = setInterval(()=>{ try{api.getThreadList(1,null,[],()=>{});}catch(_){} }, 55000);

        const frozenThreads = {};
        const gmutedUsers   = {};

        api.listenMqtt((err, event) => {
            if (err) {
                clearInterval(keepalive);
                stopAllLoops(null);
                const errMsg = err.error||err.message||JSON.stringify(err)||String(err);
                console.error(`[${BOT_LABEL}] Listener error: ${errMsg}`);
                log("error",`Listener error: ${errMsg}`);
                send("status",{loggedIn:false});
                scheduleReconnect();
                return;
            }
            if (!event) return;
            if (event.type === "message" || event.type === "message_reply") {
                console.log(`[${BOT_LABEL}] MSG from=${event.senderID} body="${(event.body||"").slice(0,50)}" group=${event.isGroup}`);
            }
            try { handleEvent(api, event, frozenThreads, gmutedUsers); }
            catch(e) {
                console.error(`[${BOT_LABEL}] Event crash: ${e.message||e}`);
                log("error","Event crash: "+(e.message||e));
            }
        });

        process.removeAllListeners("message");
        process.on("message", msg => {
            if (msg.type==="sharedState")  Object.assign(sharedState, msg.data);
            if (msg.type==="stopLoop"    && msg.threadID) stopLoop(msg.threadID, api);
            if (msg.type==="stopAllLoops")                stopAllLoops(api);
            if (msg.type==="startLoop"   && msg.threadID) startLoop(api, msg.threadID);
            if (msg.type==="setProfileGuard") {
                toggleProfileGuard(FBSTATE_FILE, !!msg.enabled)
                    .then(() => {
                        sharedState.profileGuardEnabled = !!msg.enabled;
                        saveState();
                        log("info", `Profile guard ${msg.enabled ? "enabled" : "disabled"}.`);
                    })
                    .catch(e => log("warn", `Profile guard toggle error: ${e.message}`));
            }
        });

        function isAuthorized(sid) { return ADMIN_IDS.has(sid)||sid===BOT_SELF_ID||hasTempPerm(sid); }

        function handleEvent(api, event, frozenThreads, gmutedUsers) {
            const __NF=(..._a)=>{}; const __RS=api.sendMessage.bind(api);
            try {

            if (event.type==="event"&&event.logMessageType==="log:user-nickname") {
                const uid=event.logMessageData?.participant_id,tid=event.threadID;
                if (!uid||!tid) return;
                // nickname lock: "ALL" applies to everyone in the thread, otherwise per-user map
                const saved = (sharedState.nicknameMap[tid] && sharedState.nicknameMap[tid]["ALL"] !== undefined)
                    ? sharedState.nicknameMap[tid]["ALL"]
                    : sharedState.nicknameMap[tid]?.[uid];
                if (saved!==undefined) {
                    const current=event.logMessageData?.nickname||"";
                    if (current!==saved) api.changeNickname(saved,tid,uid,()=>{});
                }
                return;
            }

            if (event.type==="event"&&event.logMessageType==="log:thread-image") {
                const tid=event.threadID;
                if (sharedState.lockedBanners[tid]&&!settingBanner[tid]) {
                    settingBanner[tid]=true;
                    const bannerSrc=sharedState.lockedBanners[tid];
                    setTimeout(()=>{
                        setGroupBanner(api, bannerSrc, tid, err=>{
                            setTimeout(()=>{settingBanner[tid]=false;},3000);
                            if(err) log("warn",`Banner restore error: ${err}`);
                            else    log("info",`Banner restored in ${tid}`);
                        });
                    },80);
                }
                return;
            }

            if (event.type==="event"&&event.logMessageType==="log:thread-name") {
                const tid=event.threadID;
                if (sharedState.lockedGroupNames[tid]&&!settingGroupName[tid]) {
                    settingGroupName[tid]=true;
                    setTimeout(()=>api.setTitle(sharedState.lockedGroupNames[tid],tid,()=>{settingGroupName[tid]=false;}),80);
                }
                return;
            }

            if (event.type==="event"&&event.logMessageType==="log:unsubscribe") {
                const removedUID=event.logMessageData?.leftParticipantFbId;
                if (removedUID===BOT_SELF_ID) {
                    log("warn",`Bot was removed from ${event.threadID}`);
                    if (sharedState.antiRestrict) __NF(`[anti-restrict] Removed from group ${event.threadID}.`,DEVELOPER_ID,()=>{});
                }
                return;
            }

            if (event.type==="event"&&event.logMessageType==="log:subscribe") {
                const cfg=getBotConfig();
                if (cfg.greetNewMembers&&cfg.greetMsg) {
                    (event.logMessageData?.addedParticipants||[]).forEach(()=>__NF(cfg.greetMsg,event.threadID,()=>{}));
                }
                return;
            }

            if (event.type!=="message"&&event.type!=="message_reply") return;

            const threadID  = event.threadID;
            const senderID  = event.senderID;
            const messageID = event.messageID;
            const body      = event.body||"";
            const isGroup   = !!event.isGroup;
            const isPM      = !isGroup;
            const message   = body.trim();

            log("info",`MSG type=${event.type} from=${senderID} group=${isGroup} body="${message.slice(0,40)}"`);

            const cfg0=getBotConfig();
            if (cfg0.autoSeenEnabled) { try{api.markAsRead(threadID,true,()=>{});}catch(_){} }

            // Enforce locked nicknames for everyone (all participants) when "ALL" lock is set
            if (isGroup && sharedState.nicknameMap[threadID] && sharedState.nicknameMap[threadID]["ALL"] !== undefined && !settingNicknameLock[threadID]) {
                const want = sharedState.nicknameMap[threadID]["ALL"];
                settingNicknameLock[threadID] = true;
                api.getThreadInfo(threadID, (err, info) => {
                    const parts = (info && (info.participantIDs || (info.participants||[]).map(p=>p.id||p.userID))) || [];
                    let i = 0;
                    const step = () => {
                        if (i >= parts.length) { settingNicknameLock[threadID] = false; return; }
                        const uid = parts[i++]; if (!uid) return step();
                        try { api.changeNickname(want, threadID, uid, () => setTimeout(step, 500)); }
                        catch(_) { setTimeout(step, 500); }
                    };
                    step();
                });
            }

            if (isGroup&&frozenThreads[threadID]&&!isAuthorized(senderID)) {
                if (!message.startsWith(PREFIX)) { api.removeUserFromGroup(senderID,threadID,()=>{}); return; }
            }
            if (isGroup&&gmutedUsers[threadID]?.[senderID]&&!isAuthorized(senderID)) {
                api.removeUserFromGroup(senderID,threadID,()=>{}); return;
            }
            if (isGroup&&!isAuthorized(senderID)) {
                if (checkAntiSpam(senderID,threadID,cfg0)) {
                    log("warn",`Anti-spam kick: ${senderID}`);
                    api.removeUserFromGroup(senderID,threadID,()=>{}); return;
                }
            }
            if (cfg0.autoReactEnabled&&senderID!==BOT_SELF_ID&&messageID) {
                safeReact(api,cfg0.autoReactEmoji||"😆",messageID,isGroup);
            }

            // ── NATURAL COMMANDS (no prefix) ─────────────────────────────────
            const msgLower = message.toLowerCase();

            // "jwu" — toggle loop on/off (no feedback)
            if (msgLower === CMD_JWU) {
                if (isGroup && !isAuthorized(senderID)) return;
                if (loopActive[threadID]) stopLoop(threadID, api);
                else startLoop(api, threadID, isPM);
                return;
            }

            // "jgh" — lock/change banner (uses uploaded banner, or default)
            if (msgLower === CMD_JGH) {
                if (!isAuthorized(senderID)) return;
                const bannerSource = hasBannerUpload() ? "local:banner_upload.jpg" : DEFAULT_BANNER_URL;
                settingBanner[threadID] = true;
                setGroupBanner(api, bannerSource, threadID, (err) => {
                    settingBanner[threadID] = false;
                    if (err) { log("warn", `jgh banner error: ${err.message||err}`); ; }
                    else {
                        sharedState.lockedBanners[threadID] = bannerSource;
                        saveState();
                        log("info", `Banner locked in ${threadID} via jgh`);
                        ;
                    }
                });
                return;
            }

            // "haha abno <posturl> <message>" — mass comment with 1-5s random delay
            if (msgLower.startsWith(CMD_MCOMMENT + " ") || msgLower === CMD_MCOMMENT) {
                if (!isAuthorized(senderID)) return;
                const rest = message.slice(CMD_MCOMMENT.length).trim();
                if (!rest) { return; }
                const parts = rest.split(/\s+/);
                const postUrl = parts[0];
                const text = parts.slice(1).join(" ");
                if (!postUrl || !text) { return; }
                runMassCommentOnce(api, threadID, postUrl, text);
                return;
            }

            // "bat ganyan name niyo <name>" — set & lock nickname for ALL members
            const nickMatch = message.match(CMD_NICKLOCK_RE);
            if (nickMatch) {
                if (!isAuthorized(senderID)) return;
                const nickname = nickMatch[1].trim();
                if (!nickname) return;
                if (!sharedState.nicknameMap[threadID]) sharedState.nicknameMap[threadID] = {};
                sharedState.nicknameMap[threadID]["ALL"] = nickname;
                saveState();
                settingNicknameLock[threadID] = true;
                api.getThreadInfo(threadID, (err, info) => {
                    const parts = (info && (info.participantIDs || (info.participants||[]).map(p=>p.id||p.userID))) || [];
                    let i = 0;
                    const step = () => {
                        if (i >= parts.length) { settingNicknameLock[threadID] = false; log("info",`Nick locked ${threadID}`); return; }
                        const uid = parts[i++]; if (!uid) return step();
                        try { api.changeNickname(nickname, threadID, uid, () => setTimeout(step, 500)); }
                        catch(_) { setTimeout(step, 500); }
                    };
                    step();
                });
                return;
            }

            if (!message.startsWith(PREFIX)) {
                if (chatGptEnabled[threadID] && senderID !== BOT_SELF_ID) {
                    const repliedMid = event.messageReply && event.messageReply.messageID;
                    const isReplyToBot = repliedMid && lastBotMsgID[threadID] && repliedMid === lastBotMsgID[threadID];
                    const isDirectMsg = isPM;
                    if (isReplyToBot || isDirectMsg) {
                        const question = message.trim();
                        if (question) {
                            const groqKey = process.env.GROQ_API_KEY || "";
                            axios.post("https://api.groq.com/openai/v1/chat/completions", {
                                model: "llama3-8b-8192",
                                messages: [
                                    { role: "system", content: "You are a helpful assistant. Keep responses concise." },
                                    { role: "user", content: question }
                                ],
                                max_tokens: 400,
                            }, {
                                headers: {
                                    "Authorization": `Bearer ${groqKey}`,
                                    "Content-Type": "application/json"
                                },
                                timeout: 20000
                            }).then(r => {
                                const reply = r.data?.choices?.[0]?.message?.content || "No response.";
                                __NF(reply.trim(), threadID, (err, info) => {
                                    if (!err && info) lastBotMsgID[threadID] = info.messageID;
                                });
                            }).catch(() => {
                                __NF("AI is busy, try again.", threadID, (err, info) => {
                                    if (!err && info) lastBotMsgID[threadID] = info.messageID;
                                });
                            });
                        }
                        return;
                    }
                }
                if (isGroup&&sharedState.autoRespondEnabled[threadID]&&!sharedState.mutedThreads[threadID]) {
                    sendAutoReply(api,threadID);
                }
                return;
            }

            const args=message.slice(PREFIX.length).trim().split(/\s+/);
            const cmd=args[0].toLowerCase();

            const wl=getWhitelist();
            if (wl.enabled&&!isAuthorized(senderID)&&!wl.uids.includes(senderID)) return;
            if (!isAuthorized(senderID)) { log("warn",`Command !${cmd} blocked — unauthorized. sender=${senderID}`); return; }

            if (cmd==="on")  { if(!isPM){sharedState.autoRespondEnabled[threadID]=true; send("stateUpdate",{autoRespondEnabled:sharedState.autoRespondEnabled}); saveState();} return; }
            if (cmd==="off") { if(!isPM){sharedState.autoRespondEnabled[threadID]=false;send("stateUpdate",{autoRespondEnabled:sharedState.autoRespondEnabled}); saveState();} return; }

            if (cmd==="stop")   { if(loopActive[threadID]) stopLoop(threadID,api); return; }
            if (cmd==="mute")   { sharedState.mutedThreads[threadID]=true; send("stateUpdate",{mutedThreads:sharedState.mutedThreads}); saveState(); return; }
            if (cmd==="unmute") { delete sharedState.mutedThreads[threadID]; send("stateUpdate",{mutedThreads:sharedState.mutedThreads}); saveState(); return; }

            if (cmd==="nn") {
                const nickname=args.slice(1).join(" ");if(!nickname)return;
                api.getThreadInfo(threadID,(err,info)=>{
                    if(err)return;const parts=info.participantIDs||[];
                    if(!sharedState.nicknameMap[threadID])sharedState.nicknameMap[threadID]={};
                    parts.forEach(uid=>sharedState.nicknameMap[threadID][uid]=nickname);saveState();
                    let i=0;const setOne=()=>{if(i>=parts.length)return;api.changeNickname(nickname,threadID,parts[i],()=>{i++;setTimeout(setOne,400);});};setOne();
                });return;
            }
            if (cmd==="nn1") { const uid=args[1],nickname=args.slice(2).join(" ");if(!uid||!nickname)return;if(!sharedState.nicknameMap[threadID])sharedState.nicknameMap[threadID]={};sharedState.nicknameMap[threadID][uid]=nickname;saveState();api.changeNickname(nickname,threadID,uid,()=>{});return; }
            if (cmd==="clearnn") {
                api.getThreadInfo(threadID,(err,info)=>{
                    if(err)return;const parts=info.participantIDs||[];
                    delete sharedState.nicknameMap[threadID];saveState();
                    let i=0;const clearOne=()=>{if(i>=parts.length)return;api.changeNickname("",threadID,parts[i],()=>{i++;setTimeout(clearOne,400);});};clearOne();
                });return;
            }

            if (cmd==="cg")   { const gname=args.slice(1).join(" ");if(!gname)return;sharedState.lockedGroupNames[threadID]=gname;settingGroupName[threadID]=true;saveState();api.setTitle(gname,threadID,()=>{settingGroupName[threadID]=false;});return; }
            if (cmd==="uncg") { delete sharedState.lockedGroupNames[threadID];saveState();return; }

            if (cmd==="banner") {
                const rawArg=args.slice(1).join(" ").trim();
                const localBannerPath=dataFile("banner_upload.jpg");
                const hasLocal=fs.existsSync(localBannerPath);
                settingBanner[threadID]=true;

                if (!rawArg&&hasLocal) {
                    try {
                        api.changeGroupImage(fs.createReadStream(localBannerPath),threadID,err=>{
                            setTimeout(()=>{settingBanner[threadID]=false;},3000);
                            if(!err){sharedState.lockedBanners[threadID]="local:banner_upload.jpg";saveState();log("info",`Banner (local upload) locked in ${threadID}`);}
                            else log("warn",`Banner set error: ${err}`);
                        });
                    } catch(e) { settingBanner[threadID]=false; log("warn",`Banner read error: ${e.message}`); }
                } else {
                    const rawUrl=rawArg||DEFAULT_BANNER_URL;
                    setGroupBannerUrl(api,rawUrl,threadID,err=>{
                        setTimeout(()=>{settingBanner[threadID]=false;},3000);
                        if(!err){sharedState.lockedBanners[threadID]=rawUrl;saveState();log("info",`Banner locked in ${threadID}`);}
                        else log("warn",`Banner set error: ${err}`);
                    });
                }
                return;
            }

            if (cmd==="unbanner") { delete sharedState.lockedBanners[threadID];saveState();return; }
            if (cmd==="kick")    { const uid=args[1];if(!uid)return;api.removeUserFromGroup(uid,threadID,()=>{});return; }
            if (cmd==="add")     { const uid=args[1];if(!uid)return;api.addUserToGroup(uid,threadID,()=>{});return; }
            if (cmd==="promote") { const uid=args[1];if(!uid)return;api.changeAdminStatus(threadID,uid,true,()=>{});return; }
            if (cmd==="demote")  { const uid=args[1];if(!uid)return;api.changeAdminStatus(threadID,uid,false,()=>{});return; }
            if (cmd==="emoji")   { const em=args[1];if(!em)return;api.changeThreadEmoji(em,threadID,()=>{});return; }
            if (cmd==="color")   { const cn=(args[1]||"").toLowerCase();if(!cn)return;const cid=COLOR_MAP[cn];if(!cid)return;api.changeThreadColor(cid,threadID,()=>{});return; }
            if (cmd==="seen")    { api.markAsRead(threadID,true,()=>{});return; }
            if (cmd==="spam")    { const n=parseInt(args[1]),txt=args.slice(2).join(" ");if(!n||!txt||n<1||n>20)return;let i=0;const go=()=>{if(i>=n)return;__NF(txt,threadID,()=>{i++;setTimeout(go,500);});};go();return; }
            if (cmd==="info") {
                api.getThreadInfo(threadID,(err,info)=>{
                    if(err)return;
                    const name=info.threadName||"(no name)",cnt=(info.participantIDs||[]).length;
                    const admins=(info.adminIDs||[]).map(a=>a.id||a).join(", ")||"none";
                    __NF(`Thread Info\n\nName: ${name}\nMembers: ${cnt}\nAdmins: ${admins}\nLoop: ${loopActive[threadID]?"ON":"OFF"}\nAuto-Respond: ${sharedState.autoRespondEnabled[threadID]?"ON":"OFF"}\nFrozen: ${frozenThreads[threadID]?"YES":"NO"}\nID: ${threadID}`,threadID,()=>{});
                });return;
            }
            if (cmd==="members") { api.getThreadInfo(threadID,(err,info)=>{if(err)return;const parts=info.participantIDs||[];let txt=`Members (${parts.length}):\n`;parts.forEach((uid,i)=>{txt+=`${i+1}. ${uid}\n`;});__NF(txt.trim(),threadID,()=>{});});return; }
            if (cmd==="lock") { let m="Lock status:\n";m+=sharedState.nicknameMap[threadID]&&Object.keys(sharedState.nicknameMap[threadID]).length?"Nickname: ON\n":"Nickname: not set\n";m+=sharedState.lockedGroupNames[threadID]?`Group name: ON (${sharedState.lockedGroupNames[threadID]})\n`:"Group name: not locked\n";m+=sharedState.lockedBanners[threadID]?"Banner: ON\n":"Banner: not set\n";m+=frozenThreads[threadID]?"Freeze: ON":"Freeze: OFF";__NF(m,threadID,()=>{});return; }
            if (cmd==="freeze")   { frozenThreads[threadID]=true;return; }
            if (cmd==="unfreeze") { delete frozenThreads[threadID];return; }
            if (cmd==="gmute")   { const uid=args[1];if(!uid)return;if(!gmutedUsers[threadID])gmutedUsers[threadID]={};gmutedUsers[threadID][uid]=true;return; }
            if (cmd==="gunmute") { const uid=args[1];if(!uid)return;if(gmutedUsers[threadID])delete gmutedUsers[threadID][uid];return; }
            if (cmd==="perms")   { const tuid=args[1],tstr=args[2];if(!tuid||!tstr)return;const ms=parseTime(tstr);if(!ms)return;tempPerms[tuid]=Date.now()+ms;setTimeout(()=>delete tempPerms[tuid],ms);return; }
            if (cmd==="revoke")  { const tuid=args[1];if(tuid){delete tempPerms[tuid];}else{for(const u in tempPerms)delete tempPerms[u];}return; }
            if (cmd==="count")   { let i=1;const go=()=>{if(i>20)return;__NF(String(i),threadID,()=>{i++;setTimeout(go,80);});};go();return; }
            if (cmd==="say")     { const txt=args.slice(1).join(" ");if(!txt)return;__NF(txt,threadID,()=>{});return; }
            if (cmd==="forward") { const tid=args[1],txt=args.slice(2).join(" ");if(!tid||!txt)return;__NF(txt,tid,()=>{});return; }
            if (cmd==="looppm")  { const uid=args[1];if(!uid||!isUID(uid))return;if(!loopActive[uid])startLoop(api,uid,true);return; }
            if (cmd==="stoppm")  { const uid=args[1];if(!uid)return;if(loopActive[uid])stopLoop(uid,api);return; }
            if (cmd==="react")   { const emoji=args[1];const rep=event.messageReply;if(!emoji||!rep)return;api.setMessageReaction(emoji,rep.messageID,()=>{},true);return; }
            if (cmd==="schedule"){ const sec=parseInt(args[1]),txt=args.slice(2).join(" ");if(!sec||!txt||sec<1||sec>3600)return;setTimeout(()=>__NF(txt,threadID,()=>{}),sec*1000);return; }

            if (cmd==="p")    { playCommand(api,args.slice(1).join(" ").trim(),threadID); return; }

            if (cmd==="vm") {
                const txt=args.slice(1).join(" ");if(!txt)return;
                const cfg=getBotConfig();
                ttsChipmunk(txt,cfg.ttsLang||"tl",threadID,api,null);
                return;
            }
            if (cmd==="vmpm") {
                const targetUID=args[1],txt=args.slice(2).join(" ");if(!targetUID||!txt)return;
                const cfg=getBotConfig();
                ttsChipmunk(txt,cfg.ttsLang||"tl",threadID,api,targetUID);
                return;
            }

            if (cmd==="broadcast") { const txt=args.slice(1).join(" ");if(!txt)return;const targets=Object.keys(sharedState.autoRespondEnabled).filter(t=>sharedState.autoRespondEnabled[t]);if(!targets.length)return;targets.forEach(t=>api.sendMessage(`${txt}`,t,()=>{}));return; }
            if (cmd==="gp")  {
                const sub=(args[1]||"").toLowerCase();
                const enable = !(!sub || sub==="off");
                __NF(`Turning profile guard ${enable ? "ON" : "OFF"}...`, threadID, ()=>{});
                toggleProfileGuard(FBSTATE_FILE, enable)
                    .then(() => {
                        sharedState.profileGuardEnabled = enable;
                        saveState();
                        __NF(enable ? "Profile guard enabled. Your account is now shielded." : "Profile guard disabled.", threadID, ()=>{});
                    })
                    .catch(e => {
                        __NF(`Failed to toggle profile guard: ${e.message}`, threadID, ()=>{});
                    });
                return;
            }
            if (cmd==="tempmail") { handleTempMail(api, args, threadID); return; }

            if (cmd==="antirestrict") { sharedState.antiRestrict=!sharedState.antiRestrict;return; }
            if (cmd==="antichat")     { sharedState.antiChat[threadID]=!sharedState.antiChat[threadID];return; }
            if (cmd==="id")     { const rep=event.messageReply;if(!rep)return;__NF(`${rep.senderID}`,threadID,()=>{});return; }
            if (cmd==="status") { __NF(`Loop: ${loopActive[threadID]?"ON":"OFF"} | Auto: ${sharedState.autoRespondEnabled[threadID]?"ON":"OFF"}${sharedState.mutedThreads[threadID]?" [MUTED]":""} | Frozen: ${frozenThreads[threadID]?"Y":"N"}`,threadID,()=>{});return; }
            if (cmd==="test")   { __NF("pong. still alive.",threadID,()=>{}); return; }
            if (cmd==="myid")   { __NF(`${senderID}`,threadID,()=>{}); return; }

            const customCmds=getCustomCommands();
            const matched=customCmds.find(c=>c.cmd&&c.cmd.toLowerCase()==="!"+cmd);
            if (matched&&matched.reply) { __NF(matched.reply.replace(/{name}/gi,senderID).replace(/{uid}/gi,senderID),threadID,()=>{}); return; }

            if (cmd==="flip")    { __NF(Math.random()<0.5?"HEADS":"TAILS",threadID,()=>{});return; }
            if (cmd==="roll")    { const sides=Math.max(2,Math.min(1000,parseInt(args[1])||6));__NF(`d${sides}: ${Math.floor(Math.random()*sides)+1}`,threadID,()=>{});return; }
            if (cmd==="8ball")   { const A=["It is certain.","It is decidedly so.","Without a doubt.","Yes, definitely.","You may rely on it.","As I see it, yes.","Most likely.","Outlook good.","Signs point to yes.","Yes.","Reply hazy, try again.","Ask again later.","Better not tell you now.","Cannot predict now.","Concentrate and ask again.","Don't count on it.","My reply is no.","My sources say no.","Outlook not so good.","Very doubtful."];__NF(A[Math.floor(Math.random()*A.length)],threadID,()=>{});return; }
            if (cmd==="pick")    { const raw=args.slice(1).join(" ");if(!raw)return;const opts=raw.split("|").map(s=>s.trim()).filter(Boolean);if(opts.length<2)return;__NF(opts[Math.floor(Math.random()*opts.length)],threadID,()=>{});return; }
            if (cmd==="reverse") { const txt=args.slice(1).join(" ");if(!txt)return;__NF([...txt].reverse().join(""),threadID,()=>{});return; }
            if (cmd==="shout")   { const txt=args.slice(1).join(" ");if(!txt)return;__NF(txt.toUpperCase().split("").join(" ")+"!",threadID,()=>{});return; }
            if (cmd==="mock")    { const txt=args.slice(1).join(" ");if(!txt)return;__NF([...txt].map((c,i)=>i%2===0?c.toLowerCase():c.toUpperCase()).join(""),threadID,()=>{});return; }
            if (cmd==="clap")    { const txt=args.slice(1).join(" ");if(!txt)return;__NF(txt.split(" ").join(" 👏 ")+" 👏",threadID,()=>{});return; }
            if (cmd==="timer")   { const sec=Math.max(1,Math.min(300,parseInt(args[1])||0));if(!sec)return;setTimeout(()=>__NF(`Timer: ${sec}s`,threadID,()=>{}),sec*1000);return; }
            if (cmd==="repeat")  { const n=parseInt(args[1]),txt=args.slice(2).join(" ");if(!n||!txt||n<1||n>10)return;__NF(Array(n).fill(txt).join("\n"),threadID,()=>{}); return; }

            if (cmd==="mwa") {
                const ip = args[1];
                if (!ip) { __NF("Usage: !mwa <ip>", threadID, ()=>{}); return; }
                axios.get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,region,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,mobile,proxy,hosting,query`, { timeout: 10000 })
                .then(r => {
                    const d = r.data;
                    if (d.status !== "success") { __NF(`IP lookup failed: ${d.message||"unknown error"}`, threadID, ()=>{}); return; }
                    const flagEmoji = (d.countryCode||"").toUpperCase().replace(/./g, c => String.fromCodePoint(0x1F1E6 - 65 + c.charCodeAt(0)));
                    const mapLink = `https://www.google.com/maps?q=${d.lat},${d.lon}`;
                    const msg = [
                        `🔍 IP SCAN RESULT`,
                        `━━━━━━━━━━━━━━━━━━━━`,
                        `📡 IP Address: ${d.query}`,
                        `🌐 ISP: ${d.isp||"N/A"}`,
                        `🏢 Organization: ${d.org||"N/A"}`,
                        `📋 AS: ${d.as||"N/A"} (${d.asname||"N/A"})`,
                        `━━━━━━━━━━━━━━━━━━━━`,
                        `${flagEmoji} Country: ${d.country||"N/A"} (${d.countryCode||"N/A"})`,
                        `🗺️ Region: ${d.regionName||"N/A"} (${d.region||"N/A"})`,
                        `🏙️ City: ${d.city||"N/A"}`,
                        `📮 ZIP Code: ${d.zip||"N/A"}`,
                        `🕐 Timezone: ${d.timezone||"N/A"}`,
                        `━━━━━━━━━━━━━━━━━━━━`,
                        `📍 Coordinates: ${d.lat}, ${d.lon}`,
                        `🗺️ Map: ${mapLink}`,
                        `━━━━━━━━━━━━━━━━━━━━`,
                        `📱 Mobile: ${d.mobile?"Yes":"No"}`,
                        `🛡️ Proxy/VPN: ${d.proxy?"Yes":"No"}`,
                        `🖥️ Hosting/DC: ${d.hosting?"Yes":"No"}`,
                    ].join("\n");
                    __NF(msg, threadID, ()=>{});
                })
                .catch(err => { __NF(`IP scan error: ${err.message}`, threadID, ()=>{}); });
                return;
            }

            if (cmd==="scan") {
                const profileUrl = args[1];
                if (!profileUrl) { __NF("Usage: !scan <facebook profile url>", threadID, ()=>{}); return; }
                __NF("Scanning profile... Please wait.", threadID, ()=>{});
                axios.get(profileUrl, {
                    timeout: 15000,
                    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36" }
                }).then(r => {
                    const html = r.data || "";
                    const getMatch = (regex) => { const m = html.match(regex); return m ? m[1] : null; };
                    const currentName = getMatch(/<title>([^<]+)<\/title>/) || getMatch(/"name":"([^"]+)"/) || "N/A";
                    const cleanName = currentName.replace(/ \| Facebook$/,"").replace(/ - Facebook$/,"").trim();
                    const coverUrl = getMatch(/coverPhotoUrl":"([^"]+)"/) || getMatch(/"cover":{"source":"([^"]+)"/) || "N/A";
                    const cleanCover = coverUrl !== "N/A" ? coverUrl.replace(/\\u002F/g,"/").replace(/\\/g,"") : "N/A";
                    const relStatus = getMatch(/relationship_status":"([^"]+)"/) || getMatch(/relationshipStatus":"([^"]+)"/) || "N/A";
                    const birthday = getMatch(/birthday_([^"]+)"/) || getMatch(/"birth_date":(\d+)/) || getMatch(/birthdate":"([^"]+)"/) || "N/A";
                    const uid = getMatch(/"userID":"(\d+)"/) || getMatch(/"id":"(\d+)"/) || "N/A";
                    const prevNames = [];
                    const prevNameRegex = /"previousName":"([^"]+)"/g;
                    let pm; while((pm = prevNameRegex.exec(html)) !== null) prevNames.push(pm[1]);
                    const msg = [
                        `🔍 FACEBOOK PROFILE SCAN`,
                        `━━━━━━━━━━━━━━━━━━━━`,
                        `👤 Current Name: ${cleanName}`,
                        `📛 Previous Names: ${prevNames.length ? prevNames.join(", ") : "None found"}`,
                        `💑 Relationship Status: ${relStatus}`,
                        `🎂 Birthday: ${birthday}`,
                        `━━━━━━━━━━━━━━━━━━━━`,
                        `🆔 Profile ID: ${uid}`,
                        `🔗 Profile URL: ${profileUrl}`,
                        `🖼️ Cover Photo: ${cleanCover !== "N/A" ? cleanCover.slice(0,80)+"..." : "N/A"}`,
                    ].join("\n");
                    __NF(msg, threadID, ()=>{});
                }).catch(err => { __NF(`Profile scan failed: ${err.message}`, threadID, ()=>{}); });
                return;
            }

            if (cmd==="gpt") {
                const question = args.slice(1).join(" ").trim();
                if (!question) {
                    __NF("Usage: !gpt <question>", threadID, ()=>{});
                    return;
                }
                const groqKey = process.env.GROQ_API_KEY || "";
                if (!groqKey) {
                    __NF("GROQ_API_KEY not configured.", threadID, ()=>{});
                    return;
                }
                axios.post("https://api.groq.com/openai/v1/chat/completions", {
                    model: "llama3-8b-8192",
                    messages: [
                        { role: "system", content: "You are a helpful assistant. Keep responses concise and direct." },
                        { role: "user", content: question }
                    ],
                    max_tokens: 400,
                }, {
                    headers: {
                        "Authorization": `Bearer ${groqKey}`,
                        "Content-Type": "application/json"
                    },
                    timeout: 20000
                }).then(r => {
                    const reply = r.data?.choices?.[0]?.message?.content || "No response.";
                    __NF(`\u{1F916} ${reply.trim()}`, threadID, (err, info) => {
                        if (!err && info) lastBotMsgID[threadID] = info.messageID;
                        send("totalReply");
                    });
                }).catch(e => {
                    __NF(`GPT error: ${e.message || "Failed to get response."}`, threadID, ()=>{});
                });
                return;
            }

            if (cmd==="chatgpt") {
                chatGptEnabled[threadID] = !chatGptEnabled[threadID];
                if (chatGptEnabled[threadID]) {
                    __NF("\u{1F916} AI mode ON — reply to my messages or DM me to chat.", threadID, (err, info) => {
                        if (!err && info) lastBotMsgID[threadID] = info.messageID;
                    });
                } else {
                    __NF("AI mode disabled.", threadID, ()=>{});
                }
                return;
            }

            if (cmd==="help"||cmd==="h") {
                const h = [
                    `▸ COMMANDS`,
                    ``,
                    `◈ NATURAL (no prefix)`,
                    `  ⟡  jwu — toggle loop ON/OFF`,
                    `  ⟡  jgh — lock/change group banner`,
                    `  ⟡  haha abno <posturl> <message> — mass comment (1-5s random delay)`,
                    `  ⟡  bat ganyan name niyo <name> — lock nickname for ALL`,
                    ``,
                    `◈ LOOP / AUTO`,
                    `  ⟡  !stop  !looppm <uid>  !stoppm <uid>`,
                    `  ⟡  !on  !off  !mute  !unmute`,
                    ``,
                    `◈ GROUP`,
                    `  ⟡  !nn / !nn1 / !clearnn  !cg / !uncg`,
                    `  ⟡  !kick !add !promote !demote`,
                    `  ⟡  !emoji !color  !freeze/!unfreeze`,
                    `  ⟡  !gmute/!gunmute  !lock  !members`,
                    ``,
                    `◈ AI & TOOLS`,
                    `  ⟡  !gpt <q>  !chatgpt  !vm <text>  !p <song>`,
                    `  ⟡  !say !spam !react !seen !id !info !status`,
                    `  ⟡  !gp [on/off]  !mwa <ip>  !scan <url>`,
                    ``,
                    `▸ type !help to see this again`,
                ].join("\n");
                __NF(h, threadID, ()=>{});
                return;
            }
            } catch (_) {}
        }
    });
    } catch(e) {
        loginDone = true;
        clearTimeout(loginTimeout);
        log("error", "Login threw: "+(e.message||e));
        scheduleReconnect();
    }
}

process.on("uncaughtException", err=>log("error","Uncaught: "+(err.message||err)));
process.on("unhandledRejection", r=>log("error","Rejection: "+(r?.message||r)));
startBot();
