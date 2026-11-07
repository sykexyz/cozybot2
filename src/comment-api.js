"use strict";

/**
 * Mass comment sender adapter for fca-riyad.
 * Adds postComment() and reactToComment() to the api using the Facebook
 * mobile Graph API endpoints (same mechanism used internally by FCA libs).
 * This works on top of fca-riyad's session (cookie jar / ctx).
 */

function buildCookieString(jar) {
    try {
        const url = "https://www.facebook.com";
        const cookies = jar.getCookiesSync(url);
        return cookies.map(c => `${c.key}=${c.value}`).join("; ");
    } catch (_) { return ""; }
}

function getFbDtsg(ctx) {
    if (ctx && ctx.fb_dtsg) return ctx.fb_dtsg;
    if (ctx && ctx.globalOptions && ctx.globalOptions.fb_dtsg) return ctx.globalOptions.fb_dtsg;
    return null;
}

async function postComment(api, ctx, postID, text) {
    const jar = ctx.jar || (api.getAppState && { getCookiesSync: () => [] });
    const cookieStr = buildCookieString(jar);
    const fb_dtsg = getFbDtsg(ctx) || "";
    const userID = ctx.userID || ctx.i_userID || "";

    if (!postID || !text) throw new Error("postID and text are required");

    const params = new URLSearchParams();
    params.append("comment_text", text);
    params.append("fb_dtsg", fb_dtsg);
    params.append("__user", userID);
    params.append("__a", "1");
    params.append("__req", "1b");
    params.append("__rev", "1015919737");

    const url = `https://mbasic.facebook.com/a/comment.php?ft_ent_identifier=${encodeURIComponent(postID)}`;

    const resp = await fetch(url, {
        method: "POST",
        headers: {
            "Cookie": cookieStr,
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
            "Referer": `https://mbasic.facebook.com/story.php?story_fbid=${postID}`,
            "Origin": "https://mbasic.facebook.com",
        },
        body: params.toString(),
        redirect: "manual",
    });

    // mbasic comment endpoint returns 302 on success
    if (resp.status === 302 || resp.status === 200) {
        return { success: true, postID, text, status: resp.status };
    }
    const body = await resp.text().catch(() => "");
    if (body.includes("comment_text") || body.toLowerCase().includes("checkpoint") || body.toLowerCase().includes("login")) {
        throw new Error("Comment may have failed (checkpoint/login page detected)");
    }
    return { success: true, postID, text, status: resp.status };
}

async function reactToComment(api, ctx, commentID, reaction) {
    // reaction: like, love, haha, wow, sad, angry (mapped to type codes)
    const reactionMap = { like: 1, love: 2, wow: 3, haha: 4, sad: 7, angry: 8 };
    const type = reactionMap[String(reaction || "like").toLowerCase()] || 1;
    const jar = ctx.jar || (api.getAppState && { getCookiesSync: () => [] });
    const cookieStr = buildCookieString(jar);
    const fb_dtsg = getFbDtsg(ctx) || "";
    const userID = ctx.userID || ctx.i_userID || "";

    const params = new URLSearchParams();
    params.append("fb_dtsg", fb_dtsg);
    params.append("__user", userID);
    params.append("__a", "1");

    // Use ufi reaction endpoint
    const url = `https://mbasic.facebook.com/reactions/picker/?ft_id=${encodeURIComponent(commentID)}&reaction_type=${type}`;
    const resp = await fetch(url, {
        method: "GET",
        headers: {
            "Cookie": cookieStr,
            "User-Agent": "Mozilla/5.0 (Linux; Android 12; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
            "Referer": "https://mbasic.facebook.com/",
        },
        redirect: "manual",
    });
    if (resp.status >= 200 && resp.status < 400) {
        return { success: true, commentID, reaction, status: resp.status };
    }
    throw new Error(`React failed with status ${resp.status}`);
}

function attachCommentApi(api, ctx) {
    api.postComment = (postID, text) => postComment(api, ctx, postID, text);
    api.reactToComment = (commentID, reaction) => reactToComment(api, ctx, commentID, reaction);
    return api;
}

module.exports = { attachCommentApi, postComment, reactToComment };
