"use strict";

const https = require("https");
const http  = require("http");
const { URL } = require("url");

function cookieStringFromAppState(appState) {
    if (!Array.isArray(appState)) return "";
    return appState.map(c => `${c.key}=${c.value}`).join("; ");
}

function computeJazoest(fbDtsg) {
    if (!fbDtsg) return "";
    let t = "2";
    for (let i = 0; i < fbDtsg.length; i++) t += fbDtsg.charCodeAt(i);
    return t;
}

function fetchText(urlStr, { method = "GET", headers = {}, body = null, cookie = "", redirect = "follow", timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
        try {
            const u = new URL(urlStr);
            const lib = u.protocol === "https:" ? https : http;
            const opts = {
                method,
                hostname: u.hostname,
                path: u.pathname + (u.search || ""),
                headers: {
                    "User-Agent": "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9",
                    ...(cookie ? { Cookie: cookie } : {}),
                    ...headers,
                },
                timeout,
            };
            const req = lib.request(opts, (res) => {
                if (redirect === "follow" && [301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
                    const loc = new URL(res.headers.location, urlStr).toString();
                    res.resume();
                    return resolve(fetchText(loc, { method: "GET", headers, body: null, cookie, redirect, timeout }));
                }
                let data = "";
                res.setEncoding("utf8");
                res.on("data", c => data += c);
                res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data, finalUrl: urlStr }));
            });
            req.on("timeout", () => { req.destroy(); reject(new Error("Request timeout")); });
            req.on("error", reject);
            if (body) req.write(body);
            req.end();
        } catch (e) { reject(e); }
    });
}

function extractFbDtsg(html) {
    if (!html) return null;
    let m = html.match(/name="fb_dtsg"\s+value="([^"]+)"/) || html.match(/"token"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
    m = html.match(/\["DTSGInitialData",\[\],\{"token":"([^"]+)"/);
    return m ? m[1] : null;
}

function extractPostIdFromUrl(finalUrl, html) {
    const tryStr = (s) => {
        if (!s) return null;
        let m = s.match(/[?&](?:story_fbid|fbid)=(\d+)/) || s.match(/\/posts\/(\d+)/) || s.match(/\/videos\/(\d+)/) || s.match(/\/permalink\/(\d+)/);
        if (m) return m[1];
        m = s.match(/\/(\d{10,})(?:[/?#]|$)/);
        return m ? m[1] : null;
    };
    let id = tryStr(finalUrl);
    if (id) return id;
    if (html) {
        let m = html.match(/"top_level_post_id"\s*:\s*"(\d+)"/) || html.match(/"ft_ent_identifier"\s*:\s*"?(\d+)"?/) || html.match(/story_fbid=(\d+)/) || html.match(/name="ft_ent_identifier"\s+value="(\d+)"/);
        if (m) return m[1];
        id = tryStr(html.match(/https:\/\/[^"'\s<>]*story_fbid=\d+[^"'\s<>]*/)?.[0]);
        if (id) return id;
    }
    return null;
}

async function getTokens(api) {
    const appState = typeof api.getAppState === "function" ? api.getAppState() : [];
    const cookie = cookieStringFromAppState(appState);
    const userID = typeof api.getCurrentUserID === "function" ? api.getCurrentUserID() : "";
    if (!cookie) throw new Error("No session cookies (appState empty). Re-login the bot.");
    // Try to get fb_dtsg from mbasic home
    let res = await fetchText("https://mbasic.facebook.com/", { cookie });
    let fb_dtsg = extractFbDtsg(res.body);
    if (!fb_dtsg) {
        res = await fetchText("https://m.facebook.com/", { cookie });
        fb_dtsg = extractFbDtsg(res.body);
    }
    if (!fb_dtsg) throw new Error("Could not get fb_dtsg token (session may be expired/checkpoint).");
    const jazoest = computeJazoest(fb_dtsg);
    return { cookie, fb_dtsg, jazoest, userID };
}

async function resolvePostId(postRef, cookie) {
    const s = String(postRef || "").trim();
    if (/^\d{6,}$/.test(s)) return s;
    // try to extract from URL directly
    let id = extractPostIdFromUrl(s, "");
    if (id && /^\d{6,}$/.test(id)) return id;
    // resolve via fetch (handles /share/ links)
    if (/^https?:\/\//i.test(s)) {
        const res = await fetchText(s, { cookie, redirect: "follow" });
        id = extractPostIdFromUrl(res.finalUrl || s, res.body);
        if (id) return id;
        // last resort: try mbasic version
        const mb = s.replace("://www.facebook.com", "://mbasic.facebook.com").replace("://m.facebook.com", "://mbasic.facebook.com");
        if (mb !== s) {
            const res2 = await fetchText(mb, { cookie, redirect: "follow" });
            id = extractPostIdFromUrl(res2.finalUrl || mb, res2.body);
            if (id) return id;
        }
    }
    return null;
}

async function postComment(api, ctx, postRef, text) {
    if (!postRef || !text) throw new Error("post URL/ID and text are required");
    const { cookie, fb_dtsg, jazoest, userID } = await getTokens(api);
    const postID = await resolvePostId(postRef, cookie);
    if (!postID) throw new Error(`Hindi makuha ang post ID mula sa link: ${postRef} (gumamit ng direct post URL na may /posts/<id> o numeric ID)`);

    // Try mbasic comment endpoint
    const form = new URLSearchParams();
    form.append("fb_dtsg", fb_dtsg);
    form.append("jazoest", jazoest);
    form.append("comment_text", String(text).trim());

    const url = `https://mbasic.facebook.com/a/comment.php?fs=8&actionsource=2&comment_logging&ft_ent_identifier=${encodeURIComponent(postID)}`;
    const res = await fetchText(url, {
        method: "POST",
        cookie,
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "Origin": "https://mbasic.facebook.com",
            "Referer": `https://mbasic.facebook.com/story.php?story_fbid=${postID}&id=${postID}`,
        },
        body: form.toString(),
        redirect: "manual",
    });

    if (res.status === 302 || res.status === 303 || res.status === 200) {
        const b = (res.body || "").toLowerCase();
        if (b.includes("login") && b.includes("password") || b.includes("checkpoint") || b.includes("you can't use this feature")) {
            throw new Error("Comment failed: session checkpoint/restricted (fb_dtsg/cookie issue).");
        }
        return { success: true, postID, status: res.status };
    }
    throw new Error(`Comment request failed (HTTP ${res.status}).`);
}

async function reactToComment(api, ctx, commentID, reaction) {
    return { success: false, error: "reactToComment not implemented for this session type" };
}

function attachCommentApi(api, ctx) {
    api.postComment = (postID, text) => postComment(api, ctx, postID, text);
    api.reactToComment = (commentID, reaction) => reactToComment(api, ctx, commentID, reaction);
    return api;
}

module.exports = { attachCommentApi, postComment, reactToComment };
