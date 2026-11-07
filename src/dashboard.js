"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");
const auth = require("./auth");
const { replies } = require("./replies");

const MAX_LOGS = 200;
const userStates   = new Map();
const accountInfos = new Map();
const pendingCookies = new Map(); // server-side store: token -> {cookie, botName, createdAt}
setInterval(()=>{const cutoff=Date.now()-10*60*1000;for(const[k,v]of pendingCookies)if(v.createdAt<cutoff)pendingCookies.delete(k);},60000);

function getUserState(userId) {
    if (!userStates.has(userId)) {
        const s = {
            bots:[], developerID:"", loopEnabled:{}, autoRespondEnabled:{},
            mutedThreads:{}, totalRepliesSent:0, startedAt:new Date(),
            botName:"", loginInProgress:false, logs:[], alerts:[], msgTimestamps:[],
            get loggedIn()    { return this.bots.some(b=>b.loggedIn); },
            get reconnecting(){ return !this.loggedIn&&this.bots.some(b=>b.reconnecting); },
        };
        userStates.set(userId, s);
    }
    return userStates.get(userId);
}
const state = getUserState(auth.ADMIN_ID||"admin_001");

function addLog(userId,type,message){ const s=getUserState(userId);s.logs.unshift({time:new Date().toLocaleTimeString(),type,message});if(s.logs.length>MAX_LOGS)s.logs.pop(); }
function sysLog(type,message){ addLog(auth.ADMIN_ID||"admin_001",type,message); }
function addAlert(userId,type,message){ const s=getUserState(userId);s.alerts.unshift({time:new Date().toLocaleTimeString(),type,message});if(s.alerts.length>50)s.alerts.pop(); }
function trackMessage(userId){ const s=getUserState(userId);s.msgTimestamps.push(Date.now());const cutoff=Date.now()-24*3600*1000;while(s.msgTimestamps.length&&s.msgTimestamps[0]<cutoff)s.msgTimestamps.shift(); }
function setAccountInfoForUser(userId,data){ if(!accountInfos.has(userId))accountInfos.set(userId,{});Object.assign(accountInfos.get(userId),data); }
function getAccountInfo(userId){ return accountInfos.get(userId)||{}; }

let _cookieUpdateCb=null;    function setCookieUpdateHandler(cb){_cookieUpdateCb=cb;}
let _loopControlCb=null;     function setLoopControlHandler(cb){_loopControlCb=cb;}
let _botProfileGuardCb=null; function setBotProfileGuardHandler(cb){_botProfileGuardCb=cb;}
let _stopAllCb=null;      function setStopAllHandler(cb){_stopAllCb=cb;}

function uDir(userId){ return auth.getUserDataDir(userId); }
function uFile(userId,name){ return path.join(uDir(userId),name); }

function readCustomReplies(uid)    { try{return JSON.parse(fs.readFileSync(uFile(uid,"custom_replies.json"),"utf8"));}catch(_){return[];} }
function writeCustomReplies(uid,a) { auth.ensureUserDataDir(uid);fs.writeFileSync(uFile(uid,"custom_replies.json"),JSON.stringify(a,null,2),"utf8"); }
function readBotConfig(uid) {
    try{return JSON.parse(fs.readFileSync(uFile(uid,"bot_config.json"),"utf8"));}
    catch(_){return{loopReact:"😆",loopDelay:1,imageProbability:20,loopMode:"sequential",loopStartMsg:"",loopStopMsg:"",maxLoopCount:0,autoStopMinutes:0,ttsLang:"tl",reactOnlyMode:false,greetNewMembers:false,greetMsg:"Welcome!",antiSpamEnabled:false,antiSpamMaxMsg:5,antiSpamWindowSec:10,autoSeenEnabled:false,typingSimulate:false,silentMode:false,loopSilentMode:false,autoReactEnabled:false,autoReactEmoji:"😆",useBuiltinReplies:true,massCommentEnabled:false,massCommentPostIDs:"",massCommentTexts:"Nice post!\nGreat content!\nAwesome! 🔥",massCommentDelayMin:15,massCommentDelayMax:45,massCommentReact:false,massCommentReaction:"like"};}
}
function writeBotConfig(uid,c)     { auth.ensureUserDataDir(uid);fs.writeFileSync(uFile(uid,"bot_config.json"),JSON.stringify(c,null,2),"utf8"); }
function readCustomCommands(uid)   { try{return JSON.parse(fs.readFileSync(uFile(uid,"custom_commands.json"),"utf8"));}catch(_){return[];} }
function writeCustomCommands(uid,a){ auth.ensureUserDataDir(uid);fs.writeFileSync(uFile(uid,"custom_commands.json"),JSON.stringify(a,null,2),"utf8"); }
function readWhitelist(uid)        { try{return JSON.parse(fs.readFileSync(uFile(uid,"whitelist.json"),"utf8"));}catch(_){return{enabled:false,uids:[]};} }
function writeWhitelist(uid,w)     { auth.ensureUserDataDir(uid);fs.writeFileSync(uFile(uid,"whitelist.json"),JSON.stringify(w,null,2),"utf8"); }
function readThreadConfig(uid)     { try{return JSON.parse(fs.readFileSync(uFile(uid,"thread_config.json"),"utf8"));}catch(_){return{};} }
function writeThreadConfig(uid,c)  { auth.ensureUserDataDir(uid);fs.writeFileSync(uFile(uid,"thread_config.json"),JSON.stringify(c,null,2),"utf8"); }
function getUploads(uid) {
    const dir=path.join(uDir(uid),"uploads");
    try{return fs.readdirSync(dir).filter(f=>/\.(jpg|jpeg|png|gif|webp)$/i.test(f)).sort();}catch(_){return[];}
}
function hasBannerUpload(uid){ return fs.existsSync(path.join(uDir(uid),"banner_upload.jpg")); }
function getFbstateFiles(uid){ try{return fs.readdirSync(uDir(uid)).filter(f=>/^fbstate.*\.json$/i.test(f)).sort();}catch(_){return["fbstate.json"];} }
function hasCookieForUser(uid){ const dir=uDir(uid);try{const files=fs.readdirSync(dir).filter(f=>/^fbstate.*\.json$/i.test(f));return files.some(f=>{try{const arr=JSON.parse(fs.readFileSync(path.join(dir,f),"utf8"));return Array.isArray(arr)&&arr.length>0;}catch(_){return false;}});}catch(_){return false;} }

function getUptime(userId){ const ms=Date.now()-getUserState(userId).startedAt.getTime();const s=Math.floor(ms/1000),m=Math.floor(s/60),h=Math.floor(m/60),d=Math.floor(h/24);if(d>0)return`${d}d ${h%24}h`;if(h>0)return`${h}h ${m%60}m`;if(m>0)return`${m}m ${s%60}s`;return`${s}s`; }
function getHourlyStats(userId){ const now=Date.now();const buckets=new Array(24).fill(0);for(const ts of (getUserState(userId).msgTimestamps||[])){const h=Math.floor((now-ts)/3600000);if(h<24)buckets[23-h]++;}return buckets; }
function esc(str){ return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function getClientIP(req) {
    return (req.headers["x-forwarded-for"]||"").split(",")[0].trim() ||
           req.headers["x-real-ip"] ||
           req.socket?.remoteAddress ||
           "unknown";
}

function parseBody(req) {
    return new Promise(resolve=>{
        let raw="";
        req.on("data",c=>{raw+=c.toString();});
        req.on("end",()=>{
            const p={};
            raw.split("&").forEach(pair=>{
                const eqIdx=pair.indexOf("=");if(eqIdx===-1)return;
                try{const k=decodeURIComponent(pair.slice(0,eqIdx).replace(/\+/g," "));const v=decodeURIComponent(pair.slice(eqIdx+1).replace(/\+/g," "));p[k]=v;}catch(_){}
            });
            resolve(p);
        });
    });
}
function parseJsonBody(req) {
    return new Promise(resolve=>{
        let raw="";
        req.on("data",c=>{raw+=c.toString();});
        req.on("end",()=>{ try{resolve(JSON.parse(raw));}catch(_){resolve({});} });
    });
}
function getSessionFromReq(req){ const raw=req.headers.cookie||"";const match=raw.match(/(?:^|;\s*)dbl_sess=([^;]+)/);return match?auth.getSession(match[1]):null; }
function getTokenFromReq(req)  { const raw=req.headers.cookie||"";const match=raw.match(/(?:^|;\s*)dbl_sess=([^;]+)/);return match?match[1]:null; }

// ─── STAR FIELD JS ────────────────────────────────────────────────────────────
const COSMOS_JS = `
(function(){
  var el=document.getElementById('cosmos');
  if(!el)return;
  var small=window.matchMedia&&window.matchMedia('(max-width:700px)').matches;
  import('/assets/faulty-terminal.js').then(function(m){
    m.createFaultyTerminal(el,{
      tint:'#a78bfa',
      brightness:0.6,
      glow:0.4,
      curvature:0.12,
      scanlineIntensity:0.25,
      vignette:0.3,
      mouseReact:!small,
      clickEffect:small?'none':'glitch',
      dpr:small?1:1.5
    });
  }).catch(function(e){console.error('bg failed',e);});
})();
`;

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap');
:root{
  --bg:#020209;
  --sidebar:rgba(4,3,18,0.97);
  --card:rgba(10,8,32,0.65);
  --card2:rgba(14,10,42,0.82);
  --glass:rgba(139,92,246,0.07);
  --glass2:rgba(139,92,246,0.14);
  --border:rgba(139,92,246,0.20);
  --border2:rgba(196,181,253,0.38);
  --red:#7c3aed;--red2:#a78bfa;--red3:#c4b5fd;--red-dim:#6d28d9;
  --gold:#f59e0b;--gold2:#fbbf24;--cosmic:#60a5fa;
  --white:#f0efff;--off:#d0ccf4;--gray:#6e6a9e;--gray2:#3e3a6e;
  --ok:#34d399;--warn:#fbbf24;--info:#818cf8;--danger:#f87171;
  --sb-w:252px;
}
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;overflow:hidden;}
body{font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--off);font-size:13px;line-height:1.5;}
#cosmos{position:fixed;top:0;left:0;width:100%;height:100%;z-index:0;pointer-events:none;overflow:hidden;}
#cosmos canvas{display:block;width:100%;height:100%;}
::-webkit-scrollbar{width:4px;height:4px;}
::-webkit-scrollbar-track{background:transparent;}
::-webkit-scrollbar-thumb{background:rgba(139,92,246,0.3);border-radius:99px;}
::-webkit-scrollbar-thumb:hover{background:rgba(167,139,250,0.5);}
::selection{background:rgba(124,58,237,0.35);color:var(--white);}
a{text-decoration:none;color:var(--red3);}
a:hover{color:var(--red2);}
summary::-webkit-details-marker{display:none;}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.6;transform:scale(1.3);}}
@keyframes spin{to{transform:rotate(360deg);}}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
@keyframes glow{0%,100%{box-shadow:0 0 20px rgba(124,58,237,0.3);}50%{box-shadow:0 0 40px rgba(124,58,237,0.6),0 0 60px rgba(245,158,11,0.15);}}

/* ── SIDEBAR ── */
.sb{position:fixed;top:0;left:0;height:100%;width:var(--sb-w);background:var(--sidebar);border-right:1px solid var(--border);display:flex;flex-direction:column;z-index:100;transition:width .28s cubic-bezier(.4,0,.2,1);backdrop-filter:blur(28px);}
.sb.col{width:66px;}
.sb-top{display:flex;align-items:center;gap:12px;padding:20px 16px 14px;min-height:68px;overflow:hidden;}
.sb-logo{width:36px;height:36px;border-radius:11px;background:linear-gradient(135deg,#7c3aed,#f59e0b);display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 0 20px rgba(124,58,237,0.5);animation:glow 4s ease-in-out infinite;}
.sb-logo svg{color:#fff;width:20px;height:20px;}
.sb-brand{overflow:hidden;white-space:nowrap;transition:opacity .2s,max-width .28s;max-width:160px;}
.sb.col .sb-brand{max-width:0;opacity:0;}
.sb-name{font-size:14px;font-weight:800;background:linear-gradient(90deg,#c4b5fd,#f59e0b);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:.04em;}
.sb-sub{font-size:9.5px;color:var(--gray);letter-spacing:.12em;font-weight:600;margin-top:1px;}
.sb-tog{display:flex;align-items:center;gap:7px;background:var(--glass);border:1px solid var(--border);color:var(--gray);border-radius:9px;padding:7px 12px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s;margin:0 10px 10px;white-space:nowrap;overflow:hidden;}
.sb-tog:hover{background:var(--glass2);border-color:var(--border2);color:var(--red3);}
.tog-lbl{overflow:hidden;transition:max-width .28s;max-width:120px;}
.sb.col .tog-lbl{max-width:0;}
.sb.col .sb-tog{justify-content:center;padding:8px;}
.sb-nav{flex:1;overflow-y:auto;overflow-x:hidden;padding:4px 8px;}
.sb-nav::-webkit-scrollbar{width:2px;}
.ni{display:flex;align-items:center;gap:11px;padding:10px 12px;border-radius:11px;cursor:pointer;transition:all .18s;color:var(--gray);font-size:12.5px;font-weight:500;white-space:nowrap;overflow:hidden;margin-bottom:2px;border:1px solid transparent;}
.ni:hover{background:var(--glass);color:var(--off);border-color:var(--border);}
.ni.act{background:linear-gradient(135deg,rgba(124,58,237,0.22),rgba(245,158,11,0.10));border-color:rgba(124,58,237,0.38);color:var(--red3);box-shadow:0 2px 18px rgba(124,58,237,0.15);}
.ni .ico{width:20px;height:20px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.ni .ico svg{width:16px;height:16px;}
.ni .lbl{overflow:hidden;transition:max-width .28s;max-width:160px;}
.sb.col .ni .lbl{max-width:0;}
.sb-foot{padding:10px;border-top:1px solid var(--border);}
.u-pill{display:flex;align-items:center;gap:10px;padding:7px 4px;margin-bottom:7px;overflow:hidden;}
.u-av{width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#f59e0b);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800;color:#fff;flex-shrink:0;}
.u-info{overflow:hidden;white-space:nowrap;transition:max-width .28s;max-width:160px;}
.sb.col .u-info{max-width:0;}
.u-name{font-size:12.5px;font-weight:700;color:var(--white);overflow:hidden;text-overflow:ellipsis;}
.u-role{font-size:10px;color:var(--gray);margin-top:1px;}
.lo-btn{display:flex;align-items:center;gap:8px;width:100%;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.22);color:#f87171;border-radius:9px;padding:8px 12px;font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s;overflow:hidden;white-space:nowrap;}
.lo-btn:hover{background:rgba(248,113,113,0.16);box-shadow:0 0 16px rgba(248,113,113,0.2);}
.lo-lbl{overflow:hidden;transition:max-width .28s;max-width:120px;}
.sb.col .lo-lbl{max-width:0;}

/* ── MAIN AREA ── */
.mw{margin-left:var(--sb-w);height:100%;display:flex;flex-direction:column;transition:margin-left .28s cubic-bezier(.4,0,.2,1);position:relative;z-index:10;}
.mw.col{margin-left:66px;}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:0 26px;height:56px;background:rgba(2,2,9,0.75);border-bottom:1px solid var(--border);backdrop-filter:blur(20px);flex-shrink:0;}
.tb-title{font-size:15px;font-weight:800;background:linear-gradient(90deg,var(--red3),var(--gold2));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:.03em;}
.tb-title span{font-weight:400;-webkit-text-fill-color:var(--gray);opacity:.7;}
.tb-right{display:flex;align-items:center;gap:12px;}
.mc{flex:1;overflow-y:auto;padding:20px 26px 32px;scrollbar-width:thin;scrollbar-color:var(--border) transparent;}

/* ── STATUS ── */
.st-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;font-size:11px;font-weight:700;letter-spacing:.04em;}
.st-dot{width:7px;height:7px;border-radius:50%;animation:pulse 2.2s infinite;flex-shrink:0;}
.st-on{background:rgba(52,211,153,0.12);border:1px solid rgba(52,211,153,0.3);color:#34d399;}
.st-on .st-dot{background:#34d399;box-shadow:0 0 8px #34d399;}
.st-warn{background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.3);color:#fbbf24;}
.st-warn .st-dot{background:#fbbf24;}
.st-off{background:rgba(110,106,158,0.08);border:1px solid rgba(110,106,158,0.2);color:var(--gray);}
.st-off .st-dot{background:var(--gray);}

/* ── PILL SLIDER TABS ── */
.itabs-outer{position:relative;display:flex;gap:2px;background:rgba(8,4,28,0.78);border:1px solid var(--border);border-radius:15px;padding:5px;margin-bottom:20px;flex-wrap:wrap;backdrop-filter:blur(18px);}
#itabPill{position:absolute;border-radius:10px;background:linear-gradient(135deg,rgba(124,58,237,0.42),rgba(109,40,217,0.28));border:1px solid rgba(196,181,253,0.42);box-shadow:0 0 22px rgba(124,58,237,0.28),inset 0 1px 0 rgba(255,255,255,0.08);transition:left .32s cubic-bezier(.4,0,.2,1),width .32s cubic-bezier(.4,0,.2,1),top .32s cubic-bezier(.4,0,.2,1),height .32s cubic-bezier(.4,0,.2,1);pointer-events:none;z-index:0;opacity:0;}
.itab{position:relative;z-index:1;display:flex;align-items:center;gap:6px;padding:8px 15px;border-radius:10px;cursor:pointer;font-size:12px;font-weight:600;color:var(--gray);transition:color .2s;white-space:nowrap;user-select:none;}
.itab svg{width:14px;height:14px;flex-shrink:0;}
.itab:hover{color:var(--off);}
.itab.act{color:var(--red3);}

/* ── HERO ── */
.hero{background:linear-gradient(135deg,rgba(10,6,36,0.88) 0%,rgba(18,8,50,0.78) 100%);border:1px solid var(--border);border-radius:18px;padding:22px 26px;margin-bottom:18px;position:relative;overflow:hidden;}
.hero::before{content:'';position:absolute;top:-50px;right:-50px;width:220px;height:220px;background:radial-gradient(circle,rgba(124,58,237,0.18) 0%,transparent 70%);pointer-events:none;}
.hero::after{content:'';position:absolute;bottom:-40px;right:60px;width:160px;height:160px;background:radial-gradient(circle,rgba(245,158,11,0.10) 0%,transparent 70%);pointer-events:none;}
.hero-in{display:flex;align-items:center;justify-content:space-between;gap:20px;position:relative;z-index:1;}
.hero-l{display:flex;align-items:center;gap:18px;}
.hero-ic{width:50px;height:50px;border-radius:14px;background:linear-gradient(135deg,rgba(124,58,237,0.28),rgba(245,158,11,0.18));border:1px solid rgba(124,58,237,0.42);display:flex;align-items:center;justify-content:center;box-shadow:0 0 28px rgba(124,58,237,0.25);flex-shrink:0;}
.hero-ic svg{width:24px;height:24px;color:var(--red3);}
.hero-title{font-size:20px;font-weight:800;background:linear-gradient(90deg,var(--white),var(--red3));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.hero-ver{font-size:10.5px;font-weight:700;background:none;-webkit-text-fill-color:initial;color:var(--gold);padding:2px 9px;border:1px solid rgba(245,158,11,0.4);border-radius:20px;vertical-align:middle;margin-left:7px;}
.hero-desc{font-size:12.5px;color:var(--gray);margin-top:5px;}
.hero-pills{display:flex;flex-wrap:wrap;gap:7px;margin-top:10px;}
.pill{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid;}
.pill i{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
.p-on{background:rgba(52,211,153,0.10);border-color:rgba(52,211,153,0.28);color:#34d399;}
.p-on i{background:#34d399;}
.p-warn{background:rgba(251,191,36,0.10);border-color:rgba(251,191,36,0.28);color:#fbbf24;}
.p-warn i{background:#fbbf24;}
.p-off{background:rgba(110,106,158,0.10);border-color:rgba(110,106,158,0.2);color:var(--gray);}
.p-off i{background:var(--gray);}

/* ── STAT CARDS ── */
.sg{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px;}
@media(max-width:900px){.sg{grid-template-columns:1fr 1fr;}}
.sc{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:18px 20px;position:relative;overflow:hidden;transition:border-color .2s,box-shadow .2s;}
.sc:hover{border-color:var(--border2);box-shadow:0 4px 30px rgba(124,58,237,0.12);}
.sc-glow{position:absolute;top:-30px;right:-30px;width:100px;height:100px;border-radius:50%;filter:blur(32px);opacity:.3;}
.gc-r{background:#7c3aed;}.gc-w{background:#f59e0b;}.gc-g{background:#34d399;}.gc-o{background:#60a5fa;}
.sc-ico{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;margin-bottom:12px;}
.sc-ico svg{width:18px;height:18px;}
.ci-r{background:rgba(124,58,237,0.18);color:var(--red3);}
.ci-w{background:rgba(245,158,11,0.15);color:var(--gold);}
.ci-g{background:rgba(52,211,153,0.15);color:#34d399;}
.ci-o{background:rgba(96,165,250,0.15);color:var(--cosmic);}
.sc-val{font-size:22px;font-weight:800;color:var(--white);line-height:1;}
.sc-lbl{font-size:11px;color:var(--gray);margin-top:5px;font-weight:500;}

/* ── BOXES ── */
.box{background:var(--card);border:1px solid var(--border);border-radius:16px;margin-bottom:16px;overflow:hidden;transition:border-color .2s;}
.box:hover{border-color:rgba(139,92,246,0.32);}
.bh{display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid var(--border);background:rgba(8,4,28,0.35);}
.bt{font-size:13px;font-weight:700;color:var(--white);flex:1;}
.bm{font-size:11px;color:var(--gray);margin-left:auto;}
.shd{font-size:10.5px;font-weight:700;color:var(--gray);text-transform:uppercase;letter-spacing:.10em;margin:20px 0 10px;display:flex;align-items:center;gap:7px;}
.shd svg{width:12px;height:12px;}

/* ── CHIPS ── */
.chip{padding:3px 9px;border-radius:7px;font-size:10px;font-weight:700;letter-spacing:.06em;border:1px solid;white-space:nowrap;}
.chip{background:rgba(124,58,237,0.12);border-color:rgba(124,58,237,0.30);color:var(--red3);}
.chip-g{background:rgba(52,211,153,0.10);border-color:rgba(52,211,153,0.28);color:#34d399;}
.chip-y{background:rgba(251,191,36,0.10);border-color:rgba(251,191,36,0.28);color:#fbbf24;}
.chip-p{background:rgba(129,140,248,0.10);border-color:rgba(129,140,248,0.28);color:#818cf8;}
.chip-b{background:rgba(96,165,250,0.10);border-color:rgba(96,165,250,0.28);color:var(--cosmic);}

/* ── TABLES ── */
table{width:100%;border-collapse:collapse;}
th{text-align:left;padding:9px 16px;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--gray);border-bottom:1px solid var(--border);}
td{padding:10px 16px;font-size:12.5px;color:var(--off);border-bottom:1px solid rgba(139,92,246,0.06);}
tr:last-child td{border-bottom:none;}
tr:hover td{background:rgba(124,58,237,0.03);}
.td-m{font-family:'Courier New',monospace;font-size:11.5px;}
.td-e{text-align:center;color:var(--gray2);font-style:italic;padding:22px 16px;}
.tag{display:inline-block;padding:3px 9px;border-radius:6px;font-size:10.5px;font-weight:700;letter-spacing:.04em;}
.tag-g{background:rgba(52,211,153,0.12);color:#34d399;border:1px solid rgba(52,211,153,0.25);}
.tag-d{background:rgba(110,106,158,0.10);color:var(--gray);border:1px solid rgba(110,106,158,0.20);}
.tag-r{background:rgba(248,113,113,0.12);color:#f87171;border:1px solid rgba(248,113,113,0.25);}
.tag-b{background:rgba(96,165,250,0.12);color:var(--cosmic);border:1px solid rgba(96,165,250,0.25);}
.tag-y{background:rgba(251,191,36,0.12);color:#fbbf24;border:1px solid rgba(251,191,36,0.25);}

/* ── LOGS ── */
.la{max-height:260px;overflow-y:auto;}
.lr{display:flex;align-items:flex-start;gap:8px;padding:7px 16px;border-bottom:1px solid rgba(139,92,246,0.05);font-size:11.5px;}
.lr:last-child{border-bottom:none;}
.lt{color:var(--gray2);flex-shrink:0;font-family:monospace;font-size:10.5px;}
.ll{font-weight:700;letter-spacing:.05em;flex-shrink:0;width:44px;font-size:10px;}
.lm{color:var(--off);word-break:break-all;line-height:1.4;}
.lr-info .ll{color:var(--info);}
.lr-warn .ll{color:var(--warn);}
.lr-error .ll{color:var(--danger);}
.lr-reply .ll{color:var(--ok);}
.lr-error .lm{color:#fca5a5;}
.lr-warn .lm{color:#fde68a;}

/* ── FORMS ── */
.fld{margin-bottom:12px;}
.flbl{display:block;font-size:10.5px;font-weight:700;color:var(--gray);margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em;}
.fi,.fs,.ai{width:100%;padding:9px 13px;background:rgba(8,6,28,0.75);border:1px solid var(--border);border-radius:10px;color:var(--white);font-size:12.5px;font-family:inherit;transition:border-color .2s,box-shadow .2s;outline:none;}
.fi:focus,.fs:focus,.ai:focus{border-color:var(--red2);box-shadow:0 0 0 3px rgba(124,58,237,0.14);}
.fs option{background:#0a0820;}
.fhint,.hint{font-size:11px;color:var(--gray2);margin-top:5px;line-height:1.5;}
textarea.ck-ta,.ck-ta{width:100%;padding:10px 13px;background:rgba(8,6,28,0.75);border:1px solid var(--border);border-radius:10px;color:var(--white);font-size:12px;font-family:'Courier New',monospace;resize:vertical;outline:none;transition:border-color .2s,box-shadow .2s;min-height:90px;}
.ck-ta:focus{border-color:var(--red2);box-shadow:0 0 0 3px rgba(124,58,237,0.14);}
.tr-row{display:flex;align-items:center;gap:10px;padding:8px 0;font-size:12.5px;color:var(--off);cursor:pointer;user-select:none;}
.tck{display:none;}
.ttr{width:34px;height:19px;border-radius:10px;background:rgba(110,106,158,0.22);border:1px solid var(--border);position:relative;transition:all .22s;flex-shrink:0;}
.tth{position:absolute;top:3px;left:3px;width:13px;height:13px;border-radius:50%;background:var(--gray);transition:all .22s;}
.tck:checked+.ttr{background:linear-gradient(90deg,#7c3aed,#a78bfa);border-color:rgba(167,139,250,0.5);box-shadow:0 0 12px rgba(124,58,237,0.3);}
.tck:checked+.ttr .tth{left:18px;background:#fff;}

/* ── BUTTONS ── */
.btn{display:inline-flex;align-items:center;gap:7px;padding:9px 18px;background:linear-gradient(135deg,#7c3aed,#6d28d9);border:1px solid rgba(196,181,253,0.22);border-radius:10px;color:#fff;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .22s;box-shadow:0 4px 20px rgba(124,58,237,0.32);}
.btn:hover{background:linear-gradient(135deg,#8b47f5,#7c3aed);box-shadow:0 4px 30px rgba(124,58,237,0.55);transform:translateY(-1px);}
.btn-r{background:linear-gradient(135deg,#7c3aed,#6d28d9);}
.btn-sm{padding:6px 13px;font-size:11.5px;}
.btn-xs{padding:4px 9px;font-size:11px;}
.btn-o{background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.32);color:var(--gold2);box-shadow:none;}
.btn-o:hover{background:rgba(245,158,11,0.22);box-shadow:0 0 20px rgba(245,158,11,0.25);}
.btn-danger{background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.28);color:#f87171;box-shadow:none;}
.btn-danger:hover{background:rgba(248,113,113,0.20);box-shadow:0 0 16px rgba(248,113,113,0.2);}
.btn-a{padding:8px 16px;background:linear-gradient(135deg,#7c3aed,#6d28d9);border:1px solid rgba(196,181,253,0.22);border-radius:9px;color:#fff;font-size:12.5px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;white-space:nowrap;box-shadow:0 4px 16px rgba(124,58,237,0.28);}
.btn-a:hover{background:linear-gradient(135deg,#8b47f5,#7c3aed);box-shadow:0 4px 24px rgba(124,58,237,0.50);}
.btn-rm{width:23px;height:23px;border-radius:6px;background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.22);color:#f87171;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;padding:0;line-height:1;}
.btn-rm:hover{background:rgba(248,113,113,0.22);}
.add-row{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border);}

/* ── UPLOAD / PHOTO ── */
.photo-grid{display:flex;flex-wrap:wrap;gap:10px;padding:14px 16px;}
.photo-item{position:relative;border-radius:10px;overflow:hidden;width:88px;height:88px;border:1px solid var(--border);flex-shrink:0;}
.photo-thumb{width:100%;height:100%;object-fit:cover;}
.photo-overlay{position:absolute;inset:0;background:rgba(0,0,0,0.62);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s;}
.photo-item:hover .photo-overlay{opacity:1;}
.photo-rm-btn{width:28px;height:28px;border-radius:50%;background:rgba(248,113,113,0.9);border:none;color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;}
.photo-empty{padding:22px;text-align:center;color:var(--gray2);font-size:12px;}
.upload-btn-label{display:inline-flex;align-items:center;gap:7px;padding:8px 14px;background:rgba(124,58,237,0.12);border:1px solid rgba(124,58,237,0.30);border-radius:9px;color:var(--red3);font-size:12px;font-weight:600;cursor:pointer;transition:all .2s;}
.upload-btn-label:hover{background:rgba(124,58,237,0.22);box-shadow:0 0 14px rgba(124,58,237,0.25);}
.msg-row{display:flex;align-items:center;gap:10px;padding:9px 16px;border-bottom:1px solid rgba(139,92,246,0.06);}
.msg-row:last-child{border-bottom:none;}
.msg-txt{flex:1;font-size:12.5px;color:var(--off);}
.prebuilt-row{padding:5px 16px;font-size:11.5px;color:var(--gray);border-bottom:1px solid rgba(139,92,246,0.04);}

/* ── BANNER ── */
.banner-preview{max-width:100%;max-height:180px;border-radius:10px;border:1px solid var(--border);margin-bottom:10px;display:block;}
.banner-empty-prev{background:rgba(8,6,28,0.6);border:2px dashed var(--border2);border-radius:10px;padding:22px;text-align:center;font-size:12px;color:var(--gray);}

/* ── STEPS ── */
.steps-g{display:flex;flex-direction:column;gap:10px;}
.step{display:flex;gap:12px;align-items:flex-start;}
.snum{width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,rgba(124,58,237,0.22),rgba(245,158,11,0.12));border:1px solid rgba(124,58,237,0.36);color:var(--red3);font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.stxt{font-size:12.5px;color:var(--off);line-height:1.6;}

/* ── COMMANDS ── */
.cmd-section{padding:12px 16px;}
.cmd-grid{display:flex;flex-direction:column;gap:2px;}
.cmd-item{padding:5px 0;}
.cmd-name{font-family:'Courier New',monospace;font-size:12px;color:var(--red3);font-weight:700;}
.cmd-desc{font-size:11px;color:var(--gray);margin-top:1px;}

/* ── COOKIE ENTRY ── */
.ck-page{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;position:relative;z-index:10;}
.ck-card{width:100%;max-width:420px;background:rgba(8,6,30,0.88);border:1px solid var(--border);border-radius:22px;padding:36px 32px 30px;backdrop-filter:blur(28px);box-shadow:0 16px 60px rgba(0,0,0,0.6),0 0 60px rgba(124,58,237,0.10);}
.ck-logo{display:flex;align-items:center;justify-content:center;margin-bottom:22px;}
.ck-logo-ic{width:58px;height:58px;border-radius:18px;background:linear-gradient(135deg,#7c3aed,#f59e0b);display:flex;align-items:center;justify-content:center;box-shadow:0 0 36px rgba(124,58,237,0.5);}
.ck-logo-ic svg{width:28px;height:28px;color:#fff;}
.ck-title{text-align:center;font-size:22px;font-weight:800;background:linear-gradient(90deg,var(--white),var(--red3));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px;}
.ck-sub{text-align:center;font-size:12px;color:var(--gray);margin-bottom:22px;line-height:1.5;}
.ck-err{background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.28);border-radius:10px;padding:10px 14px;font-size:12px;color:#f87171;margin-bottom:16px;}
.ck-ok{background:rgba(52,211,153,0.10);border:1px solid rgba(52,211,153,0.28);border-radius:10px;padding:10px 14px;font-size:12px;color:#34d399;margin-bottom:16px;}
.fb-link{display:inline-flex;align-items:center;gap:7px;color:var(--gray);font-size:12px;text-decoration:none;transition:color .2s;}
.fb-link:hover{color:var(--cosmic);}
.loading-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(196,181,253,0.2);border-top:2px solid var(--red3);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;}

/* ── ADMIN ── */
.adm-banner{background:linear-gradient(135deg,rgba(124,58,237,0.12),rgba(245,158,11,0.06));border:1px solid var(--border2);border-radius:16px;padding:20px 24px;display:flex;align-items:center;gap:16px;margin-bottom:20px;}
.adm-ic{width:44px;height:44px;background:linear-gradient(135deg,rgba(124,58,237,0.28),rgba(245,158,11,0.18));border-radius:12px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(124,58,237,0.38);}
.adm-title{font-size:18px;font-weight:800;color:var(--white);}
.adm-sub{font-size:12px;color:var(--gray);margin-top:3px;}
.key-cell{font-family:'Courier New',monospace;font-size:11px;color:var(--red3);background:rgba(124,58,237,0.08);border:1px solid rgba(124,58,237,0.22);padding:2px 8px;border-radius:5px;cursor:pointer;user-select:all;letter-spacing:.06em;display:inline-block;}
.key-cell:hover{border-color:var(--border2);}
details.box>summary{list-style:none;}
details.box[open]>summary{border-bottom:1px solid var(--border);}
.conn-btn{width:100%;padding:12px;background:linear-gradient(135deg,#7c3aed,#6d28d9);border:1px solid rgba(196,181,253,0.22);color:#fff;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .22s;box-shadow:0 4px 24px rgba(124,58,237,0.35);display:flex;align-items:center;justify-content:center;gap:8px;}
.conn-btn:hover{box-shadow:0 4px 36px rgba(124,58,237,0.55);transform:translateY(-1px);}

/* ── MISC ── */
@media(max-width:700px){.mw{margin-left:66px;}.sb{width:66px;}.sb .sb-brand,.sb .tog-lbl,.sb .ni .lbl,.sb .u-info,.sb .lo-lbl{max-width:0;opacity:0;}.sb .sb-top{padding:18px 12px;}.mc{padding:14px 14px 24px;}.topbar{padding:0 14px;}.sg{grid-template-columns:1fr 1fr;}}
.mail-card{background:var(--card2);border:1px solid var(--border);border-radius:13px;padding:18px 20px;margin-bottom:12px;}
.mail-addr{font-family:'Courier New',monospace;font-size:15px;font-weight:700;color:var(--off);letter-spacing:.04em;word-break:break-all;}
.inbox-item{padding:12px 18px;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:4px;cursor:pointer;transition:background .15s;}
.inbox-item:hover{background:rgba(124,58,237,0.04);}
.inbox-from{font-size:12px;font-weight:600;color:var(--off);}
.inbox-subj{font-size:12.5px;color:var(--white);}
.inbox-date{font-size:10.5px;color:var(--gray2);}
.inbox-body{font-size:12px;color:var(--gray);white-space:pre-wrap;padding:14px 18px;background:rgba(124,58,237,0.04);border-top:1px solid var(--border);}
`;

// ─── SVG ICONS ────────────────────────────────────────────────────────────────
const I = {
    grid:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>`,
    msg:     `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
    threads: `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
    config:  `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
    cookie:  `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
    terminal:`<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>`,
    book:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`,
    guardPic:`<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle cx="12" cy="10" r="3" fill="none"/></svg>`,
    user:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
    info:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    shield:  `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    logout:  `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
    bot:     `<svg width="20" height="20" fill="none" stroke="#fff" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="9" cy="16" r="1" fill="#fff"/><circle cx="15" cy="16" r="1" fill="#fff"/><path d="M12 11V7"/><circle cx="12" cy="6" r="1"/><path d="M7 11V9a5 5 0 0 1 10 0v2"/></svg>`,
    clock:   `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    image:   `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
    upload:  `<svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>`,
    mail:    `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
    key:     `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
    fb:      `<svg width="18" height="18" viewBox="0 0 24 24" fill="#1877f2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`,
    refresh: `<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`,
};

// ─── COOKIE ENTRY PAGE ────────────────────────────────────────────────────────
function buildCookieEntryPage(error="", successName="", step="cookie") {
    const isCookieStep = step !== "key";
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DUMMYL BOT — ${isCookieStep?"Connect Account":"License Key"}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
*{box-sizing:border-box;margin:0;padding:0;}
html,body{height:100%;font-family:'Inter',system-ui,sans-serif;}
body{background:#04040e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;}
#cosmos{position:fixed;inset:0;z-index:0;pointer-events:none;overflow:hidden;}
#cosmos canvas{display:block;width:100%;height:100%;}
.wrap{position:relative;z-index:1;width:100%;max-width:480px;padding:20px;}
.card{background:rgba(8,8,22,0.88);backdrop-filter:blur(40px);-webkit-backdrop-filter:blur(40px);border:1px solid rgba(255,255,255,0.09);border-radius:24px;padding:40px 38px;position:relative;overflow:hidden;box-shadow:0 0 60px rgba(200,220,255,0.04),0 24px 90px rgba(0,0,0,0.9);animation:cardIn .55s cubic-bezier(0.2,0,0,1);}
@keyframes cardIn{from{opacity:0;transform:translateY(22px) scale(0.97);}to{opacity:1;transform:translateY(0) scale(1);}}
.card::before{content:'';position:absolute;top:0;left:0;right:0;height:1.5px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.6),rgba(200,220,255,0.8),rgba(255,255,255,0.6),transparent);background-size:200% 100%;animation:borderFlow 5s linear infinite;}
@keyframes borderFlow{0%{background-position:-200% 0;}100%{background-position:200% 0;}}
.logo-wrap{display:flex;align-items:center;gap:13px;margin-bottom:28px;}
.logo-icon{width:44px;height:44px;background:linear-gradient(135deg,rgba(255,255,255,0.16),rgba(180,200,255,0.1));border-radius:12px;display:flex;align-items:center;justify-content:center;box-shadow:0 0 24px rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.14);flex-shrink:0;}
.logo-text{font-size:16px;font-weight:800;letter-spacing:.08em;text-shadow:0 0 24px rgba(255,255,255,0.25);}
.logo-sub{font-size:10px;color:#94a3b8;letter-spacing:.06em;margin-top:1px;}
h1{font-size:22px;font-weight:900;margin-bottom:7px;}
.sub{font-size:13px;color:#94a3b8;margin-bottom:26px;line-height:1.6;}
.err{background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.28);border-radius:10px;padding:10px 14px;font-size:12.5px;color:#f87171;margin-bottom:18px;}
.succ{background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.28);border-radius:10px;padding:12px 16px;font-size:13px;color:#4ade80;margin-bottom:18px;text-align:center;font-weight:600;}
.flbl{display:block;font-size:10.5px;font-weight:600;color:#94a3b8;margin-bottom:7px;letter-spacing:.07em;text-transform:uppercase;}
.fi,.ta{width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:11px;padding:10px 14px;color:#fff;font-size:13px;font-family:inherit;transition:all .2s;outline:none;margin-bottom:16px;}
.ta{font-family:'Courier New',monospace;resize:vertical;min-height:110px;}
.fi:focus,.ta:focus{border-color:rgba(255,255,255,0.3);box-shadow:0 0 0 3px rgba(255,255,255,0.06),0 0 18px rgba(255,255,255,0.08);}
.btn{width:100%;padding:13px;background:linear-gradient(135deg,rgba(255,255,255,0.18),rgba(180,200,255,0.12));border:1px solid rgba(255,255,255,0.2);color:#fff;border-radius:12px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .22s;box-shadow:0 4px 24px rgba(255,255,255,0.06);letter-spacing:.03em;position:relative;overflow:hidden;}
.btn:hover{box-shadow:0 4px 40px rgba(255,255,255,0.14);transform:translateY(-1px);}
.btn:disabled{opacity:.6;cursor:not-allowed;transform:none;}
.hint{font-size:11px;color:#64748b;margin-top:-10px;margin-bottom:16px;line-height:1.5;}
.fb-link{display:inline-flex;align-items:center;gap:7px;margin-top:6px;font-size:12px;color:#94a3b8;transition:color .2s;}
.fb-link:hover{color:#1877f2;}
.loading-spin{display:none;width:18px;height:18px;border:2px solid rgba(255,255,255,0.2);border-top:2px solid #fff;border-radius:50%;animation:spin .7s linear infinite;margin:0 auto;}
@keyframes spin{to{transform:rotate(360deg);}}
.progress-steps{display:flex;gap:8px;margin-bottom:28px;}
.ps{flex:1;height:3px;border-radius:2px;background:rgba(255,255,255,0.07);}
.ps.done{background:rgba(255,255,255,0.45);}
.ps.act{background:linear-gradient(90deg,rgba(255,255,255,0.6),rgba(255,255,255,0.15));animation:psAnim 1.5s ease-in-out infinite;}
@keyframes psAnim{0%,100%{opacity:.7;}50%{opacity:1;}}
</style>
</head><body>
<div id="cosmos"></div>
<div class="wrap"><div class="card">
  <div class="logo-wrap">
    <div class="logo-icon">${I.bot}</div>
    <div><div class="logo-text">DUMMYL BOT</div><div class="logo-sub">MESSENGER AUTOMATION PLATFORM</div></div>
  </div>
  <div class="progress-steps">
    <div class="ps ${isCookieStep?"act":"done"}"></div>
    <div class="ps ${!isCookieStep?"act":""}"></div>
  </div>
  ${isCookieStep ? `
  <h1>Connect Your Account</h1>
  <p class="sub">Paste your Facebook session cookie to identify your bot account.</p>
  ${error?`<div class="err">${esc(error)}</div>`:""}
  <form method="POST" action="/api/entry/cookie" id="ckForm">
    <label class="flbl">fbstate.json Cookie</label>
    <textarea class="ta" name="cookie" placeholder='[{"key":"c_user","value":"100xxx","domain":".facebook.com",...},...]' required></textarea>
    <button class="btn" type="submit" id="ckBtn">Verify &amp; Continue</button>
  </form>
  <div class="steps-g" style="margin-top:24px;display:flex;flex-direction:column;gap:8px;">
    <div style="display:flex;align-items:flex-start;gap:12px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,rgba(255,255,255,0.2),rgba(180,200,255,0.12));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;border:1px solid rgba(255,255,255,0.16);">1</div>
      <div style="font-size:12px;color:#e2e8f0;padding-top:2px;">Install <b>c3c-ufc-utility</b> extension on Chrome</div>
    </div>
    <div style="display:flex;align-items:flex-start;gap:12px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,rgba(255,255,255,0.2),rgba(180,200,255,0.12));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;border:1px solid rgba(255,255,255,0.16);">2</div>
      <div style="font-size:12px;color:#e2e8f0;padding-top:2px;">Log in to <b>facebook.com</b>, click extension → <b>Export as JSON</b></div>
    </div>
    <div style="display:flex;align-items:flex-start;gap:12px;padding:10px 14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:10px;">
      <div style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,rgba(255,255,255,0.2),rgba(180,200,255,0.12));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;flex-shrink:0;border:1px solid rgba(255,255,255,0.16);">3</div>
      <div style="font-size:12px;color:#e2e8f0;padding-top:2px;">Paste the JSON above and click <b>Verify &amp; Continue</b></div>
    </div>
  </div>
  ` : `
  <h1>Enter Your License Key</h1>
  <p class="sub">You're connected as <b style="color:#4ade80">${esc(successName)}</b>. Enter your license key to access the dashboard.</p>
  ${error?`<div class="err">${esc(error)}</div>`:""}
  <form method="POST" action="/api/entry/key">
    <input type="hidden" name="botName" value="${esc(successName)}">
    <label class="flbl">License Key</label>
    <input class="fi" type="text" name="licenseKey" placeholder="XXXXX-XXXXX-XXXXX-XXXXX" required autocomplete="off" style="letter-spacing:.08em;font-family:'Courier New',monospace;font-size:14px;">
    <p class="hint">If you don't have a key, contact the developer to purchase one.</p>
    <button class="btn" type="submit">Access Dashboard</button>
  </form>
  <div style="text-align:center;margin-top:20px;">
    <a href="https://www.facebook.com/profile.php?id=61580437366762" target="_blank" class="fb-link">
      ${I.fb} <span>Contact developer on Facebook</span>
    </a>
  </div>
  `}
</div></div>
<script>${COSMOS_JS}</script>
<script>
var form=document.getElementById('ckForm');
if(form){form.addEventListener('submit',function(e){
  var btn=document.getElementById('ckBtn');
  if(btn){btn.disabled=true;btn.innerHTML='<div class="loading-spin" style="display:inline-block"></div> Verifying...';}
});}
</script>
</body></html>`;
}

// ─── LAYOUT ────────────────────────────────────────────────────────────────────
function buildLayout(session, mainTab, content) {
    const uid = session.userId;
    const us  = getUserState(uid);
    const statusClass = us.loggedIn ? "st-on" : us.reconnecting ? "st-warn" : "st-off";
    const statusLabel = us.loggedIn ? "Online" : us.reconnecting ? "Connecting" : "Offline";
    const displayName = session.username || us.botName || "User";
    const initials = displayName.slice(0,2).toUpperCase();

    const navItems = [
        {id:"dashboard",   label:"Dashboard",    icon:I.grid},
        {id:"account",     label:"Account Status",icon:I.user},
        {id:"tempmail",    label:"Temp Mail",    icon:I.mail},
        {id:"profileguard",label:"Profile Guard", icon:I.guardPic},
        {id:"about",       label:"About",         icon:I.info},
        ...(session.isAdmin ? [{id:"admin",label:"Admin Panel",icon:I.shield}] : []),
    ];
    const nav = navItems.map(n=>`
<div class="ni${mainTab===n.id?" act":""}" onclick="location='/?tab=${n.id}'" title="${n.label}">
  <span class="ico">${n.icon}</span><span class="lbl">${n.label}</span>
</div>`).join("");

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DUMMYL BOT</title>
<style>${CSS}</style>
</head><body>
<div id="cosmos"></div>
<div class="sb" id="sb">
  <div class="sb-top">
    <div class="sb-logo">${I.bot}</div>
    <div class="sb-brand">
      <div class="sb-name">DUMMYL BOT</div>
      <div class="sb-sub">AUTOMATION PLATFORM</div>
    </div>
  </div>
  <button class="sb-tog" onclick="toggleSb()">
    <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M15 18l-6-6 6-6"/></svg>
    <span class="tog-lbl">Collapse</span>
  </button>
  <nav class="sb-nav">${nav}</nav>
  <div class="sb-foot">
    <div class="u-pill">
      <div class="u-av">${initials}</div>
      <div class="u-info">
        <div class="u-name">${esc(displayName)}</div>
        <div class="u-role">${session.isAdmin?"Administrator":"Member"}</div>
      </div>
    </div>
    <form method="POST" action="/api/auth/logout">
      <button class="lo-btn" type="submit">${I.logout}<span class="lo-lbl">Sign Out</span></button>
    </form>
  </div>
</div>
<div class="mw" id="mw">
  <div class="topbar">
    <div class="tb-title">DUMMYL BOT <span>/ ${mainTab.charAt(0).toUpperCase()+mainTab.slice(1)}</span></div>
    <div class="tb-right">
      <div class="st-badge ${statusClass}"><span class="st-dot"></span>${statusLabel}</div>
      <div style="font-size:11px;color:var(--gray)">${esc(us.botName||"No bot")}</div>
    </div>
  </div>
  <div class="mc">${content}</div>
</div>
<script>
${COSMOS_JS}
var sb=document.getElementById('sb'),mw=document.getElementById('mw'),col=localStorage.getItem('sbCol')==='1';
function applyCol(){if(col){sb.classList.add('col');mw.classList.add('col');}else{sb.classList.remove('col');mw.classList.remove('col');}}
applyCol();
function toggleSb(){col=!col;localStorage.setItem('sbCol',col?'1':'0');applyCol();}
if(!sessionStorage.getItem('_vw')){sessionStorage.setItem('_vw','1');if('speechSynthesis' in window){var _vu=new SpeechSynthesisUtterance('Welcome to Facebook Dummy Bot');_vu.pitch=1.05;_vu.rate=0.88;_vu.volume=0.82;_vu.lang='en-US';setTimeout(function(){window.speechSynthesis.speak(_vu);},1000);}}
</script>
</body></html>`;
}

// ─── OVERVIEW ─────────────────────────────────────────────────────────────────
function buildOverviewContent(uid) {
    const us  = getUserState(uid);
    const acct= getAccountInfo(uid);
    const statusClass = us.loggedIn?"p-on":us.reconnecting?"p-warn":"p-off";
    const statusLabel = us.loggedIn?"Online":us.reconnecting?"Connecting":"Offline";
    const loopCount   = Object.values(us.loopEnabled||{}).filter(Boolean).length;
    const autoCount   = Object.values(us.autoRespondEnabled||{}).filter(Boolean).length;
    const cfg = readBotConfig(uid);
    const customReplies = readCustomReplies(uid);
    const uploads = getUploads(uid);
    const totalMsgs = cfg.useBuiltinReplies!==false ? replies.length + customReplies.length : customReplies.length;
    const logs = us.logs||[];

    const logsHtml = logs.length ? logs.map(l=>`
<div class="lr lr-${l.type||"info"}">
  <span class="lt">${esc(l.time||"")}</span>
  <span class="ll">${(l.type||"INFO").toUpperCase()}</span>
  <span class="lm">${esc((l.message||"").slice(0,120))}</span>
</div>`).join("") : `<div style="padding:22px;text-align:center;color:var(--gray2);font-size:12px">No logs yet</div>`;

    return `
<div class="hero">
  <div class="hero-in">
    <div class="hero-l">
      <div class="hero-ic">${I.bot}</div>
      <div>
        <div class="hero-title">DUMMYL BOT <span class="hero-ver">v2.4</span></div>
        <div class="hero-desc">${esc(acct.name||us.botName||"Awaiting login")} ${acct.uid?`· ID: ${esc(acct.uid)}`:""}
        </div>
        <div class="hero-pills">
          <span class="pill ${statusClass}"><i></i>${statusLabel}</span>
          ${loopCount?`<span class="pill p-on"><i></i>${loopCount} Loop${loopCount>1?"s":""} Active</span>`:""}
          ${autoCount?`<span class="pill p-warn"><i></i>${autoCount} Auto-Respond</span>`:""}
          <span class="pill p-off">Uptime: ${getUptime(uid)}</span>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="sg">
  <div class="sc"><div class="sc-glow gc-r"></div><div class="sc-ico ci-r">${I.msg}</div><div class="sc-val">${us.totalRepliesSent}</div><div class="sc-lbl">Messages Sent</div></div>
  <div class="sc"><div class="sc-glow gc-w"></div><div class="sc-ico ci-w"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></div><div class="sc-val">${loopCount}</div><div class="sc-lbl">Active Loops</div></div>
  <div class="sc"><div class="sc-glow gc-g"></div><div class="sc-ico ci-g">${I.image}</div><div class="sc-val">${uploads.length}</div><div class="sc-lbl">Photos Uploaded</div></div>
  <div class="sc"><div class="sc-glow gc-o"></div><div class="sc-ico ci-o">${I.msg}</div><div class="sc-val">${totalMsgs}</div><div class="sc-lbl">Message Pool</div></div>
</div>
<div class="box">
  <div class="bh"><span class="chip chip-b">HOURLY</span><span class="bt">Messages Sent (24h)</span></div>
  <div style="padding:16px 20px">
    <canvas id="hchart" style="width:100%;height:90px;display:block;"></canvas>
  </div>
</div>
<div class="box">
  <div class="bh"><span class="chip">LOG</span><span class="bt">Live Console</span><span class="bm">${logs.length} entries</span></div>
  <div class="la">${logsHtml}</div>
</div>
<script>
(function(){
  var cv=document.getElementById('hchart');
  if(!cv)return;
  fetch('/api/hourly-stats').then(r=>r.json()).then(data=>{
    cv.width=cv.offsetWidth*window.devicePixelRatio||cv.offsetWidth;
    cv.height=90*window.devicePixelRatio||90;
    cv.style.width='100%';cv.style.height='90px';
    var cx=cv.getContext('2d');
    var max=Math.max.apply(null,data.concat([1]));
    var w=cv.width/24;
    data.forEach(function(v,i){
      var h=(v/max)*(cv.height-10)+2;
      var grd=cx.createLinearGradient(0,cv.height-h,0,cv.height);
      grd.addColorStop(0,'rgba(124,58,237,0.85)');
      grd.addColorStop(1,'rgba(76,29,149,0.20)');
      cx.fillStyle=grd;
      cx.beginPath();cx.roundRect(i*w+2,cv.height-h,w-4,h,2);cx.fill();
    });
  }).catch(function(){});
})();
</script>`;
}

// ─── MESSAGES / LOOP QUEUE ────────────────────────────────────────────────────
function buildMessagesContent(uid) {
    const cfg = readBotConfig(uid);
    const customReplies = readCustomReplies(uid);
    const uploads = getUploads(uid);
    const useBuiltin = cfg.useBuiltinReplies !== false;

    const photoGrid = uploads.length
        ? uploads.map((f,i) => `
<div class="photo-item">
  <img class="photo-thumb" src="/uploads?file=${encodeURIComponent(f)}" loading="lazy" onerror="this.parentElement.style.display='none'">
  <div class="photo-overlay">
    <form method="POST" action="/api/images/file-remove" style="margin:0">
      <input type="hidden" name="filename" value="${esc(f)}">
      <button class="photo-rm-btn" type="submit" title="Remove">×</button>
    </form>
  </div>
</div>`).join("")
        : `<div class="photo-empty">No photos uploaded yet.</div>`;

    const customList = customReplies.length
        ? customReplies.map((r,i) => `
<div class="msg-row">
  <span class="msg-txt">${esc(r)}</span>
  <form method="POST" action="/api/replies/remove" style="margin:0">
    <input type="hidden" name="index" value="${i}">
    <input type="hidden" name="redirect" value="messages">
    <button class="btn-rm" type="submit" title="Remove">×</button>
  </form>
</div>`).join("")
        : `<div style="padding:18px;text-align:center;color:var(--gray2);font-size:12px">No custom messages yet.</div>`;

    const builtinPreview = replies.slice(0,30).map(r=>`<div class="prebuilt-row">${esc(r)}</div>`).join("") +
        (replies.length>30 ? `<div class="prebuilt-row" style="color:var(--gray);font-style:italic">... and ${replies.length-30} more</div>` : "");

    return `
<div class="shd">${I.image} Photo Pool</div>
<div class="box">
  <div class="bh"><span class="chip chip-p">PHOTOS</span><span class="bt">Loop &amp; Auto-Respond Photos</span><span class="bm">${uploads.length} photo${uploads.length!==1?"s":""}</span></div>
  <div class="add-row">
    <label class="upload-btn-label" for="photo-file-input">${I.upload} Upload Photo<input type="file" id="photo-file-input" accept="image/*" style="display:none" onchange="handlePhotoUpload(this)"></label>
    <span style="font-size:11px;color:var(--gray2)">Max 5MB · JPG, PNG, GIF, WebP</span>
    <span id="upload-status" style="font-size:11px;color:var(--ok);margin-left:auto;display:none">Uploading...</span>
  </div>
  <div class="photo-grid">${photoGrid}</div>
</div>
<div class="shd">${I.msg} Messages</div>
<div class="box">
  <div class="bh"><span class="chip">POOL</span><span class="bt">Loop &amp; Auto-Respond Messages</span><span class="bm">${(useBuiltin?replies.length:0)+customReplies.length} total</span></div>
  <div style="padding:12px 16px;border-bottom:1px solid var(--border);">
    <form method="POST" action="/api/config/toggle-prebuilt" style="margin:0">
      <label class="tr-row" style="padding:4px 0">
        <input type="checkbox" class="tck" ${useBuiltin?"checked":""} onchange="this.form.submit()">
        <span class="ttr"><span class="tth"></span></span>
        <span>Include pre-made messages <span style="color:var(--gray2)">(${replies.length} messages)</span></span>
      </label>
    </form>
  </div>
  <div class="add-row">
    <form method="POST" action="/api/replies/add" style="display:flex;gap:10px;width:100%;margin:0">
      <input type="hidden" name="redirect" value="messages">
      <input class="ai" name="word" placeholder="Add custom message..." required>
      <button class="btn-a" type="submit">Add</button>
    </form>
  </div>
  ${customList}
</div>
<details class="box">
  <summary class="bh" style="cursor:pointer;user-select:none">
    <span class="chip chip-b">BUILT-IN</span><span class="bt">Pre-made Messages</span><span class="bm">${replies.length} messages</span>
    <svg width="14" height="14" fill="none" stroke="var(--gray)" stroke-width="2" viewBox="0 0 24 24" style="margin-left:8px"><polyline points="6 9 12 15 18 9"/></svg>
  </summary>
  <div style="max-height:220px;overflow-y:auto;">${builtinPreview}</div>
</details>
<script>
function handlePhotoUpload(input){
  var file=input.files[0];if(!file)return;
  if(file.size>5*1024*1024){alert('Max file size is 5MB');input.value='';return;}
  var st=document.getElementById('upload-status');if(st)st.style.display='';
  var reader=new FileReader();
  reader.onload=function(e){
    fetch('/api/images/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({imageData:e.target.result,imageName:file.name})})
    .then(function(){window.location.href='/?tab=dashboard&itab=messages';}).catch(function(){if(st)st.textContent='Upload failed';});
  };
  reader.readAsDataURL(file);
}
</script>`;
}

// ─── THREADS ──────────────────────────────────────────────────────────────────
function buildThreadsContent(uid) {
    const us  = getUserState(uid);
    const wl  = readWhitelist(uid);
    const tc  = readThreadConfig(uid);
    const activeLoops = Object.entries(us.loopEnabled||{}).filter(([,v])=>v).map(([k])=>k);
    const autoThreads = Object.entries(us.autoRespondEnabled||{}).filter(([,v])=>v).map(([k])=>k);
    const threadRows = [...new Set([...activeLoops,...autoThreads,...Object.keys(tc)])].map(tid=>`
<tr>
  <td class="td-m">${esc(tid)}</td>
  <td>${us.loopEnabled?.[tid]?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-d">OFF</span>`}</td>
  <td>${us.autoRespondEnabled?.[tid]?`<span class="tag tag-g">ON</span>`:`<span class="tag tag-d">OFF</span>`}</td>
  <td><div style="display:flex;gap:5px;flex-wrap:wrap">
    ${!us.loopEnabled?.[tid]?`<form method="POST" action="/api/thread/startloop" style="margin:0"><input type="hidden" name="threadID" value="${esc(tid)}"><button class="btn btn-sm btn-r" style="font-size:11px;padding:4px 10px">Start Loop</button></form>`:`<form method="POST" action="/api/thread/stoploop" style="margin:0"><input type="hidden" name="threadID" value="${esc(tid)}"><button class="btn btn-sm btn-danger" style="font-size:11px;padding:4px 10px">Stop Loop</button></form>`}
  </div></td>
</tr>`).join("");
    const wlRows = wl.uids.map(u=>`<tr><td class="td-m">${esc(u)}</td><td><form method="POST" action="/api/whitelist/remove" style="margin:0"><input type="hidden" name="uid" value="${esc(u)}"><button class="btn btn-danger btn-xs">Remove</button></form></td></tr>`).join("");
    return `
<div class="box">
  <div class="bh"><span class="chip chip-g">LIVE</span><span class="bt">Thread Registry</span><span class="bm">${activeLoops.length} loops active</span></div>
  <table><thead><tr><th>Thread ID</th><th>Loop</th><th>Auto-Respond</th><th>Controls</th></tr></thead>
  <tbody>${threadRows||`<tr><td colspan="4" class="td-e">No active threads</td></tr>`}</tbody></table>
</div>
<div style="display:flex;gap:12px;margin-bottom:16px">
  <form method="POST" action="/api/thread/stopall" style="margin:0"><button class="btn btn-danger">Stop All Loops</button></form>
</div>
<div class="box">
  <div class="bh"><span class="chip ${wl.enabled?"chip-g":"chip-y"}">${wl.enabled?"ENABLED":"DISABLED"}</span><span class="bt">Whitelist</span>
    <form method="POST" action="/api/whitelist/toggle" style="margin:0;margin-left:auto"><button class="btn btn-sm btn-o">${wl.enabled?"Disable":"Enable"} Whitelist</button></form>
  </div>
  <div class="add-row">
    <form method="POST" action="/api/whitelist/add" style="display:flex;gap:10px;width:100%;margin:0">
      <input class="ai" name="uid" placeholder="Add Facebook UID..."><button class="btn-a" type="submit">Add</button>
    </form>
  </div>
  <table><thead><tr><th>User ID</th><th>Action</th></tr></thead>
  <tbody>${wlRows||`<tr><td colspan="2" class="td-e">Whitelist is empty</td></tr>`}</tbody></table>
</div>`;
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
function buildConfigContent(uid) {
    const cfg = readBotConfig(uid);
    const hasBanner = hasBannerUpload(uid);
    const b=(k)=>cfg[k]?'checked':'';
    return `
<div class="shd">${I.image} Banner Photo</div>
<div class="box">
  <div class="bh"><span class="chip chip-p">BANNER</span><span class="bt">!banner Command Photo</span><span class="bm">1 slot</span></div>
  <div style="padding:18px 20px">
    ${hasBanner?`<img class="banner-preview" src="/banner?t=${Date.now()}" alt="Current banner">`:`<div class="banner-empty-prev">No banner uploaded — !banner will use default URL</div>`}
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">
      <label class="upload-btn-label" for="banner-file-input">${I.upload} ${hasBanner?"Change Banner":"Upload Banner"}<input type="file" id="banner-file-input" accept="image/*" style="display:none" onchange="handleBannerUpload(this)"></label>
      ${hasBanner?`<form method="POST" action="/api/banner/remove" style="margin:0"><button class="btn btn-danger btn-sm">Remove Banner</button></form>`:""}
    </div>
    <div class="fhint" style="margin-top:8px">Upload a photo and type <code style="color:var(--red3);font-size:11px">!banner</code> (no URL) to use this image as the group banner.</div>
  </div>
</div>
<div class="shd">${I.config} Bot Configuration</div>
<form method="POST" action="/api/config/save">
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
<div>
  <div class="box" style="padding:18px 20px">
    <div class="bt" style="margin-bottom:14px">Loop Settings</div>
    <div class="fld"><label class="flbl">Loop Reaction Emoji</label><input class="fi" name="loopReact" value="${esc(cfg.loopReact||'😆')}"></div>
    <div class="fld"><label class="flbl">Loop Delay (seconds)</label><input class="fi" type="number" step="0.1" min="0.5" name="loopDelay" value="${cfg.loopDelay||1}"></div>
    <div class="fld"><label class="flbl">Image Probability (%)</label><input class="fi" type="number" min="0" max="100" name="imageProbability" value="${cfg.imageProbability||20}"></div>
    <div class="fld"><label class="flbl">Loop Mode</label><select class="fs" name="loopMode"><option value="sequential" ${cfg.loopMode==="sequential"?"selected":""}>Sequential</option><option value="shuffle" ${cfg.loopMode==="shuffle"?"selected":""}>Shuffle</option></select></div>
    <div class="fld"><label class="flbl">Max Loop Count (0=unlimited)</label><input class="fi" type="number" min="0" name="maxLoopCount" value="${cfg.maxLoopCount||0}"></div>
    <div class="fld"><label class="flbl">Auto Stop (minutes, 0=off)</label><input class="fi" type="number" min="0" name="autoStopMinutes" value="${cfg.autoStopMinutes||0}"></div>
    <div class="fld"><label class="flbl">Loop Start Message</label><input class="fi" name="loopStartMsg" value="${esc(cfg.loopStartMsg||'')}"></div>
    <div class="fld"><label class="flbl">Loop Stop Message</label><input class="fi" name="loopStopMsg" value="${esc(cfg.loopStopMsg||'')}"></div>
  </div>
</div>
<div>
  <div class="box" style="padding:18px 20px">
    <div class="bt" style="margin-bottom:14px">Features</div>
    <label class="tr-row"><input type="checkbox" class="tck" name="reactOnlyMode" ${b('reactOnlyMode')}><span class="ttr"><span class="tth"></span></span>React Only Mode (no text)</label>
    <label class="tr-row"><input type="checkbox" class="tck" name="loopSilentMode" ${b('loopSilentMode')}><span class="ttr"><span class="tth"></span></span>Loop Silent Mode</label>
    <label class="tr-row"><input type="checkbox" class="tck" name="silentMode" ${b('silentMode')}><span class="ttr"><span class="tth"></span></span>Auto-Respond Silent</label>
    <label class="tr-row"><input type="checkbox" class="tck" name="autoSeenEnabled" ${b('autoSeenEnabled')}><span class="ttr"><span class="tth"></span></span>Auto Mark Seen</label>
    <label class="tr-row"><input type="checkbox" class="tck" name="typingSimulate" ${b('typingSimulate')}><span class="ttr"><span class="tth"></span></span>Simulate Typing</label>
    <label class="tr-row"><input type="checkbox" class="tck" name="greetNewMembers" ${b('greetNewMembers')}><span class="ttr"><span class="tth"></span></span>Greet New Members</label>
    <div class="fld" style="margin-top:10px"><label class="flbl">Greet Message</label><input class="fi" name="greetMsg" value="${esc(cfg.greetMsg||'')}"></div>
    <div class="fld"><label class="flbl">TTS Language</label><select class="fs" name="ttsLang"><option value="tl" ${cfg.ttsLang==="tl"?"selected":""}>Filipino (tl)</option><option value="en" ${cfg.ttsLang==="en"?"selected":""}>English (en)</option><option value="ja" ${cfg.ttsLang==="ja"?"selected":""}>Japanese (ja)</option><option value="ko" ${cfg.ttsLang==="ko"?"selected":""}>Korean (ko)</option><option value="zh" ${cfg.ttsLang==="zh"?"selected":""}>Chinese (zh)</option></select></div>
    <label class="tr-row"><input type="checkbox" class="tck" name="autoReactEnabled" ${b('autoReactEnabled')}><span class="ttr"><span class="tth"></span></span>Auto React to Messages</label>
    <div class="fld" style="margin-top:10px"><label class="flbl">Auto React Emoji</label><input class="fi" name="autoReactEmoji" value="${esc(cfg.autoReactEmoji||'😆')}"></div>
  </div>
  <div class="box" style="padding:18px 20px">
    <div class="bt" style="margin-bottom:14px">Anti-Spam</div>
    <label class="tr-row"><input type="checkbox" class="tck" name="antiSpamEnabled" ${b('antiSpamEnabled')}><span class="ttr"><span class="tth"></span></span>Enable Anti-Spam</label>
    <div class="fld" style="margin-top:10px"><label class="flbl">Max Messages</label><input class="fi" type="number" min="1" name="antiSpamMaxMsg" value="${cfg.antiSpamMaxMsg||5}"></div>
    <div class="fld"><label class="flbl">Window (seconds)</label><input class="fi" type="number" min="1" name="antiSpamWindowSec" value="${cfg.antiSpamWindowSec||10}"></div>
  </div>
  <div class="box" style="padding:18px 20px">
    <div class="bt" style="margin-bottom:6px">Mass Comment Sender <span class="chip chip-g" style="margin-left:6px">fca-riyad</span></div>
    <div class="fhint" style="margin-bottom:12px">Anti-detection: randomized delays, text rotation. Uses <code style="color:var(--red3);font-size:11px">postComment</code> / <code style="color:var(--red3);font-size:11px">reactToComment</code>. Run with <code style="color:var(--red3);font-size:11px">!mcomment</code>.</div>
    <label class="tr-row"><input type="checkbox" class="tck" name="massCommentEnabled" ${b('massCommentEnabled')}><span class="ttr"><span class="tth"></span></span>Enable in Config (allow !mcomment)</label>
    <div class="fld" style="margin-top:10px"><label class="flbl">Post IDs (one per line or space-separated)</label><textarea class="fi" name="massCommentPostIDs" rows="3" style="resize:vertical;font-family:var(--mono);font-size:12px">${esc(cfg.massCommentPostIDs||'')}</textarea></div>
    <div class="fld"><label class="flbl">Comment Texts (one per line — rotates per post)</label><textarea class="fi" name="massCommentTexts" rows="4" style="resize:vertical">${esc(cfg.massCommentTexts||'Nice post!\nGreat content!\nAwesome! 🔥')}</textarea></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div class="fld"><label class="flbl">Min Delay (sec)</label><input class="fi" type="number" min="5" name="massCommentDelayMin" value="${cfg.massCommentDelayMin!=null?cfg.massCommentDelayMin:15}"></div>
      <div class="fld"><label class="flbl">Max Delay (sec)</label><input class="fi" type="number" min="5" name="massCommentDelayMax" value="${cfg.massCommentDelayMax!=null?cfg.massCommentDelayMax:45}"></div>
    </div>
    <label class="tr-row"><input type="checkbox" class="tck" name="massCommentReact" ${b('massCommentReact')}><span class="ttr"><span class="tth"></span></span>React to post after commenting</label>
    <div class="fld" style="margin-top:8px"><label class="flbl">Reaction</label><select class="fs" name="massCommentReaction"><option value="like" ${cfg.massCommentReaction==="like"?"selected":""}>👍 Like</option><option value="love" ${cfg.massCommentReaction==="love"?"selected":""}>❤️ Love</option><option value="haha" ${cfg.massCommentReaction==="haha"?"selected":""}>😂 Haha</option><option value="wow" ${cfg.massCommentReaction==="wow"?"selected":""}>😮 Wow</option><option value="sad" ${cfg.massCommentReaction==="sad"?"selected":""}>😢 Sad</option><option value="angry" ${cfg.massCommentReaction==="angry"?"selected":""}>😡 Angry</option></select></div>
  </div>
</div>
</div>
<button class="btn btn-r" type="submit">Save Configuration</button>
</form>
<script>
function handleBannerUpload(input){
  var file=input.files[0];if(!file)return;
  if(file.size>5*1024*1024){alert('Max file size is 5MB');input.value='';return;}
  var reader=new FileReader();
  reader.onload=function(e){
    fetch('/api/banner/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({bannerData:e.target.result})})
    .then(function(){window.location.href='/?tab=dashboard&itab=config';});
  };
  reader.readAsDataURL(file);
}
</script>`;
}

// ─── COOKIE ───────────────────────────────────────────────────────────────────
function buildCookieContent(uid) {
    const slots = getFbstateFiles(uid);
    const slotOpts = ["fbstate.json","fbstate2.json","fbstate3.json"].map(s=>`<option value="${s}" ${slots.includes(s)?'style="color:#22c55e"':""} >${s}${slots.includes(s)?" ✓":""}</option>`).join("");
    return `
<div class="box">
  <div class="bh"><span class="chip chip-g">ACTIVE</span><span class="bt">Cookie Slots</span><span class="bm">${slots.length} connected</span></div>
  <table><thead><tr><th>Slot</th><th>Status</th></tr></thead><tbody>
    ${["fbstate.json","fbstate2.json","fbstate3.json"].map(s=>`<tr><td class="td-m">${s}</td><td>${slots.includes(s)?`<span class="tag tag-g">Connected</span>`:`<span class="tag tag-d">Empty</span>`}</td></tr>`).join("")}
  </tbody></table>
</div>
<div class="box">
  <div class="bh"><span class="chip">SETUP</span><span class="bt">Paste Cookie</span></div>
  <div style="padding:20px">
    <form method="POST" action="/api/cookie/slot">
      <div class="fld"><label class="flbl">Cookie Slot</label><select class="fs" name="slot">${slotOpts}</select></div>
      <div class="fld"><label class="flbl">fbstate.json Content</label><textarea class="ck-ta" name="cookie" rows="6" placeholder='[{"key":"c_user","value":"100xxx","domain":".facebook.com",...},...]' required></textarea></div>
      <button class="btn btn-r" type="submit">Connect Bot</button>
    </form>
  </div>
</div>
<div class="box" style="padding:18px 20px">
  <div class="bt" style="margin-bottom:14px">How to get your cookie</div>
  <div class="steps-g">
    <div class="step"><div class="snum">1</div><div class="stxt">Install <b>c3c-ufc-utility</b> extension on Chrome</div></div>
    <div class="step"><div class="snum">2</div><div class="stxt">Log in to <b>facebook.com</b> in your browser</div></div>
    <div class="step"><div class="snum">3</div><div class="stxt">Click extension → <b>Export as JSON</b></div></div>
    <div class="step"><div class="snum">4</div><div class="stxt">Paste the JSON above and click Connect Bot</div></div>
  </div>
</div>`;
}

// ─── CUSTOM COMMANDS ──────────────────────────────────────────────────────────
function buildCustomCmdsContent(uid) {
    const cmds = readCustomCommands(uid);
    const rows = cmds.map((c,i)=>`<tr><td class="td-m">${esc(c.cmd||"")}</td><td style="color:var(--off)">${esc(c.reply||"")}</td><td><form method="POST" action="/api/cmds/remove" style="margin:0"><input type="hidden" name="index" value="${i}"><button class="btn btn-danger btn-xs">Remove</button></form></td></tr>`).join("");
    return `
<div class="box">
  <div class="bh"><span class="chip">CUSTOM</span><span class="bt">Custom Commands</span><span class="bm">${cmds.length} commands</span></div>
  <div class="add-row" style="flex-direction:column;align-items:stretch;gap:10px">
    <form method="POST" action="/api/cmds/add" style="display:grid;grid-template-columns:1fr 2fr auto;gap:10px;margin:0">
      <input class="ai" name="cmd" placeholder="!command">
      <input class="ai" name="reply" placeholder="Bot reply...">
      <button class="btn-a" type="submit">Add</button>
    </form>
  </div>
  <table><thead><tr><th>Command</th><th>Reply</th><th>Action</th></tr></thead>
  <tbody>${rows||`<tr><td colspan="3" class="td-e">No custom commands yet</td></tr>`}</tbody></table>
</div>`;
}

// ─── COMMANDS REFERENCE ───────────────────────────────────────────────────────
function buildCommandsContent(uid) {
    const sections = [
        {title:"Loop",color:"var(--red2)",cmds:[{n:".",d:"Toggle loop on/off in any chat"},{n:". <uid/name>",d:"Toggle PM loop with a user"},{n:"!stop",d:"Stop loop in current thread"},{n:"!looppm <uid>",d:"Start PM loop with UID"},{n:"!stoppm <uid>",d:"Stop PM loop with UID"},{n:"!schedule <sec> <msg>",d:"Send message after delay"}]},
        {title:"Auto-Respond",color:"#f59e0b",cmds:[{n:"!on",d:"Enable auto-respond in group"},{n:"!off",d:"Disable auto-respond"},{n:"!mute",d:"Mute auto-respond (keep enabled)"},{n:"!unmute",d:"Unmute auto-respond"},{n:"!broadcast <msg>",d:"Send to all auto-respond threads"}]},
        {title:"Group Tools",color:"#60a5fa",cmds:[{n:"!nn <name>",d:"Set nickname for all members"},{n:"!nn1 <uid> <name>",d:"Set nickname for one member"},{n:"!clearnn",d:"Clear all nicknames"},{n:"!cg <name>",d:"Lock group name"},{n:"!uncg",d:"Unlock group name"},{n:"!banner [url]",d:"Set &amp; lock group banner"},{n:"!unbanner",d:"Unlock banner"},{n:"!kick <uid>",d:"Remove member from group"},{n:"!add <uid>",d:"Add member to group"},{n:"!promote <uid>",d:"Promote to admin"},{n:"!demote <uid>",d:"Remove admin"},{n:"!emoji <emoji>",d:"Change thread emoji"},{n:"!color <name>",d:"Change thread color"},{n:"!freeze",d:"Freeze group"},{n:"!unfreeze",d:"Unfreeze group"},{n:"!gmute <uid>",d:"Mute a specific member"},{n:"!gunmute <uid>",d:"Unmute a member"},{n:"!perms <uid> <time>",d:"Give temp command access"},{n:"!revoke [uid]",d:"Revoke temp permissions"},{n:"!forward <tid> <msg>",d:"Forward message to thread"},{n:"!lock",d:"Show lock status"},{n:"!members",d:"List group members"},{n:"!antirestrict",d:"Toggle anti-restrict mode"}]},
        {title:"Voice & Music",color:"#c084fc",cmds:[{n:"!vm <text>",d:"Send TTS as chipmunk voice"},{n:"!vmpm <uid> <text>",d:"Send TTS to a PM"},{n:"!p <song>",d:"Search YouTube and send audio"},{n:"!p <youtube url>",d:"Send YouTube audio directly"}]},
        {title:"Tools",color:"var(--ok)",cmds:[{n:"!say <text>",d:"Send a message"},{n:"!spam <n> <text>",d:"Send message n times"},{n:"!count",d:"Count from 1 to 20"},{n:"!react <emoji>",d:"React to replied message"},{n:"!seen",d:"Mark thread as read"},{n:"!id",d:"Get sender ID of replied message"},{n:"!myid",d:"Get your own ID"},{n:"!info",d:"Get thread info"},{n:"!status",d:"Bot status in thread"},{n:"!test",d:"Ping the bot"},{n:"!gp [url/off]",d:"Lock profile picture"}]},
        {title:"Fun",color:"#fb923c",cmds:[{n:"!flip",d:"Flip a coin"},{n:"!roll [n]",d:"Roll dice (default d6)"},{n:"!8ball <question>",d:"Ask the magic 8-ball"},{n:"!pick a|b|c",d:"Pick a random option"},{n:"!reverse <text>",d:"Reverse text"},{n:"!shout <text>",d:"Shout text with spaces"},{n:"!mock <text>",d:"mOcK tExT"},{n:"!clap <text>",d:"Add claps between words"},{n:"!timer <sec>",d:"Set a countdown timer"},{n:"!repeat <n> <text>",d:"Repeat text n times"}]},
    ];
    return `
<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px">
${sections.map(s=>`
<div class="box" style="margin-bottom:0">
  <div class="bh"><span class="chip" style="color:${s.color};border-color:${s.color}40;background:${s.color}18">${s.title.toUpperCase()}</span><span class="bt">${s.title}</span></div>
  <div class="cmd-section" style="padding:12px 16px">
    <div class="cmd-grid">${s.cmds.map(c=>`<div class="cmd-item"><div class="cmd-name">${c.n}</div><div class="cmd-desc">${c.d}</div></div>`).join("")}</div>
  </div>
</div>`).join("")}
</div>`;
}

// ─── TEMP MAIL ────────────────────────────────────────────────────────────────
function buildTempMailContent(uid) {
    return `
<style>
.tm-grid{display:grid;grid-template-columns:380px 1fr;gap:18px;align-items:start;}
@media(max-width:900px){.tm-grid{grid-template-columns:1fr;}}
.tm-addr-wrap{position:relative;background:rgba(220,38,38,0.06);border:1px solid rgba(220,38,38,0.22);border-radius:12px;padding:16px 18px;margin:14px 0;}
.tm-addr{font-family:'Courier New',monospace;font-size:16px;font-weight:700;color:var(--red3);letter-spacing:.04em;word-break:break-all;line-height:1.4;}
.tm-addr-ph{font-size:13px;color:var(--gray2);font-style:italic;}
.tm-copy-btn{position:absolute;top:12px;right:12px;background:rgba(220,38,38,0.14);border:1px solid rgba(220,38,38,0.28);color:var(--red2);border-radius:8px;padding:5px 10px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .2s;display:flex;align-items:center;gap:5px;}
.tm-copy-btn:hover{background:rgba(220,38,38,0.25);box-shadow:0 0 12px rgba(220,38,38,0.3);}
.tm-copy-btn.ok{color:#22c55e;border-color:rgba(34,197,94,.3);background:rgba(34,197,94,.08);}
.tm-gen-btn{width:100%;padding:12px;background:linear-gradient(135deg,var(--red),var(--red-dim));border:none;color:#fff;border-radius:11px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:all .22s;box-shadow:0 4px 22px rgba(220,38,38,0.3);display:flex;align-items:center;justify-content:center;gap:8px;}
.tm-gen-btn:hover{box-shadow:0 4px 36px rgba(220,38,38,0.55);transform:translateY(-1px);}
.tm-gen-btn:disabled{opacity:.55;cursor:not-allowed;transform:none;}
.tm-stat-row{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap;}
.tm-stat{font-size:11px;padding:3px 10px;border-radius:20px;font-weight:600;}
.tm-stat-ok{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.22);}
.tm-stat-warn{background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.22);}
.tm-stat-err{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.22);}
.tm-stat-gray{background:rgba(139,119,176,.08);color:var(--gray);border:1px solid var(--border);}
.tm-panel-head{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--border);}
.tm-panel-title{font-size:13px;font-weight:700;color:var(--white);}
.tm-refresh-btn{background:none;border:1px solid var(--border2);color:var(--gray);border-radius:8px;padding:5px 11px;font-size:11px;font-weight:600;cursor:pointer;font-family:inherit;transition:all .2s;display:flex;align-items:center;gap:6px;}
.tm-refresh-btn:hover{border-color:var(--red2);color:var(--red3);box-shadow:0 0 10px rgba(220,38,38,0.2);}
.tm-refresh-btn:disabled{opacity:.45;cursor:not-allowed;}
.tm-inbox{max-height:420px;overflow-y:auto;}
.tm-inbox-item{padding:13px 18px;border-bottom:1px solid rgba(220,38,38,0.05);cursor:pointer;transition:background .15s;position:relative;}
.tm-inbox-item:hover{background:rgba(220,38,38,0.04);}
.tm-inbox-item.unread::before{content:'';position:absolute;left:6px;top:50%;transform:translateY(-50%);width:5px;height:5px;border-radius:50%;background:var(--red2);box-shadow:0 0 6px var(--red);}
.tm-inbox-from{font-size:12px;font-weight:700;color:var(--off);margin-bottom:2px;}
.tm-inbox-subj{font-size:13px;color:var(--white);font-weight:500;margin-bottom:3px;}
.tm-inbox-date{font-size:10.5px;color:var(--gray2);}
.tm-inbox-empty{padding:40px 20px;text-align:center;color:var(--gray2);}
.tm-inbox-empty-ico{font-size:32px;margin-bottom:10px;opacity:.4;}
.tm-inbox-empty-txt{font-size:12.5px;}
.tm-inbox-empty-sub{font-size:11px;color:var(--gray2);margin-top:4px;opacity:.7;}
.tm-msg-view{background:var(--card);border:1px solid var(--border);border-radius:14px;margin-top:18px;overflow:hidden;animation:fadeUp .25s ease;}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px);}to{opacity:1;transform:translateY(0);}}
.tm-msg-head{padding:14px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;background:rgba(220,38,38,0.04);}
.tm-msg-subj{font-size:13.5px;font-weight:700;color:var(--white);flex:1;}
.tm-msg-close{background:none;border:1px solid var(--border2);color:var(--gray);border-radius:8px;padding:5px 11px;font-size:11px;cursor:pointer;font-family:inherit;transition:all .2s;}
.tm-msg-close:hover{border-color:var(--red2);color:var(--red3);}
.tm-msg-from{font-size:11px;color:var(--gray);padding:10px 20px;border-bottom:1px solid var(--border);background:rgba(0,0,0,0.2);}
.tm-msg-body{padding:18px 20px;font-size:12.5px;color:var(--off);white-space:pre-wrap;line-height:1.7;max-height:340px;overflow-y:auto;font-family:'Courier New',monospace;}
.tm-auto-row{display:flex;align-items:center;gap:8px;padding:10px 18px;border-top:1px solid var(--border);background:rgba(0,0,0,0.15);}
.tm-countdown{font-size:11px;color:var(--gray2);margin-left:auto;}
.tm-spin{display:inline-block;width:13px;height:13px;border:2px solid rgba(220,38,38,0.2);border-top:2px solid var(--red);border-radius:50%;animation:spin .7s linear infinite;vertical-align:middle;margin-right:4px;}
</style>

<div class="hero">
  <div class="hero-in">
    <div class="hero-l">
      <div class="hero-ic">${I.mail}</div>
      <div>
        <div class="hero-title">Temp Mail <span class="hero-ver">BUILT-IN</span></div>
        <div class="hero-desc">Disposable email addresses powered by our own API endpoint. No sign-up, no tracking.</div>
      </div>
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <div class="pill p-on"><i></i> API Active</div>
      <div class="pill p-warn"><i></i> Ephemeral</div>
    </div>
  </div>
</div>

<div class="tm-grid">
  <!-- Left: Generate -->
  <div>
    <div class="box">
      <div class="bh"><span class="chip chip-g">GENERATE</span><span class="bt">New Temp Email</span></div>
      <div style="padding:18px 20px">
        <div style="font-size:11.5px;color:var(--gray);margin-bottom:12px;line-height:1.6;">Click generate to create a fresh disposable address. Emails arrive in seconds.</div>
        <div class="tm-addr-wrap">
          <div id="tmAddr" class="tm-addr-ph">No address yet</div>
          <button class="tm-copy-btn" id="tmCopyBtn" onclick="copyTmEmail()" style="display:none">
            <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
            Copy
          </button>
        </div>
        <button class="tm-gen-btn" id="tmGenBtn" onclick="generateTmEmail()">
          <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          Generate Email
        </button>
        <div class="tm-stat-row" id="tmStatRow" style="display:none!important"></div>
      </div>
    </div>

    <div class="box" style="margin-top:0">
      <div class="bh"><span class="chip">INFO</span><span class="bt">How It Works</span></div>
      <div style="padding:14px 20px;display:flex;flex-direction:column;gap:10px">
        ${[
          ["1","Generate","Click Generate to get a fresh disposable address from 1secmail.com."],
          ["2","Use It","Paste your temp email anywhere you need to register."],
          ["3","Receive","Emails appear in your inbox within seconds."],
          ["4","Read","Click any email to read its full content."],
        ].map(([n,t,d])=>`
        <div style="display:flex;gap:12px;align-items:flex-start">
          <div style="width:22px;height:22px;border-radius:6px;background:rgba(220,38,38,0.15);border:1px solid rgba(220,38,38,0.28);color:var(--red2);font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0">${n}</div>
          <div><div style="font-size:12px;font-weight:700;color:var(--off)">${t}</div><div style="font-size:11px;color:var(--gray);margin-top:2px">${d}</div></div>
        </div>`).join("")}
      </div>
    </div>
  </div>

  <!-- Right: Inbox -->
  <div class="box" style="overflow:hidden">
    <div class="tm-panel-head">
      <span class="tm-panel-title">${I.mail} Inbox</span>
      <div style="display:flex;align-items:center;gap:8px">
        <span id="tmInboxCount" class="tm-stat tm-stat-gray">0 messages</span>
        <button class="tm-refresh-btn" id="tmRefreshBtn" onclick="refreshTmInbox()">
          ${I.refresh} Refresh
        </button>
      </div>
    </div>
    <div class="tm-inbox" id="tmInboxList">
      <div class="tm-inbox-empty">
        <div class="tm-inbox-empty-ico">📭</div>
        <div class="tm-inbox-empty-txt">No inbox yet</div>
        <div class="tm-inbox-empty-sub">Generate an email address first</div>
      </div>
    </div>
    <div class="tm-auto-row">
      <label class="tr-row" style="padding:0;gap:7px;margin:0">
        <input type="checkbox" class="tck" id="tmAutoRef" onchange="toggleTmAutoRef()">
        <span class="ttr"><span class="tth"></span></span>
        <span style="font-size:11.5px;color:var(--gray)">Auto-refresh</span>
      </label>
      <span style="font-size:11px;color:var(--gray2)">every 10s</span>
      <span class="tm-countdown" id="tmCountdown" style="display:none"></span>
    </div>
  </div>
</div>

<div id="tmMsgView" style="display:none" class="tm-msg-view">
  <div class="tm-msg-head">
    <span class="chip chip-b">MESSAGE</span>
    <span class="tm-msg-subj" id="tmMsgSubject">—</span>
    <button class="tm-msg-close" onclick="closeTmMsg()">✕ Close</button>
  </div>
  <div class="tm-msg-from" id="tmMsgFrom"></div>
  <div class="tm-msg-body" id="tmMsgBody">Loading...</div>
</div>

<script>
var _tmLogin=null,_tmDomain=null,_tmAddr=null,_tmAutoTimer=null,_tmCountTimer=null,_tmCountVal=10;

function escH(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function setTmStatus(text,cls){
  var r=document.getElementById('tmStatRow');
  if(!text){r.style.setProperty('display','none','important');return;}
  r.style.removeProperty('display');
  r.innerHTML='<span class="tm-stat '+cls+'">'+escH(text)+'</span>';
}

function generateTmEmail(){
  var btn=document.getElementById('tmGenBtn');
  btn.disabled=true;
  btn.innerHTML='<span class="tm-spin"></span> Generating...';
  document.getElementById('tmAddr').className='tm-addr-ph';
  document.getElementById('tmAddr').textContent='Generating address...';
  document.getElementById('tmCopyBtn').style.display='none';
  setTmStatus('Connecting to mail server...','tm-stat-warn');
  closeTmMsg();

  fetch('/api/tempmail/generate',{method:'POST'}).then(r=>r.json()).then(d=>{
    btn.disabled=false;
    btn.innerHTML='<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Regenerate';
    if(d.error){
      document.getElementById('tmAddr').textContent='Failed: '+d.error;
      setTmStatus('Error: '+d.error,'tm-stat-err');
      return;
    }
    _tmAddr=d.address;_tmLogin=d.login;_tmDomain=d.domain;
    var el=document.getElementById('tmAddr');
    el.className='tm-addr';
    el.textContent=d.address;
    document.getElementById('tmCopyBtn').style.display='flex';
    setTmStatus('Active — ready to receive mail','tm-stat-ok');
    refreshTmInbox();
  }).catch(e=>{
    btn.disabled=false;
    btn.innerHTML='<svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg> Generate Email';
    setTmStatus('Network error','tm-stat-err');
  });
}

function copyTmEmail(){
  if(!_tmAddr)return;
  navigator.clipboard&&navigator.clipboard.writeText(_tmAddr).then(()=>{
    var btn=document.getElementById('tmCopyBtn');
    btn.classList.add('ok');
    btn.innerHTML='<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
    setTimeout(()=>{btn.classList.remove('ok');btn.innerHTML='<svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';},2000);
  });
}

function refreshTmInbox(){
  if(!_tmLogin){setTmStatus('Generate an email first','tm-stat-warn');return;}
  var btn=document.getElementById('tmRefreshBtn');
  if(btn){btn.disabled=true;btn.innerHTML='<span class="tm-spin"></span> Refreshing...';}
  fetch('/api/tempmail/inbox?login='+encodeURIComponent(_tmLogin)+'&domain='+encodeURIComponent(_tmDomain)).then(r=>r.json()).then(d=>{
    if(btn){btn.disabled=false;btn.innerHTML='${I.refresh.replace(/'/g,"\\'")} Refresh';}
    var el=document.getElementById('tmInboxList');
    var cnt=document.getElementById('tmInboxCount');
    if(d.error){
      cnt.className='tm-stat tm-stat-err';cnt.textContent='Error';
      el.innerHTML='<div class="tm-inbox-empty"><div class="tm-inbox-empty-txt" style="color:#ef4444">'+escH(d.error)+'</div></div>';
      return;
    }
    var msgs=d.messages||[];
    cnt.className='tm-stat '+(msgs.length?'tm-stat-ok':'tm-stat-gray');
    cnt.textContent=msgs.length+' message'+(msgs.length!==1?'s':'');
    if(!msgs.length){
      el.innerHTML='<div class="tm-inbox-empty"><div class="tm-inbox-empty-ico">📭</div><div class="tm-inbox-empty-txt">Inbox empty</div><div class="tm-inbox-empty-sub">Waiting for incoming mail...</div></div>';
      return;
    }
    el.innerHTML=msgs.map(function(m,i){
      var id=JSON.stringify(m.id);
      var subj=JSON.stringify(m.subject||'(no subject)');
      var from=JSON.stringify(m.from||'Unknown');
      return '<div class="tm-inbox-item unread" onclick="viewTmMsg('+id+','+subj+','+from+')">'
        +'<div class="tm-inbox-from">'+escH(m.from||'Unknown')+'</div>'
        +'<div class="tm-inbox-subj">'+escH(m.subject||'(no subject)')+'</div>'
        +'<div class="tm-inbox-date">'+escH(m.date||'')+'</div>'
        +'</div>';
    }).join('');
  }).catch(()=>{
    if(btn){btn.disabled=false;btn.innerHTML='${I.refresh.replace(/'/g,"\\'")} Refresh';}
    document.getElementById('tmInboxCount').className='tm-stat tm-stat-err';
    document.getElementById('tmInboxCount').textContent='Failed';
  });
}

function viewTmMsg(id,subject,from){
  document.getElementById('tmMsgView').style.display='';
  document.getElementById('tmMsgSubject').textContent=subject;
  document.getElementById('tmMsgFrom').textContent='From: '+from;
  document.getElementById('tmMsgBody').textContent='Loading message...';
  document.getElementById('tmMsgView').scrollIntoView({behavior:'smooth',block:'start'});
  fetch('/api/tempmail/message?login='+encodeURIComponent(_tmLogin)+'&domain='+encodeURIComponent(_tmDomain)+'&id='+encodeURIComponent(id)).then(r=>r.json()).then(d=>{
    document.getElementById('tmMsgBody').textContent=d.body||d.text||'(empty message)';
  }).catch(()=>{document.getElementById('tmMsgBody').textContent='Failed to load message.';});
}

function closeTmMsg(){
  document.getElementById('tmMsgView').style.display='none';
}

function toggleTmAutoRef(){
  var chk=document.getElementById('tmAutoRef');
  var cd=document.getElementById('tmCountdown');
  if(chk.checked){
    _tmCountVal=10;
    cd.style.display='';
    cd.textContent='Next in '+_tmCountVal+'s';
    _tmAutoTimer=setInterval(function(){
      _tmCountVal--;
      if(_tmCountVal<=0){_tmCountVal=10;refreshTmInbox();}
      cd.textContent='Next in '+_tmCountVal+'s';
    },1000);
  } else {
    clearInterval(_tmAutoTimer);_tmAutoTimer=null;
    cd.style.display='none';
  }
}
</script>`;
}

// ─── DASHBOARD CONTENT ────────────────────────────────────────────────────────
function buildDashboardContent(uid, innerTab) {
    const it = innerTab==="loop"?"messages":innerTab;
    const tabs = [
        {id:"overview",  label:"Overview",      icon:I.grid},
        {id:"messages",  label:"Loop Queue",     icon:I.msg},
        {id:"threads",   label:"Threads",        icon:I.threads},
        {id:"config",    label:"Config",         icon:I.config},
        {id:"cookie",    label:"Cookie",         icon:I.cookie},
        {id:"cmds",      label:"Custom Cmds",    icon:I.terminal},
        {id:"commands",  label:"Commands",       icon:I.book},
    ];
    const tabBar = `<div class="itabs-outer" id="itabsOuter"><div id="itabPill"></div>${tabs.map(t=>`<div class="itab${it===t.id?" act":""}" onclick="location='/?tab=dashboard&itab=${t.id}'">${t.icon} ${t.label}</div>`).join("")}</div><script>(function(){var act=document.querySelector('.itab.act');var outer=document.getElementById('itabsOuter');var pill=document.getElementById('itabPill');if(!act||!outer||!pill)return;function pl(){var or=outer.getBoundingClientRect();var ar=act.getBoundingClientRect();pill.style.cssText='left:'+(ar.left-or.left)+'px;top:'+(ar.top-or.top)+'px;width:'+ar.width+'px;height:'+ar.height+'px;opacity:1;';}requestAnimationFrame(function(){pl();});window.addEventListener('resize',pl);})();<\/script>`;
    let content="";
    if (it==="overview")  content=buildOverviewContent(uid);
    else if (it==="messages") content=buildMessagesContent(uid);
    else if (it==="threads")  content=buildThreadsContent(uid);
    else if (it==="config")   content=buildConfigContent(uid);
    else if (it==="cookie")   content=buildCookieContent(uid);
    else if (it==="cmds")     content=buildCustomCmdsContent(uid);
    else if (it==="commands") content=buildCommandsContent(uid);
    else content=buildOverviewContent(uid);
    return tabBar+content;
}

// ─── ACCOUNT ──────────────────────────────────────────────────────────────────
function buildAccountContent(uid) {
    const us  = getUserState(uid);
    const acct= getAccountInfo(uid);
    const alerts=(us.alerts||[]).slice(0,20);
    const alertHtml=alerts.length?alerts.map(a=>`<div class="lr lr-${a.type}"><span class="lt">${esc(a.time||"")}</span><span class="ll">${(a.type||"").toUpperCase()}</span><span class="lm">${esc((a.message||"").slice(0,120))}</span></div>`).join(""):
        `<div style="padding:22px;text-align:center;color:var(--gray2);font-size:12px">No alerts</div>`;
    const userObj = auth.getUser(uid) || {};
    return `
<div class="sg" style="grid-template-columns:repeat(3,1fr)">
  <div class="sc"><div class="sc-glow gc-r"></div><div class="sc-ico ci-r">${I.user}</div><div class="sc-val">${esc(acct.name||us.botName||"—")}</div><div class="sc-lbl">Bot Account Name</div></div>
  <div class="sc"><div class="sc-glow gc-w"></div><div class="sc-ico ci-w"><svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg></div><div class="sc-val">${esc(acct.uid||"—")}</div><div class="sc-lbl">Bot Facebook ID</div></div>
  <div class="sc"><div class="sc-glow gc-o"></div><div class="sc-ico ci-o">${I.clock}</div><div class="sc-val">${getUptime(uid)}</div><div class="sc-lbl">Uptime</div></div>
</div>
<div class="box" style="padding:18px 20px">
  <div class="bt" style="margin-bottom:14px">Session Info</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
    <div style="font-size:12px;color:var(--gray)">IP Address</div><div style="font-size:12px;color:var(--off);font-family:monospace">${esc(userObj.ip||"—")}</div>
    <div style="font-size:12px;color:var(--gray)">Device / Browser</div><div style="font-size:12px;color:var(--off);word-break:break-all">${esc((userObj.userAgent||"—").slice(0,80))}</div>
    <div style="font-size:12px;color:var(--gray)">Last Seen</div><div style="font-size:12px;color:var(--off)">${userObj.lastSeen?new Date(userObj.lastSeen).toLocaleString():"—"}</div>
    <div style="font-size:12px;color:var(--gray)">Account ID</div><div style="font-size:12px;color:var(--off);font-family:monospace">${esc(uid)}</div>
  </div>
</div>
<div class="box">
  <div class="bh"><span class="chip chip-y">ALERTS</span><span class="bt">Recent Alerts</span><span class="bm">${alerts.length} alerts</span></div>
  <div class="la">${alertHtml}</div>
</div>`;
}

// ─── PROFILE GUARD ────────────────────────────────────────────────────────────
function buildProfileGuardContent(uid) {
    function readGuardEnabled(uid) {
        try {
            const s = JSON.parse(fs.readFileSync(uFile(uid, "bot_state.json"), "utf8"));
            return s.profileGuardEnabled || false;
        } catch(_) { return false; }
    }
    const isActive = readGuardEnabled(uid);
    return `
<div class="hero"><div class="hero-in">
  <div class="hero-l">
    <div class="hero-ic">${I.guardPic}</div>
    <div>
      <div class="hero-title">Profile Guard</div>
      <div class="hero-desc">Facebook's official profile shield — prevents others from screenshotting or downloading your profile picture</div>
    </div>
  </div>
  <div class="st-badge ${isActive?"st-on":"st-off"}"><span class="st-dot"></span>${isActive?"Active":"Inactive"}</div>
</div></div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px">
  <div class="box" style="padding:22px 24px">
    <div class="bt" style="margin-bottom:18px">Toggle Profile Guard</div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <p style="font-size:12.5px;color:var(--gray);line-height:1.7;">
        When enabled, Facebook places an official shield on your profile picture. Others cannot screenshot, download, or share it. This uses Facebook's own <b>IsShieldedSetMutation</b> API.
      </p>
      ${!isActive
        ? `<form method="POST" action="/api/profileguard/enable"><button class="btn btn-r" type="submit">${I.guardPic} Enable Profile Guard</button></form>`
        : `<form method="POST" action="/api/profileguard/disable"><button class="btn btn-danger" type="submit">Disable Profile Guard</button></form>`
      }
    </div>
  </div>
  <div class="box" style="padding:22px 24px">
    <div class="bt" style="margin-bottom:14px">How It Works</div>
    <div class="steps-g">
      <div class="step"><div class="snum">1</div><div class="stxt">Click <b>Enable Profile Guard</b> to activate Facebook's official profile picture shield.</div></div>
      <div class="step"><div class="snum">2</div><div class="stxt">The shield is restored automatically whenever your bot reconnects to Facebook.</div></div>
      <div class="step"><div class="snum">3</div><div class="stxt">You can also use <code style="font-family:monospace;color:var(--off)">!gp on</code> or <code style="font-family:monospace;color:var(--off)">!gp off</code> directly in any chat (admin only).</div></div>
      <div class="step"><div class="snum">4</div><div class="stxt">This is Facebook's real built-in feature — not a workaround.</div></div>
    </div>
  </div>
</div>

<div class="box">
  <div class="bh"><span class="chip">STATUS</span><span class="bt">Current Guard Status</span></div>
  <div style="padding:20px 22px;display:flex;flex-direction:column;gap:10px">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--gray);font-size:12px">Guard Active</span>
      <span class="tag ${isActive?"tag-g":"tag-d"}">${isActive ? "YES" : "NO"}</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--gray);font-size:12px">API Used</span>
      <span style="font-size:12px;color:var(--off);font-family:monospace">IsShieldedSetMutation (FB GraphQL)</span>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0">
      <span style="color:var(--gray);font-size:12px">Command</span>
      <span style="font-size:12px;color:var(--off);font-family:monospace">!gp on  /  !gp off</span>
    </div>
  </div>
</div>`;
}

// ─── ABOUT ────────────────────────────────────────────────────────────────────
function buildAboutContent() {
    return `
<div class="hero"><div class="hero-in">
  <div class="hero-l">
    <div class="hero-ic">${I.bot}</div>
    <div>
      <div class="hero-title">DUMMYL BOT <span class="hero-ver">v2.4</span></div>
      <div class="hero-desc">Facebook Messenger Automation Platform</div>
    </div>
  </div>
</div></div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
  <div class="box" style="padding:22px 24px">
    <div class="bt" style="margin-bottom:14px">Developer</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      <div style="display:flex;justify-content:space-between"><span style="color:var(--gray);font-size:12px">Name</span><span style="font-size:12.5px;color:var(--off)">Kyle Gaspari (cozy)</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:var(--gray);font-size:12px">FB Dev ID</span><span style="font-size:12px;color:var(--off);font-family:monospace">61585831139336</span></div>
      <div style="display:flex;justify-content:space-between"><span style="color:var(--gray);font-size:12px">Bot Prefix</span><span style="font-size:13px;color:var(--red2);font-family:monospace;font-weight:700">!</span></div>
      <div style="margin-top:6px"><a href="https://www.facebook.com/profile.php?id=61580437366762" target="_blank" style="display:inline-flex;align-items:center;gap:7px;color:#8f7fb0;font-size:12px;transition:color .2s" onmouseover="this.style.color='#1877f2'" onmouseout="this.style.color='#8f7fb0'">${I.fb} Facebook Profile</a></div>
    </div>
  </div>
  <div class="box" style="padding:22px 24px">
    <div class="bt" style="margin-bottom:14px">Tech Stack</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${["Node.js","fca-unofficial (Facebook MQTT)","bcryptjs (Auth)","@distube/ytdl-core (YouTube Audio)","ffmpeg (Audio Processing)","1secmail.com (Temp Mail API)"].map(t=>`<div style="font-size:12px;color:var(--off);display:flex;align-items:center;gap:6px"><span style="width:5px;height:5px;border-radius:50%;background:var(--red2);display:inline-block;box-shadow:0 0 6px var(--red)"></span>${t}</div>`).join("")}
    </div>
  </div>
</div>`;
}

// ─── ADMIN ────────────────────────────────────────────────────────────────────
function buildAdminContent() {
    const users      = auth.getAllUsers();
    const allKeys    = auth.readKeys();
    const activeSess = auth.getActiveSessions();
    const activeMap  = {};
    for (const s of activeSess) activeMap[s.userId]=s;

    const rows = users.map(u=>{
        const isActive=!!activeMap[u.id];
        const keyObj = allKeys.find(k=>k.userId===u.id&&!k.revoked);
        return `<tr>
<td>
  <b style="color:var(--white)">${esc(u.botName||u.username||"(unnamed)")}</b>
  <div style="font-size:10.5px;color:var(--gray)">${esc(u.id)}</div>
  ${u.accountId?`<div style="font-size:10px;color:var(--gray2);font-family:monospace">FB: ${esc(u.accountId)}</div>`:""}
</td>
<td>${isActive?`<span class="tag tag-g">Online</span>`:`<span class="tag tag-d">Offline</span>`}</td>
<td>
  ${u.ip?`<div style="font-family:monospace;font-size:11px;color:var(--off)">${esc(u.ip)}</div>`:`<span style="color:var(--gray2)">—</span>`}
  ${u.userAgent?`<div style="font-size:10px;color:var(--gray2);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(u.userAgent)}">${esc(u.userAgent.slice(0,50))}</div>`:""}
</td>
<td>${keyObj?`<span class="key-cell" title="Click to copy" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(keyObj.key)}').then(()=>this.style.borderColor='#22c55e')">${esc(keyObj.key)}</span>`:`<span style="color:var(--gray2);font-size:11px">${u.isAdmin?"ADMIN KEY":"No key"}</span>`}</td>
<td style="font-size:11px;color:var(--gray)">${u.lastSeen?new Date(u.lastSeen).toLocaleString():"Never"}</td>
<td>${u.isBanned?`<span class="tag tag-r">BANNED</span>`:(u.isAdmin?`<span class="tag tag-b">ADMIN</span>`:`<span class="tag tag-g">ACTIVE</span>`)}</td>
<td><div style="display:flex;gap:5px;flex-wrap:wrap">
  ${!u.isAdmin&&!u.isBanned?`<form method="POST" action="/admin/ban" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-danger btn-xs">Ban</button></form>`:""}
  ${!u.isAdmin&&u.isBanned?`<form method="POST" action="/admin/unban" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-o btn-xs">Unban</button></form>`:""}
  ${!u.isAdmin?`<form method="POST" action="/admin/delete" style="margin:0"><input type="hidden" name="userId" value="${esc(u.id)}"/><button class="btn btn-danger btn-xs" onclick="return confirm('Delete this user?')">Delete</button></form>`:""}
</div></td>
</tr>`;
    }).join("");

    const keyRows = allKeys.map(k=>`<tr>
<td class="td-m"><span class="key-cell" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(k.key)}').then(()=>this.style.borderColor='#22c55e')">${esc(k.key)}</span></td>
<td style="font-size:12px;color:var(--off)">${esc(k.label||"—")}</td>
<td style="font-size:11px;color:var(--gray)">${esc(k.userId)}</td>
<td>${k.revoked?`<span class="tag tag-r">REVOKED</span>`:`<span class="tag tag-g">ACTIVE</span>`}</td>
<td style="font-size:11px;color:var(--gray)">${k.createdAt?new Date(k.createdAt).toLocaleString():"—"}</td>
<td>
  ${!k.revoked?`<form method="POST" action="/admin/revoke-key" style="margin:0"><input type="hidden" name="key" value="${esc(k.key)}"/><button class="btn btn-danger btn-xs">Revoke</button></form>`:`<span style="color:var(--gray2);font-size:11px">Revoked</span>`}
</td>
</tr>`).join("");

    return `
<div class="adm-banner">
  <div class="adm-ic">${I.shield}</div>
  <div><div class="adm-title">Admin Control Panel</div><div class="adm-sub">${users.length} users — ${activeSess.length} online now — ${allKeys.filter(k=>!k.revoked).length} active keys</div></div>
</div>
<div class="sg" style="grid-template-columns:repeat(4,1fr)">
  <div class="sc"><div class="sc-glow gc-r"></div><div class="sc-ico ci-r">${I.user}</div><div class="sc-val">${users.length}</div><div class="sc-lbl">Total Users</div></div>
  <div class="sc"><div class="sc-glow gc-w"></div><div class="sc-ico ci-w">${I.shield}</div><div class="sc-val">${activeSess.length}</div><div class="sc-lbl">Online Now</div></div>
  <div class="sc"><div class="sc-glow gc-g"></div><div class="sc-ico ci-g">${I.key}</div><div class="sc-val">${allKeys.filter(k=>!k.revoked).length}</div><div class="sc-lbl">Active Keys</div></div>
  <div class="sc"><div class="sc-glow gc-o"></div><div class="sc-ico ci-o">${I.shield}</div><div class="sc-val">${users.filter(u=>u.isBanned).length}</div><div class="sc-lbl">Banned</div></div>
</div>

<div class="box">
  <div class="bh"><span class="chip chip-g">GENERATE</span><span class="bt">Generate License Key</span></div>
  <div style="padding:16px 20px">
    <form method="POST" action="/admin/generate-key" style="display:flex;gap:10px;align-items:center">
      <input class="ai" name="label" placeholder="Label (e.g. John's key)" style="max-width:300px">
      <button class="btn btn-r btn-sm" type="submit">${I.key} Generate Key</button>
    </form>
    ${(()=>{
        const lastKey = allKeys.slice(-1)[0];
        return lastKey && !lastKey.revoked ? `<div style="margin-top:12px;padding:12px 16px;background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:10px;display:flex;align-items:center;gap:10px"><span style="font-size:11px;color:var(--gray)">Latest key:</span><span class="key-cell" onclick="navigator.clipboard&&navigator.clipboard.writeText('${esc(lastKey.key)}').then(()=>this.style.borderColor='#ef4444')">${esc(lastKey.key)}</span><span style="font-size:11px;color:var(--gray2)">${esc(lastKey.label||"")}</span></div>` : "";
    })()}
  </div>
</div>

<div class="box">
  <div class="bh"><span class="chip">${I.key} KEYS</span><span class="bt">All License Keys</span><span class="bm">${allKeys.length} total</span></div>
  <table><thead><tr><th>Key</th><th>Label</th><th>User ID</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
  <tbody>${keyRows||`<tr><td colspan="6" class="td-e">No keys generated yet</td></tr>`}</tbody></table>
</div>

<div class="box">
  <div class="bh"><span class="chip">USERS</span><span class="bt">Registered Accounts</span><span class="bm">${users.length} total</span></div>
  <table><thead><tr><th>Bot Name / ID</th><th>Status</th><th>IP / Device</th><th>License Key</th><th>Last Seen</th><th>Role</th><th>Actions</th></tr></thead>
  <tbody>${rows||`<tr><td colspan="7" class="td-e">No users</td></tr>`}</tbody>
</table>
</div>`;
}

// ─── PAGE BUILDER ─────────────────────────────────────────────────────────────
function buildPage(session, mainTab, innerTab) {
    let content="";
    const uid=session.userId;
    if (mainTab==="dashboard") content=buildDashboardContent(uid,innerTab);
    else if (mainTab==="account") content=buildAccountContent(uid);
    else if (mainTab==="tempmail") content=buildTempMailContent(uid);
    else if (mainTab==="profileguard") content=buildProfileGuardContent(uid);
    else if (mainTab==="about")   content=buildAboutContent();
    else if (mainTab==="admin"&&session.isAdmin) content=buildAdminContent();
    else content=buildDashboardContent(uid,innerTab);
    return buildLayout(session,mainTab||"dashboard",content);
}

// ─── TEMP MAIL API (1secmail.com) ─────────────────────────────────────────────
async function generate1SecMail() {
    try {
        const res = await fetch("https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1");
        if (!res.ok) return { error: "Failed to generate address" };
        const arr = await res.json();
        if (!arr || !arr.length) return { error: "No address returned" };
        const email = arr[0];
        const atIdx = email.indexOf("@");
        const login  = email.slice(0, atIdx);
        const domain = email.slice(atIdx + 1);
        return { address: email, login, domain };
    } catch(e) { return { error: e.message }; }
}

async function get1SecMailInbox(login, domain) {
    try {
        const res = await fetch(`https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`);
        if (!res.ok) return { error: "Failed to fetch inbox" };
        const arr = await res.json();
        const msgs = (arr || []).map(m => ({
            id:      m.id,
            from:    m.from    || "Unknown",
            subject: m.subject || "(no subject)",
            date:    m.date    || "",
        }));
        return { messages: msgs };
    } catch(e) { return { error: e.message }; }
}

async function read1SecMailMessage(login, domain, id) {
    try {
        const res = await fetch(`https://www.1secmail.com/api/v1/?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(id)}`);
        if (!res.ok) return { error: "Failed to fetch message" };
        const m = await res.json();
        return { body: m.textBody || m.htmlBody || "(empty)", subject: m.subject || "" };
    } catch(e) { return { error: e.message }; }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────
function startDashboard(port) {
    const server = http.createServer(async (req, res) => {
        const url_  = new URL(req.url, `http://localhost`);
        const path_ = url_.pathname;
        const sess  = getSessionFromReq(req);
        const clientIP = getClientIP(req);
        const userAgent = req.headers["user-agent"] || "";

        function redirect(to,code=302){ res.writeHead(code,{Location:to});res.end(); }
        function html(body,code=200)  { res.writeHead(code,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"});res.end(body); }
        function json(obj,code=200)   { res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(obj)); }

        // ─── STATIC ASSETS (background effect) ───────────────────────────
        if (req.method === "GET" && path_ === "/assets/faulty-terminal.js") {
            try {
                const file = fs.readFileSync(path.join(__dirname, "public", "faulty-terminal.js"));
                res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=3600" });
                return res.end(file);
            } catch (_) { res.writeHead(404); return res.end(); }
        }

        // ─── ENTRY FLOW: Cookie then Key ─────────────────────────────────
        if ((path_==="/"||path_==="/login")&&!sess) {
            return html(buildCookieEntryPage("","","cookie"));
        }
        if (path_==="/register"&&!sess) return redirect("/");

        // Step 1: verify cookie, extract bot name, store pending server-side (no size limit)
        if (path_==="/api/entry/cookie"&&req.method==="POST") {
            const body = await parseBody(req);
            const raw = body.cookie||"";
            if (!raw.trim()) return html(buildCookieEntryPage("Please paste your fbstate.json cookie.","","cookie"));
            let parsed;
            try { parsed = JSON.parse(raw); } catch(_) { return html(buildCookieEntryPage("Invalid JSON — please paste the raw fbstate.json array.","","cookie")); }
            if (!Array.isArray(parsed)||!parsed.length) return html(buildCookieEntryPage("Cookie must be a non-empty JSON array.","","cookie"));
            const cUser = parsed.find(c=>c.key==="c_user");
            const fbUid = cUser ? cUser.value : "";
            const botName = fbUid ? `FB_${fbUid}` : "FB_User";
            // Store server-side — no size limit
            const pendingToken = require("crypto").randomBytes(24).toString("hex");
            pendingCookies.set(pendingToken, { cookie: raw, botName, createdAt: Date.now() });
            res.writeHead(302,{
                "Set-Cookie":`dbl_pending=${pendingToken}; Path=/; HttpOnly; SameSite=Lax`,
                "Location":"/entry/key",
            });
            return res.end();
        }

        // Redirect to key step
        if (path_==="/entry/key") {
            const pendingToken = (req.headers.cookie||"").match(/(?:^|;\s*)dbl_pending=([^;]+)/)?.[1];
            const pending = pendingToken ? pendingCookies.get(pendingToken) : null;
            if (!pending) return redirect("/");
            return html(buildCookieEntryPage("", pending.botName, "key"));
        }

        // Step 2: validate license key, create session
        if (path_==="/api/entry/key"&&req.method==="POST") {
            const body = await parseBody(req);
            const key = (body.licenseKey||"").trim();
            const botNameFromForm = (body.botName||"").trim();
            const pendingToken = (req.headers.cookie||"").match(/(?:^|;\s*)dbl_pending=([^;]+)/)?.[1];
            const cookieData = pendingToken ? pendingCookies.get(pendingToken) : null;
            const validation = auth.validateKey(key);
            if (validation.error) {
                return html(buildCookieEntryPage(validation.error, botNameFromForm, "key"));
            }
            const botName = botNameFromForm || "User";
            const cUser = cookieData?.cookie ? (() => { try { const arr=JSON.parse(cookieData.cookie); return arr.find(c=>c.key==="c_user"); } catch(_){return null;} })() : null;
            const accountId = cUser ? cUser.value : null;
            const userResult = auth.getOrCreateUserByKey(key, botName, accountId);
            if (userResult.error) return html(buildCookieEntryPage(userResult.error, botName, "key"));
            const userId = userResult.user.id;
            // save cookie for this user
            if (cookieData?.cookie) {
                auth.ensureUserDataDir(userId);
                const dest = path.join(uDir(userId), "fbstate.json");
                try { fs.writeFileSync(dest, cookieData.cookie, "utf8"); } catch(_) {}
                if (_cookieUpdateCb) _cookieUpdateCb(userId);
            }
            if (pendingToken) pendingCookies.delete(pendingToken);
            auth.updateUserInfo(userId, { ip: clientIP, userAgent });
            const token = auth.createSession(userId, clientIP, userAgent);
            if (!token) return html(buildCookieEntryPage("Session error — please try again.","","cookie"));
            res.writeHead(302, {
                "Set-Cookie": [
                    `dbl_sess=${token}; Path=/; HttpOnly; SameSite=Lax`,
                    `dbl_pending=; Path=/; HttpOnly; Max-Age=0`,
                ],
                "Location": userResult.isAdmin ? "/?tab=admin" : "/?tab=dashboard"
            });
            return res.end();
        }

        if (path_==="/api/auth/logout"&&req.method==="POST") {
            const tok=getTokenFromReq(req);
            if(tok) auth.destroySession(tok);
            res.writeHead(302,{"Set-Cookie":`dbl_sess=; Path=/; HttpOnly; Max-Age=0`,"Location":"/"});res.end();return;
        }

        if (!sess) return redirect("/");
        auth.updateLastSeen(sess.userId);
        const uid=sess.userId;

        // ─── MAIN DASHBOARD ───────────────────────────────────────────────
        if (path_==="/"&&req.method==="GET") {
            const mainTab=url_.searchParams.get("tab")||"dashboard";
            const innerTab=url_.searchParams.get("itab")||"overview";
            if (mainTab==="admin"&&!sess.isAdmin) return redirect("/?tab=dashboard");
            return html(buildPage(sess,mainTab,innerTab));
        }

        // ─── ADMIN ROUTES ─────────────────────────────────────────────────
        if (path_==="/admin/ban"&&req.method==="POST"&&sess.isAdmin)    { const body=await parseBody(req);auth.banUser(body.userId,body.reason||"");return redirect("/?tab=admin"); }
        if (path_==="/admin/unban"&&req.method==="POST"&&sess.isAdmin)  { const body=await parseBody(req);auth.unbanUser(body.userId);return redirect("/?tab=admin"); }
        if (path_==="/admin/delete"&&req.method==="POST"&&sess.isAdmin) { const body=await parseBody(req);auth.deleteUser(body.userId);return redirect("/?tab=admin"); }
        if (path_==="/admin/generate-key"&&req.method==="POST"&&sess.isAdmin) {
            const body=await parseBody(req);
            auth.createLicenseKey(body.label||"");
            return redirect("/?tab=admin");
        }
        if (path_==="/admin/revoke-key"&&req.method==="POST"&&sess.isAdmin) {
            const body=await parseBody(req);
            auth.revokeKey(body.key||"");
            return redirect("/?tab=admin");
        }

        // ─── API ──────────────────────────────────────────────────────────
        if (path_==="/api/status")       { const us=getUserState(uid);return json({loggedIn:us.loggedIn,botName:us.botName,uptime:getUptime(uid),totalRepliesSent:us.totalRepliesSent}); }
        if (path_==="/api/hourly-stats") return json(getHourlyStats(uid));
        if (path_==="/api/alerts")       return json(getUserState(uid).alerts);

        // Temp mail API
        if (path_==="/api/tempmail/generate"&&req.method==="POST") {
            const result = await generate1SecMail();
            return json(result);
        }
        if (path_==="/api/tempmail/inbox"&&req.method==="GET") {
            const login  = url_.searchParams.get("login")||"";
            const domain = url_.searchParams.get("domain")||"";
            if (!login||!domain) return json({error:"Missing login/domain"});
            const result = await get1SecMailInbox(login, domain);
            return json(result);
        }
        if (path_==="/api/tempmail/message"&&req.method==="GET") {
            const login  = url_.searchParams.get("login")||"";
            const domain = url_.searchParams.get("domain")||"";
            const id     = url_.searchParams.get("id")||"";
            if (!login||!domain||!id) return json({error:"Missing params"});
            const result = await read1SecMailMessage(login, domain, id);
            return json(result);
        }

        // Profile Guard endpoints
        if (path_==="/api/profileguard/enable"&&req.method==="POST") {
            if (_botProfileGuardCb) _botProfileGuardCb(uid, true);
            const stateFile = uFile(uid, "bot_state.json");
            let st = {};
            try { st = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch(_) {}
            st.profileGuardEnabled = true;
            auth.ensureUserDataDir(uid);
            fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
            return redirect("/?tab=profileguard");
        }
        if (path_==="/api/profileguard/disable"&&req.method==="POST") {
            if (_botProfileGuardCb) _botProfileGuardCb(uid, false);
            const stateFile = uFile(uid, "bot_state.json");
            let st = {};
            try { st = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch(_) {}
            st.profileGuardEnabled = false;
            auth.ensureUserDataDir(uid);
            fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));
            return redirect("/?tab=profileguard");
        }

        // Image upload
        if (path_==="/api/images/upload"&&req.method==="POST") {
            const body=await parseJsonBody(req);
            const imgData=body.imageData||"";const imgName=body.imageName||"photo";
            if (!imgData.startsWith("data:image/")) return res.writeHead(400).end("Bad data");
            const m=imgData.match(/^data:image\/(\w+);base64,(.+)$/s);if(!m)return res.writeHead(400).end("Bad format");
            const ext=m[1].toLowerCase().replace("jpeg","jpg");const buf=Buffer.from(m[2],"base64");
            const uploadsDir=path.join(uDir(uid),"uploads");try{fs.mkdirSync(uploadsDir,{recursive:true});}catch(_){}
            const safe=imgName.replace(/[^a-zA-Z0-9._-]/g,"_").slice(0,50);const fname=`${Date.now()}_${safe}`;
            fs.writeFileSync(path.join(uploadsDir,fname),buf);
            res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true}));return;
        }
        if (path_==="/api/images/file-remove"&&req.method==="POST") {
            const body=await parseBody(req);const filename=body.filename||"";
            if(filename&&!filename.includes("..")&&!filename.includes("/")){try{fs.unlinkSync(path.join(uDir(uid),"uploads",filename));}catch(_){}}
            return redirect("/?tab=dashboard&itab=messages");
        }
        if (path_==="/uploads"&&req.method==="GET") {
            const fn=url_.searchParams.get("file")||"";
            if(!fn||fn.includes("..")||fn.includes("/"))return res.writeHead(404).end("Not found");
            const fp=path.join(uDir(uid),"uploads",fn);if(!fs.existsSync(fp))return res.writeHead(404).end("Not found");
            const ext=path.extname(fn).toLowerCase();const mime={".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".gif":"image/gif",".webp":"image/webp"}[ext]||"image/jpeg";
            res.writeHead(200,{"Content-Type":mime,"Cache-Control":"max-age=86400"});fs.createReadStream(fp).pipe(res);return;
        }
        if (path_==="/api/banner/upload"&&req.method==="POST") {
            const body=await parseJsonBody(req);const bData=body.bannerData||"";
            if(!bData.startsWith("data:image/"))return res.writeHead(400).end("Bad data");
            const m=bData.match(/^data:image\/(\w+);base64,(.+)$/s);if(!m)return res.writeHead(400).end("Bad format");
            const buf=Buffer.from(m[2],"base64");auth.ensureUserDataDir(uid);
            fs.writeFileSync(path.join(uDir(uid),"banner_upload.jpg"),buf);
            res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({ok:true}));return;
        }
        if (path_==="/api/banner/remove"&&req.method==="POST") { try{fs.unlinkSync(path.join(uDir(uid),"banner_upload.jpg"));}catch(_){} return redirect("/?tab=dashboard&itab=config"); }
        if (path_==="/banner"&&req.method==="GET") {
            const fp=path.join(uDir(uid),"banner_upload.jpg");if(!fs.existsSync(fp))return res.writeHead(404).end("No banner");
            res.writeHead(200,{"Content-Type":"image/jpeg","Cache-Control":"no-cache"});fs.createReadStream(fp).pipe(res);return;
        }

        if (path_==="/api/config/toggle-prebuilt"&&req.method==="POST") {
            const cfg=readBotConfig(uid);cfg.useBuiltinReplies=cfg.useBuiltinReplies===false?true:false;writeBotConfig(uid,cfg);
            return redirect("/?tab=dashboard&itab=messages");
        }

        if (path_==="/api/replies/add"&&req.method==="POST") {
            const body=await parseBody(req);if(body.word){const a=readCustomReplies(uid);a.push(body.word.trim());writeCustomReplies(uid,a);}
            return redirect(`/?tab=dashboard&itab=${body.redirect||"messages"}`);
        }
        if (path_==="/api/replies/remove"&&req.method==="POST") {
            const body=await parseBody(req);const a=readCustomReplies(uid);a.splice(parseInt(body.index),1);writeCustomReplies(uid,a);
            return redirect(`/?tab=dashboard&itab=${body.redirect||"messages"}`);
        }

        if (path_==="/api/config/save"&&req.method==="POST") {
            const body=await parseBody(req);const cfg=readBotConfig(uid);
            const num=(k,def)=>{const v=parseFloat(body[k]);return isNaN(v)?def:v;};
            const bool=k=>body[k]==="1"||body[k]==="true"||body[k]==="on";
            cfg.loopReact=body.loopReact||cfg.loopReact; cfg.loopDelay=Math.max(0.5,num("loopDelay",1));
            cfg.imageProbability=num("imageProbability",20); cfg.loopMode=body.loopMode||"sequential";
            cfg.maxLoopCount=num("maxLoopCount",0); cfg.autoStopMinutes=num("autoStopMinutes",0);
            cfg.loopStartMsg=body.loopStartMsg??cfg.loopStartMsg; cfg.loopStopMsg=body.loopStopMsg??cfg.loopStopMsg;
            cfg.ttsLang=body.ttsLang||cfg.ttsLang; cfg.reactOnlyMode=bool("reactOnlyMode");
            cfg.greetNewMembers=bool("greetNewMembers"); cfg.greetMsg=body.greetMsg??cfg.greetMsg;
            cfg.antiSpamEnabled=bool("antiSpamEnabled"); cfg.antiSpamMaxMsg=num("antiSpamMaxMsg",5);
            cfg.antiSpamWindowSec=num("antiSpamWindowSec",10); cfg.autoSeenEnabled=bool("autoSeenEnabled");
            cfg.typingSimulate=bool("typingSimulate"); cfg.silentMode=bool("silentMode");
            cfg.loopSilentMode=bool("loopSilentMode"); cfg.autoReactEnabled=bool("autoReactEnabled");
            cfg.autoReactEmoji=body.autoReactEmoji||cfg.autoReactEmoji;
            // Mass Comment Sender (fca-riyad: postComment/reactToComment, anti-detection)
            cfg.massCommentEnabled = bool("massCommentEnabled");
            cfg.massCommentPostIDs = body.massCommentPostIDs ?? cfg.massCommentPostIDs ?? "";
            cfg.massCommentTexts   = body.massCommentTexts   ?? cfg.massCommentTexts   ?? "";
            cfg.massCommentDelayMin = Math.max(5, num("massCommentDelayMin", 15));
            cfg.massCommentDelayMax = Math.max(5, num("massCommentDelayMax", 45));
            if (cfg.massCommentDelayMax < cfg.massCommentDelayMin) cfg.massCommentDelayMax = cfg.massCommentDelayMin;
            cfg.massCommentReact    = bool("massCommentReact");
            cfg.massCommentReaction = body.massCommentReaction || cfg.massCommentReaction || "like";
            writeBotConfig(uid,cfg);
            return redirect("/?tab=dashboard&itab=config");
        }

        if (path_==="/api/cookie/slot"&&req.method==="POST") {
            const body=await parseBody(req);const raw=body.cookie||"";
            if(!raw.trim())return redirect("/?tab=dashboard&itab=cookie");
            let parsed;try{parsed=JSON.parse(raw);}catch(_){return redirect("/?tab=dashboard&itab=cookie");}
            if(!Array.isArray(parsed)||!parsed.length)return redirect("/?tab=dashboard&itab=cookie");
            const slot=body.slot||"fbstate.json";
            const dest=path.join(uDir(uid),path.basename(slot).replace(/[^a-zA-Z0-9._-]/g,""));
            auth.ensureUserDataDir(uid);fs.writeFileSync(dest,JSON.stringify(parsed,null,2),"utf8");
            const us=getUserState(uid);
            us.logs.splice(0,us.logs.length);us.totalRepliesSent=0;us.startedAt=new Date();
            us.loopEnabled={};us.autoRespondEnabled={};us.mutedThreads={};
            us.bots=[];us.botName="";us.loginInProgress=true;
            if(_cookieUpdateCb)_cookieUpdateCb(uid);
            return redirect("/?tab=dashboard&itab=cookie");
        }

        if (path_==="/api/cmds/add"&&req.method==="POST") {
            const body=await parseBody(req);
            if(body.cmd&&body.reply){const a=readCustomCommands(uid);const cmd=body.cmd.startsWith("!")?body.cmd:"!"+body.cmd;a.push({cmd,reply:body.reply});writeCustomCommands(uid,a);}
            return redirect("/?tab=dashboard&itab=cmds");
        }
        if (path_==="/api/cmds/remove"&&req.method==="POST") {
            const body=await parseBody(req);const a=readCustomCommands(uid);a.splice(parseInt(body.index),1);writeCustomCommands(uid,a);
            return redirect("/?tab=dashboard&itab=cmds");
        }

        if (path_==="/api/whitelist/toggle"&&req.method==="POST") { const w=readWhitelist(uid);w.enabled=!w.enabled;writeWhitelist(uid,w);return redirect("/?tab=dashboard&itab=threads"); }
        if (path_==="/api/whitelist/add"&&req.method==="POST")    { const body=await parseBody(req);if(body.uid){const w=readWhitelist(uid);if(!w.uids.includes(body.uid)){w.uids.push(body.uid);writeWhitelist(uid,w);}}return redirect("/?tab=dashboard&itab=threads"); }
        if (path_==="/api/whitelist/remove"&&req.method==="POST") { const body=await parseBody(req);if(body.uid){const w=readWhitelist(uid);w.uids=w.uids.filter(u=>u!==body.uid);writeWhitelist(uid,w);}return redirect("/?tab=dashboard&itab=threads"); }

        if (path_==="/api/thread/config"&&req.method==="POST") {
            const body=await parseBody(req);
            if(body.threadID){const c=readThreadConfig(uid);c[body.threadID]={loopDelay:parseFloat(body.loopDelay)||null,loopReact:body.loopReact||null};writeThreadConfig(uid,c);}
            return redirect("/?tab=dashboard&itab=threads");
        }
        if (path_==="/api/thread/startloop"&&req.method==="POST") { const body=await parseBody(req);if(body.threadID&&_loopControlCb)_loopControlCb(uid,"start",body.threadID);return redirect("/?tab=dashboard&itab=threads"); }
        if (path_==="/api/thread/stoploop"&&req.method==="POST")  { const body=await parseBody(req);if(body.threadID&&_loopControlCb)_loopControlCb(uid,"stop",body.threadID);return redirect("/?tab=dashboard&itab=threads"); }
        if (path_==="/api/thread/stopall"&&req.method==="POST") {
            if(_stopAllCb)_stopAllCb(uid);
            const us=getUserState(uid);
            Object.keys(us.loopEnabled||{}).filter(t=>us.loopEnabled[t]).forEach(t=>{if(_loopControlCb)_loopControlCb(uid,"stop",t);});
            return redirect("/?tab=dashboard&itab=threads");
        }

        res.writeHead(404,{"Content-Type":"text/plain"});res.end("Not found");
    });

    server.listen(parseInt(port)||5000,"0.0.0.0",()=>{
        console.log(`[cozy-bot] Dashboard running on port ${port}`);
    });
}

module.exports = {
    startDashboard, getUserState, addLog, sysLog, addAlert, state,
    setCookieUpdateHandler, setLoopControlHandler, setStopAllHandler, setBotProfileGuardHandler,
    trackMessage, setAccountInfoForUser,
};
