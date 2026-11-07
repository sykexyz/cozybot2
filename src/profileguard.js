"use strict";

const axios = require("axios");
const fs    = require("fs");

function buildCookieString(fbstatePath) {
    try {
        const state = JSON.parse(fs.readFileSync(fbstatePath, "utf8"));
        if (!Array.isArray(state)) return "";
        return state.map(c => `${c.key}=${c.value}`).join("; ");
    } catch (_) { return ""; }
}

async function getFbDtsg(cookieStr) {
    const r = await axios.get("https://www.facebook.com/", {
        headers: {
            "Cookie":     cookieStr,
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Accept":     "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        timeout: 20000,
        maxRedirects: 5
    });
    const html  = r.data || "";
    let match   = /"fb_dtsg"\s*:\s*\{"value"\s*:\s*"([^"]+)"/.exec(html);
    if (!match) match = /"fb_dtsg"\s*:\s*"([^"]+)"/.exec(html);
    if (!match) match = /name="fb_dtsg"\s+value="([^"]+)"/.exec(html);
    return match ? match[1] : null;
}

async function getUserIdFromCookie(cookieStr) {
    const match = /c_user=(\d+)/.exec(cookieStr);
    return match ? match[1] : null;
}

async function toggleProfileGuard(fbstatePath, enable) {
    const cookieStr = buildCookieString(fbstatePath);
    if (!cookieStr) throw new Error("Could not read fbstate cookies.");

    const userId = await getUserIdFromCookie(cookieStr);
    if (!userId) throw new Error("Could not extract user ID from cookies.");

    const fbDtsg = await getFbDtsg(cookieStr);
    if (!fbDtsg) throw new Error("Could not fetch fb_dtsg token.");

    const params = new URLSearchParams();
    params.append("__a", "1");
    params.append("__comet_req", "1");
    params.append("doc_id", "7369367446407795");
    params.append("variables", JSON.stringify({
        input: { is_shielded: enable, actor_id: userId }
    }));
    params.append("av",      userId);
    params.append("__user",  userId);
    params.append("fb_dtsg", fbDtsg);
    params.append("fb_api_req_friendly_name", "IsShieldedSetMutation");

    const res = await axios.post("https://www.facebook.com/api/graphql/", params.toString(), {
        headers: {
            "Content-Type":        "application/x-www-form-urlencoded",
            "X-FB-Friendly-Name":  "IsShieldedSetMutation",
            "Cookie":              cookieStr,
            "User-Agent":          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "Origin":              "https://www.facebook.com",
            "Referer":             "https://www.facebook.com/"
        },
        timeout: 20000
    });

    const text     = (typeof res.data === "string" ? res.data : JSON.stringify(res.data)).replace(/^for\s*\(;;\);/, "");
    const parsed   = JSON.parse(text);
    if (parsed.errors && parsed.errors.length) throw new Error(parsed.errors[0].message || "GraphQL error");
    return { success: true, userId };
}

module.exports = { toggleProfileGuard };
