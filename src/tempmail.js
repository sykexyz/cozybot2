"use strict";

const axios = require("axios");

const BASE = "https://api.mail.tm";

class TempMail {
    constructor() {
        this.address  = null;
        this.password = null;
        this.token    = null;
        this.accountId = null;
    }

    async getDomains() {
        const r = await axios.get(`${BASE}/domains`, { timeout: 15000 });
        return r.data["hydra:member"] || [];
    }

    async createInbox() {
        const domains = await this.getDomains();
        if (!domains.length) throw new Error("No domains available.");
        const domain  = domains[0].domain;
        const name    = Math.random().toString(36).slice(2, 10);
        this.address  = `${name}@${domain}`;
        this.password = Math.random().toString(36).slice(2, 14);

        const reg = await axios.post(`${BASE}/accounts`, {
            address:  this.address,
            password: this.password
        }, { timeout: 15000 });
        this.accountId = reg.data.id;

        const auth = await axios.post(`${BASE}/token`, {
            address:  this.address,
            password: this.password
        }, { timeout: 15000 });
        this.token = auth.data.token;

        return { address: this.address, id: this.accountId };
    }

    async listMails() {
        if (!this.token) throw new Error("No active inbox.");
        const r = await axios.get(`${BASE}/messages`, {
            headers: { Authorization: `Bearer ${this.token}` },
            timeout: 15000
        });
        return r.data["hydra:member"] || [];
    }

    async getMail(id) {
        if (!this.token) throw new Error("No active inbox.");
        const r = await axios.get(`${BASE}/messages/${id}`, {
            headers: { Authorization: `Bearer ${this.token}` },
            timeout: 15000
        });
        return r.data;
    }

    async deleteInbox() {
        if (!this.token || !this.accountId) throw new Error("No active inbox.");
        await axios.delete(`${BASE}/accounts/${this.accountId}`, {
            headers: { Authorization: `Bearer ${this.token}` },
            timeout: 15000
        });
        this.address = this.password = this.token = this.accountId = null;
        return true;
    }
}

const sessions = {};

function getSession(threadID) {
    if (!sessions[threadID]) sessions[threadID] = new TempMail();
    return sessions[threadID];
}

async function handleTempMail(api, args, threadID) {
    const sub = (args[1] || "").toLowerCase();

    if (!sub || sub === "create" || sub === "new") {
        const tm = new TempMail();
        sessions[threadID] = tm;
        api.sendMessage("Creating temp email... please wait.", threadID, () => {});
        try {
            const info = await tm.createInbox();
            api.sendMessage(
                `Temp email created!\n\nAddress: ${info.address}\n\nUse !tempmail check to view emails.\nUse !tempmail delete to remove inbox.`,
                threadID, () => {}
            );
        } catch (e) {
            api.sendMessage(`Failed to create temp email: ${e.message}`, threadID, () => {});
        }
        return;
    }

    if (sub === "check" || sub === "inbox") {
        const tm = getSession(threadID);
        if (!tm.token) {
            api.sendMessage("No active temp inbox. Use !tempmail to create one.", threadID, () => {});
            return;
        }
        try {
            const mails = await tm.listMails();
            if (!mails.length) {
                api.sendMessage(`Inbox: ${tm.address}\n\nNo emails yet. Check again in a moment.`, threadID, () => {});
                return;
            }
            let txt = `Inbox: ${tm.address}\n${mails.length} email(s):\n\n`;
            mails.slice(0, 5).forEach((m, i) => {
                txt += `${i + 1}. From: ${m.from?.address || "unknown"}\n   Subject: ${m.subject || "(no subject)"}\n   ID: ${m.id}\n\n`;
            });
            txt += `Use !tempmail read <ID> to read an email.`;
            api.sendMessage(txt, threadID, () => {});
        } catch (e) {
            api.sendMessage(`Failed to fetch emails: ${e.message}`, threadID, () => {});
        }
        return;
    }

    if (sub === "read") {
        const id = args[2];
        if (!id) { api.sendMessage("Usage: !tempmail read <message-id>", threadID, () => {}); return; }
        const tm = getSession(threadID);
        if (!tm.token) { api.sendMessage("No active temp inbox.", threadID, () => {}); return; }
        try {
            const mail = await tm.getMail(id);
            const body = mail.text || mail.html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "(empty)";
            api.sendMessage(
                `From: ${mail.from?.address || "unknown"}\nSubject: ${mail.subject || "(no subject)"}\n\n${body.slice(0, 800)}`,
                threadID, () => {}
            );
        } catch (e) {
            api.sendMessage(`Failed to read email: ${e.message}`, threadID, () => {});
        }
        return;
    }

    if (sub === "delete" || sub === "del") {
        const tm = getSession(threadID);
        if (!tm.token) { api.sendMessage("No active temp inbox.", threadID, () => {}); return; }
        try {
            await tm.deleteInbox();
            api.sendMessage("Temp inbox deleted.", threadID, () => {});
        } catch (e) {
            api.sendMessage(`Failed to delete inbox: ${e.message}`, threadID, () => {});
        }
        return;
    }

    api.sendMessage(
        "Temp Mail commands:\n!tempmail — create new inbox\n!tempmail check — view emails\n!tempmail read <id> — read an email\n!tempmail delete — remove inbox",
        threadID, () => {}
    );
}

module.exports = { handleTempMail };
