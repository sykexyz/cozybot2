"use strict";

const fs      = require("fs");
const path    = require("path");
const bcrypt  = require("bcryptjs");
const crypto  = require("crypto");

const DATA_DIR      = path.join(__dirname, "../data");
const USERS_FILE    = path.join(DATA_DIR, "users.json");
const SESSIONS_FILE = path.join(DATA_DIR, "sessions.json");
const KEYS_FILE     = path.join(DATA_DIR, "license_keys.json");
const ADMIN_KEY     = "boboka24123";
const ADMIN_ID      = "admin_001";

const sessions = new Map();

function ensureDataDir() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function readUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
    catch (_) { return []; }
}
function writeUsers(arr) {
    ensureDataDir();
    fs.writeFileSync(USERS_FILE, JSON.stringify(arr, null, 2), "utf8");
}

function readKeys() {
    try { return JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")); }
    catch (_) { return []; }
}
function writeKeys(arr) {
    ensureDataDir();
    fs.writeFileSync(KEYS_FILE, JSON.stringify(arr, null, 2), "utf8");
}

function saveSessions() {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify([...sessions.values()], null, 2), "utf8"); }
    catch (_) {}
}
function loadSessions() {
    try {
        const arr = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
        for (const s of arr) if (s && s.token) sessions.set(s.token, s);
    } catch (_) {}
}

function getUserDataDir(userId) {
    return path.join(DATA_DIR, "u_" + userId);
}
function ensureUserDataDir(userId) {
    try { fs.mkdirSync(getUserDataDir(userId), { recursive: true }); } catch (_) {}
}

function generateKey() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const seg = () => Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

function init() {
    ensureDataDir();
    loadSessions();

    const users = readUsers();
    const adminExists = users.find(u => u.id === ADMIN_ID);
    if (!adminExists) {
        users.push({
            id: ADMIN_ID,
            username: "Admin",
            botName: "Admin",
            isAdmin: true,
            isBanned: false,
            banReason: "",
            createdAt: new Date().toISOString(),
            lastSeen: null,
            sessionStart: null,
            ip: null,
            userAgent: null,
            accountId: null,
        });
        writeUsers(users);
    }

    users.forEach(u => ensureUserDataDir(u.id));

    const adminDir = getUserDataDir(ADMIN_ID);
    const legacyFiles = [
        "fbstate.json","fbstate2.json","fbstate3.json",
        "custom_replies.json","image_replies.json","bot_config.json",
        "custom_commands.json","whitelist.json","thread_config.json","bot_state.json"
    ];
    for (const f of legacyFiles) {
        const src = path.join(DATA_DIR, f);
        const dst = path.join(adminDir, f);
        if (fs.existsSync(src) && !fs.existsSync(dst)) {
            try { fs.copyFileSync(src, dst); } catch (_) {}
        }
    }
}

function validateKey(key) {
    if (!key) return { error: "License key required" };
    const trimmed = key.trim();
    if (trimmed === ADMIN_KEY) return { isAdmin: true, userId: ADMIN_ID };
    const keys = readKeys();
    const found = keys.find(k => k.key === trimmed && !k.revoked);
    if (!found) return { error: "Invalid or revoked license key" };
    return { isAdmin: false, userId: found.userId, key: found };
}

function getOrCreateUserByKey(key, botName, accountId) {
    const validation = validateKey(key);
    if (validation.error) return { error: validation.error };

    if (validation.isAdmin) {
        const users = readUsers();
        let admin = users.find(u => u.id === ADMIN_ID);
        if (!admin) {
            admin = { id: ADMIN_ID, username: "Admin", botName: "Admin", isAdmin: true, isBanned: false };
            users.push(admin);
        }
        if (botName) { admin.botName = botName; admin.username = botName; }
        if (accountId) admin.accountId = accountId;
        writeUsers(users);
        return { user: admin, isAdmin: true };
    }

    const keys = readKeys();
    const keyObj = keys.find(k => k.key === key.trim());
    if (!keyObj) return { error: "Key not found" };

    const users = readUsers();
    let user = users.find(u => u.id === keyObj.userId);
    if (!user) {
        user = {
            id: keyObj.userId,
            username: botName || keyObj.userId,
            botName: botName || "",
            isAdmin: false,
            isBanned: false,
            banReason: "",
            createdAt: new Date().toISOString(),
            lastSeen: null,
            sessionStart: null,
            ip: null,
            userAgent: null,
            accountId: accountId || null,
        };
        users.push(user);
    } else {
        if (botName) { user.botName = botName; user.username = botName; }
        if (accountId) user.accountId = accountId;
    }
    writeUsers(users);
    ensureUserDataDir(user.id);
    return { user };
}

function createSession(userId, ip, userAgent) {
    const token = crypto.randomBytes(40).toString("hex");
    const users = readUsers();
    const user = users.find(u => u.id === userId);
    if (!user) return null;

    const sess = {
        token,
        userId: user.id,
        username: user.botName || user.username || user.id,
        isAdmin: !!user.isAdmin,
        createdAt: Date.now(),
        ip: ip || null,
        userAgent: userAgent || null,
    };
    sessions.set(token, sess);

    user.lastSeen = new Date().toISOString();
    user.sessionStart = new Date().toISOString();
    if (ip) user.ip = ip;
    if (userAgent) user.userAgent = userAgent;
    writeUsers(users);
    saveSessions();
    return token;
}

function getSession(token) {
    if (!token) return null;
    return sessions.get(token) || null;
}

function destroySession(token) {
    const s = sessions.get(token);
    sessions.delete(token);
    if (s) {
        const users = readUsers();
        const u = users.find(x => x.id === s.userId);
        if (u) { u.sessionStart = null; writeUsers(users); }
    }
    saveSessions();
}

function getSessionFromReq(req) {
    const raw = req.headers.cookie || "";
    const match = raw.match(/(?:^|;\s*)dbl_sess=([^;]+)/);
    return match ? getSession(match[1]) : null;
}

function getTokenFromReq(req) {
    const raw = req.headers.cookie || "";
    const match = raw.match(/(?:^|;\s*)dbl_sess=([^;]+)/);
    return match ? match[1] : null;
}

function getAllUsers() { return readUsers(); }
function getUser(id)   { return readUsers().find(u => u.id === id) || null; }

function banUser(id, reason) {
    const users = readUsers();
    const u = users.find(x => x.id === id);
    if (u) { u.isBanned = true; u.banReason = reason || ""; writeUsers(users); }
}
function unbanUser(id) {
    const users = readUsers();
    const u = users.find(x => x.id === id);
    if (u) { u.isBanned = false; u.banReason = ""; writeUsers(users); }
}
function deleteUser(id) {
    const users = readUsers().filter(u => u.id !== id);
    writeUsers(users);
    for (const [tok, s] of sessions.entries()) if (s.userId === id) sessions.delete(tok);
    const keys = readKeys().filter(k => k.userId !== id);
    writeKeys(keys);
    saveSessions();
}
function getActiveSessions() { return Array.from(sessions.values()); }
function updateLastSeen(userId) {
    const users = readUsers();
    const u = users.find(x => x.id === userId);
    if (u) { u.lastSeen = new Date().toISOString(); writeUsers(users); }
}
function updateUserInfo(userId, data) {
    const users = readUsers();
    const u = users.find(x => x.id === userId);
    if (u) { Object.assign(u, data); writeUsers(users); }
}

function createLicenseKey(label) {
    const key = generateKey();
    const userId = "user_" + Date.now() + "_" + crypto.randomBytes(3).toString("hex");
    const keys = readKeys();
    keys.push({ key, userId, label: label || "", createdAt: new Date().toISOString(), revoked: false });
    writeKeys(keys);
    ensureUserDataDir(userId);
    const users = readUsers();
    if (!users.find(u => u.id === userId)) {
        users.push({
            id: userId, username: "", botName: "", isAdmin: false, isBanned: false,
            banReason: "", createdAt: new Date().toISOString(), lastSeen: null,
            sessionStart: null, ip: null, userAgent: null, accountId: null,
        });
        writeUsers(users);
    }
    return { key, userId };
}
function revokeKey(key) {
    const keys = readKeys();
    const k = keys.find(x => x.key === key);
    if (k) { k.revoked = true; writeKeys(keys); }
}

module.exports = {
    init, validateKey, getOrCreateUserByKey,
    createSession, getSession, getSessionFromReq, getTokenFromReq, destroySession,
    getAllUsers, getUser, banUser, unbanUser, deleteUser,
    getActiveSessions, updateLastSeen, updateUserInfo,
    getUserDataDir, ensureUserDataDir,
    createLicenseKey, revokeKey, readKeys,
    ADMIN_ID, ADMIN_KEY,
};
