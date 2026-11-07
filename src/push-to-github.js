const https = require("https");
const fs    = require("fs");
const path  = require("path");

const OWNER  = "sykexyz";
const REPO   = "cozybot2";
const BRANCH = "main";
const TOKEN  = process.env.GITHUB_TOKEN;

function ghRequest(method, endpoint, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const opts = {
            hostname: "api.github.com",
            path:     `/repos/${OWNER}/${REPO}${endpoint}`,
            method,
            headers: {
                "Authorization": `Bearer ${TOKEN}`,
                "User-Agent":    "dummyl-push",
                "Accept":        "application/vnd.github+json",
                "Content-Type":  "application/json",
                ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
            },
        };
        const req = https.request(opts, res => {
            let raw = "";
            res.on("data", c => raw += c);
            res.on("end", () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
                catch(_) { resolve({ status: res.statusCode, body: raw }); }
            });
        });
        req.on("error", reject);
        if (data) req.write(data);
        req.end();
    });
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".local", "attached_assets", ".polydev", "tmp"]);
const SKIP_FILES = new Set([".env", "fbstate.json", "repo.bundle"]);
function walkDir(dir, base) {
    let files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel  = path.join(base, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            // skip sensitive data subdirs, keep data/.gitkeep
            if (rel === "data" || rel.startsWith("data/") || rel.startsWith("data\\")) {
                if (entry.name === "uploads") files = files.concat(walkDir(full, rel));
                continue;
            }
            files = files.concat(walkDir(full, rel));
        } else {
            if (SKIP_FILES.has(entry.name)) continue;
            // skip sensitive json in data/
            if (/^data[\/\\]/.test(rel) && entry.name !== ".gitkeep") continue;
            files.push({ full, rel });
        }
    }
    return files;
}

async function main() {
    if (!TOKEN) { console.error("ERROR: GITHUB_TOKEN not set"); process.exit(1); }
    const root = path.join(__dirname, "..");

    console.log("Fetching current HEAD...");
    const refRes = await ghRequest("GET", `/git/ref/heads/${BRANCH}`);
    let baseCommitSha = null;
    let baseTreeSha = null;
    if (refRes.status === 200) {
        baseCommitSha = refRes.body.object.sha;
        console.log("Base commit:", baseCommitSha);
        const getRes = await ghRequest("GET", `/git/commits/${baseCommitSha}`);
        baseTreeSha = getRes.body?.tree?.sha || null;
    } else if (refRes.status === 404 || refRes.status === 409) {
        console.log("Repo/branch empty — creating initial commit.");
    } else {
        console.error("Failed to get ref:", refRes.status, refRes.body);
        process.exit(1);
    }

    const files = walkDir(root, "");
    console.log(`Creating ${files.length} blobs...`);

    const treeItems = [];
    for (const f of files) {
        const content = fs.readFileSync(f.full);
        const blobRes = await ghRequest("POST", "/git/blobs", {
            content:  content.toString("base64"),
            encoding: "base64",
        });
        if (blobRes.status !== 201) { console.error("Blob failed:", f.rel, blobRes.body); continue; }
        treeItems.push({ path: f.rel.replace(/\\/g, "/"), mode: "100644", type: "blob", sha: blobRes.body.sha });
    }

    console.log("Creating tree...");
    const treeBody = { tree: treeItems };
    if (baseTreeSha) treeBody.base_tree = baseTreeSha;
    const treeRes = await ghRequest("POST", "/git/trees", treeBody);
    if (treeRes.status !== 201) { console.error("Tree failed:", treeRes.body); process.exit(1); }

    console.log("Creating commit...");
    const commitBody = {
        message: "feat: swap FCA to fca-riyad (anti-detection) + mass comment sender",
        tree:    treeRes.body.sha,
    };
    if (baseCommitSha) commitBody.parents = [baseCommitSha];
    const commitRes = await ghRequest("POST", "/git/commits", commitBody);
    if (commitRes.status !== 201) { console.error("Commit failed:", commitRes.body); process.exit(1); }

    console.log("Updating ref...");
    let refUpdate;
    if (baseCommitSha) {
        refUpdate = await ghRequest("PATCH", `/git/refs/heads/${BRANCH}`, { sha: commitRes.body.sha, force: false });
    } else {
        refUpdate = await ghRequest("POST", `/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commitRes.body.sha });
    }
    if (refUpdate.status !== 200 && refUpdate.status !== 201) { console.error("Ref update failed:", refUpdate.body); process.exit(1); }

    console.log("Done! Pushed to", BRANCH, "—", commitRes.body.sha);
}

main().catch(e => { console.error(e); process.exit(1); });
