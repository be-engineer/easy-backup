var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => SelfSignedSyncPlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");

// diff.ts
var MAX_CELLS = 4e6;
function splitLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => l.endsWith("\r") ? l.slice(0, -1) : l);
}
function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i2 = n - 1; i2 >= 0; i2--) {
    const row = i2 * w;
    const next = row + w;
    for (let j2 = m - 1; j2 >= 0; j2--) {
      dp[row + j2] = a[i2] === b[j2] ? dp[next + j2 + 1] + 1 : Math.max(dp[next + j2], dp[row + j2 + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: " ", line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      ops.push({ op: "-", line: a[i] });
      i++;
    } else {
      ops.push({ op: "+", line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: "-", line: a[i++] });
  while (j < m) ops.push({ op: "+", line: b[j++] });
  return ops;
}
function hunkify(ops, aLabel, bLabel, context) {
  const out = [`--- ${aLabel}`, `+++ ${bLabel}`];
  const oldBefore = new Int32Array(ops.length + 1);
  const newBefore = new Int32Array(ops.length + 1);
  for (let i = 0; i < ops.length; i++) {
    oldBefore[i + 1] = oldBefore[i] + (ops[i].op === "+" ? 0 : 1);
    newBefore[i + 1] = newBefore[i] + (ops[i].op === "-" ? 0 : 1);
  }
  const hunks = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op === " ") continue;
    const start = Math.max(0, i - context);
    const end = Math.min(ops.length, i + context + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  }
  for (const [s, e] of hunks) {
    const aCount = oldBefore[e] - oldBefore[s];
    const bCount = newBefore[e] - newBefore[s];
    const aStart = aCount === 0 ? oldBefore[s] : oldBefore[s] + 1;
    const bStart = bCount === 0 ? newBefore[s] : newBefore[s] + 1;
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let i = s; i < e; i++) out.push(ops[i].op + ops[i].line);
  }
  return out;
}
function unifiedDiff(aText, bText, aLabel, bLabel, context = 3) {
  const a = splitLines(aText);
  const b = splitLines(bText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (midA.length === 0 && midB.length === 0) return "";
  if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) return null;
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ op: " ", line: a[i] });
  ops.push(...lcsOps(midA, midB));
  for (let i = endA; i < a.length; i++) ops.push({ op: " ", line: a[i] });
  return hunkify(ops, aLabel, bLabel, context).join("\n");
}
function looksLikeText(buf) {
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return false;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch (e) {
    return false;
  }
}
function decodeText(buf) {
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(buf));
}

// main.ts
var TOMBSTONE_FILE = ".easy-sync-deleted.json";
var TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1e3;
var TOMBSTONE_SKEW_MS = 5 * 60 * 1e3;
var CONFIG_ALWAYS_SKIP = ["workspace.json", "workspace-mobile.json", "cache/", "plugins/easy-backup/", ".git/"];
function sameBytes(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
var DEFAULT_SETTINGS = {
  serverUrl: "",
  username: "",
  password: "",
  remotePath: "/obsidian",
  syncOnStartup: false,
  syncStrategy: "merge",
  syncDeletions: true,
  concurrency: 3,
  deleteConfirmThreshold: 20,
  forceUnlockLocks: true,
  syncConfig: false,
  syncPluginData: false,
  configExcludes: ""
};
var _SelfSignedSyncPlugin = class _SelfSignedSyncPlugin extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.state = {};
    this.pendingDeletes = {};
    this.knownDirs = /* @__PURE__ */ new Set();
    this.syncing = false;
    this.aborted = false;
    this.configTouched = false;
    this.ribbonEl = null;
    this.settingTab = null;
    this.doneCount = 0;
    this.totalCount = 0;
    this.activeModal = null;
    this.passwordSecretId = "easy-backup-password";
  }
  async onload() {
    console.log("[easy-backup] loaded v" + this.manifest.version);
    await this.loadSettings();
    await this.loadState();
    this.ribbonEl = this.addRibbonIcon("cloud-upload", "easy backup", (evt) => {
      if (this.syncing) {
        this.toggleSync();
      } else {
        this.showSyncMenu(evt);
      }
    });
    this.updateRibbon();
    const style = document.createElement("style");
    style.textContent = ".easy-sync-spinning svg { animation: easy-sync-rotate 1s linear infinite; } @keyframes easy-sync-rotate { to { transform: rotate(360deg); } }";
    document.head.appendChild(style);
    this.register(() => style.remove());
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync() });
    this.addCommand({ id: "stop-sync", name: "Stop sync", callback: () => {
      this.aborted = true;
      new import_obsidian.Notice("Stopping sync...");
    } });
    this.settingTab = new SyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => this.sync());
    }
  }
  async loadSettings() {
    const d = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, d);
    const secret = this.app.secretStorage.getSecret(this.passwordSecretId);
    if (secret !== null) this.settings.password = secret;
    else if (d.password) {
      this.settings.password = d.password;
      this.app.secretStorage.setSecret(this.passwordSecretId, d.password);
      delete d.password;
      await this.saveData(d);
    }
  }
  async saveSettings() {
    const d = await this.loadData() || {};
    const password = this.settings.password;
    const plain = { ...this.settings };
    delete plain.password;
    delete plain.syncState;
    delete plain.lastSync;
    delete plain.pendingDeletes;
    Object.assign(d, plain);
    delete d.password;
    if (password) this.app.secretStorage.setSecret(this.passwordSecretId, password);
    await this.saveData(d);
  }
  async loadState() {
    const d = await this.loadData();
    this.state = (d == null ? void 0 : d.syncState) || {};
    this.lastSync = d == null ? void 0 : d.lastSync;
    this.pendingDeletes = (d == null ? void 0 : d.pendingDeletes) || {};
  }
  async saveState() {
    const d = await this.loadData() || {};
    d.syncState = this.state;
    d.lastSync = this.lastSync;
    d.pendingDeletes = this.pendingDeletes;
    await this.saveData(d);
  }
  headers(extra) {
    const h = { ...extra };
    if (this.settings.username) h["Authorization"] = "Basic " + btoa(this.settings.username + ":" + this.settings.password);
    return h;
  }
  base() {
    return this.settings.serverUrl.replace(/\/+$/, "") + (this.settings.remotePath || "").replace(/\/+$/, "");
  }
  /** Pull the useful bits out of a Sabre/Nextcloud error body. */
  davDetail(r) {
    const t = (r.text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const pick = (name) => {
      const m = new RegExp(`<(?:[\\w.-]+:)?${name}[^>]*>([^<]*)<`, "i").exec(t);
      return m ? m[1].trim() : "";
    };
    const ex = pick("exception");
    const msg = pick("message");
    const parts = [ex, msg].filter(Boolean);
    const detail = parts.length ? parts.join(": ") : t.slice(0, 200);
    return detail ? ` (${detail})` : "";
  }
  httpError(what, r) {
    let hint = "";
    if (r.status === 423) hint = " \u2014 the file is locked on the server (Nextcloud files_lock); close it in the Nextcloud web editor or wait for the lock to expire";
    if (r.status === 401) hint = " \u2014 check username/password";
    if (r.status === 403) hint = " \u2014 permission denied";
    if (r.status === 409) hint = " \u2014 a remote folder with the same name may exist";
    if (r.status === 507) hint = " \u2014 server storage quota exceeded";
    return new Error(`${what} failed: HTTP ${r.status}${this.davDetail(r)}${hint}`);
  }
  /** Ask Nextcloud who holds the lock on a path and, if possible, force-unlock it. */
  async probeLock(url) {
    try {
      const xml = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns" xmlns:oc="http://owncloud.org/ns"><d:prop><d:lockdiscovery/><oc:fileid/><nc:lock/><nc:lock-owner/><nc:lock-owner-displayname/><nc:lock-time/><nc:lock-timeout/></d:prop></d:propfind>';
      const buf = new TextEncoder().encode(xml);
      const r = await this.req("PROPFIND", url, buf.buffer, { Depth: "0", "Content-Type": "application/xml" });
      console.log("[easy-backup] lock probe:", r.status, r.text.slice(0, 800));
      const pick = (name) => {
        const m = new RegExp(`<(?:[\\w.-]+:)?${name}[^>]*>([^<]*)<`, "i").exec(r.text);
        return m ? m[1].trim() : "";
      };
      const fileId = parseInt(pick("fileid"), 10);
      const parts = [];
      const lockState = pick("lock");
      const owner = pick("lock-owner-displayname") || pick("lock-owner");
      if (owner) parts.push("owner=" + owner);
      const t = parseInt(pick("lock-time"), 10);
      if (Number.isFinite(t) && t > 0) parts.push("since=" + new Date(t * 1e3).toLocaleString());
      const timeout = pick("lock-timeout");
      if (timeout) parts.push("timeout=" + timeout);
      return {
        fileId: Number.isFinite(fileId) && fileId > 0 ? fileId : void 0,
        desc: parts.length ? " [" + parts.join(", ") + "]" : "",
        locked: parts.length > 0 || lockState !== ""
      };
    } catch (e) {
      console.log("[easy-backup] lock probe failed:", (e == null ? void 0 : e.message) || e);
      return { desc: "", locked: false };
    }
  }
  /** Release a Nextcloud files_lock lock (OCS API). The file owner may always do this. */
  async unlockRemoteLock(url) {
    const probe = await this.probeLock(url);
    const path = url.slice(this.base().length + 1);
    if (!probe.fileId) return { ok: false, note: probe.desc };
    try {
      const rootMatch = /^(.*?)\/remote\.php\//.exec(this.settings.serverUrl);
      const root = rootMatch ? rootMatch[1] : new URL(this.settings.serverUrl).origin;
      const target = `${root}/ocs/v2.php/apps/files_lock/lock/${probe.fileId}?format=json`;
      const r = await this.req("DELETE", target, void 0, { "OCS-APIRequest": "true", "Accept": "application/json" });
      console.log("[easy-backup] unlock", probe.fileId, r.status, r.text.slice(0, 300));
      if (r.status >= 200 && r.status < 300) return { ok: true, note: path + probe.desc };
      return { ok: false, note: probe.desc + " (unlock HTTP " + r.status + ")" };
    } catch (e) {
      return { ok: false, note: probe.desc + " (unlock failed: " + ((e == null ? void 0 : e.message) || e) + ")" };
    }
  }
  /**
   * Request with lock recovery: a 423 from Nextcloud files_lock is permanent until
   * somebody releases the lock, so probe, force-unlock, then retry once.
   */
  async reqLockAware(method, url, body, headers = {}) {
    let r = await this.req(method, url, body, headers);
    if (r.status !== 423 || !this.settings.forceUnlockLocks || this.aborted) return r;
    const res = await this.unlockRemoteLock(url);
    if (!res.ok) {
      console.warn("[easy-backup] could not unlock", url, res.note);
      return r;
    }
    new import_obsidian.Notice("Unlocked server lock: " + res.note);
    console.log("[easy-backup] unlocked, retrying", method, url);
    r = await this.req(method, url, body, headers);
    return r;
  }
  async req(method, url, body, headers = {}) {
    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      const r = await this.reqNet(method, url, body, headers);
      if (_SelfSignedSyncPlugin.RETRYABLE_STATUS.has(r.status) && attempt < MAX_RETRIES && !this.aborted) {
        const delay = 600 * (attempt + 1);
        console.warn(`[easy-backup] HTTP ${r.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms:`, method, url, this.davDetail(r));
        await new Promise((res) => setTimeout(res, delay));
        continue;
      }
      if (r.status >= 400) console.warn("[easy-backup] HTTP", r.status, method, url, r.text.slice(0, 300));
      return r;
    }
  }
  /** one request, retrying only socket-level hiccups (DNS, reset, refused) */
  async reqNet(method, url, body, headers = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.reqOnce(method, url, body, headers);
      } catch (e) {
        const code = (e == null ? void 0 : e.code) || "";
        const transient = ["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"].includes(code);
        if (transient && attempt < 2) {
          console.log("[easy-backup] retry", attempt + 1, method, url, code);
          await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }
  async reqOnce(method, url, body, headers = {}) {
    const TIMEOUT_MS = 6e4;
    const hdrs = this.headers(headers);
    if (body) hdrs["Content-Length"] = String(body.byteLength);
    let nodeRequest = null;
    if (typeof require === "function") {
      try {
        const mod = url.startsWith("https") ? require("https") : require("http");
        if (mod) {
          const u = new URL(url);
          console.log("[easy-backup] req (node):", method, url);
          let reqRef = null;
          nodeRequest = new Promise((resolve, reject) => {
            const req = reqRef = mod.request({
              hostname: u.hostname,
              port: u.port || (url.startsWith("https") ? 443 : 80),
              path: u.pathname + u.search,
              method,
              headers: hdrs,
              rejectUnauthorized: false,
              timeout: TIMEOUT_MS
            }, (res) => {
              console.log("[easy-backup] response:", res.statusCode, url);
              const chunks = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () => {
                console.log("[easy-backup] response done:", res.statusCode, url);
                const buf = Buffer.concat(chunks);
                resolve({ status: res.statusCode, text: buf.toString("utf8"), arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
              });
            });
            req.on("error", (e) => {
              console.error("[easy-backup] req error:", method, url, e);
              reject(e);
            });
            req.on("timeout", () => {
              console.error("[easy-backup] req timeout:", method, url);
              req.destroy();
              reject(new Error("Request timed out after " + TIMEOUT_MS / 1e3 + "s"));
            });
            if (body) req.write(Buffer.from(body));
            req.end();
          });
          nodeRequest = Promise.race([
            nodeRequest,
            new Promise((_, reject) => setTimeout(() => {
              try {
                reqRef == null ? void 0 : reqRef.destroy();
              } catch (e) {
              }
              reject(new Error("Hard timeout after " + TIMEOUT_MS / 1e3 + "s: " + method + " " + url));
            }, TIMEOUT_MS + 5e3))
          ]);
        }
      } catch (e) {
        console.log("[easy-backup] require http/https not available, falling back:", (e == null ? void 0 : e.message) || e);
      }
    }
    if (nodeRequest) return nodeRequest;
    const timeoutPromise = new Promise(
      (_, reject) => setTimeout(() => reject(new Error("Request timed out after " + TIMEOUT_MS / 1e3 + "s")), TIMEOUT_MS)
    );
    try {
      const r = await Promise.race([
        (0, import_obsidian.requestUrl)({ url, method, body, headers: hdrs, throw: false }),
        timeoutPromise
      ]);
      return { status: r.status, text: r.text, arrayBuffer: r.arrayBuffer };
    } catch (e) {
      const msg = String((e == null ? void 0 : e.message) || e);
      const isCertError = /CertPathValidatorException|SSLHandshakeException|certificate|SSL|handshake|trust anchor/i.test(msg);
      if (isCertError) {
        const hint = "\\n\\nMobile tip: Obsidian's native request does not allow skipping certificate validation. Use a certificate signed by a public CA (desktop works fine with self-signed certs).";
        console.error("[easy-backup] mobile SSL error:", method, url, msg);
        throw new Error("SSL certificate not trusted: " + msg + hint);
      }
      throw e;
    }
  }
  // ---------- remote listing ----------
  async remoteList(dirUrl) {
    const res = await this.req("PROPFIND", dirUrl, void 0, { Depth: "infinity", "Content-Type": "application/xml" });
    const map = /* @__PURE__ */ new Map();
    if (res.status < 200 || res.status >= 300) throw this.httpError("PROPFIND", res);
    console.log("[easy-backup] PROPFIND bytes:", res.text.length, "responses:", (res.text.match(/<(?:[\w.-]+:)?response[\s>]/gi) || []).length - 1);
    const responses = res.text.split(/<(?:[\w.-]+:)?response[\s>]/i).slice(1);
    const base = new URL(dirUrl);
    for (const r of responses) {
      const hrefM = r.match(/<(?:[\w.-]+:)?href>([\s\S]*?)<\//i);
      if (!hrefM) continue;
      const entityMap = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
      const href = hrefM[1].trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => entityMap[e]);
      const isCollection = /<(?:[\w.-]+:)?collection[\s/>]/i.test(r);
      if (isCollection) continue;
      const mtimeM = r.match(/<(?:[\w.-]+:)?getlastmodified>([\s\S]*?)<\//i);
      const sizeM = r.match(/<(?:[\w.-]+:)?getcontentlength>([\s\S]*?)<\//i);
      const mtime = mtimeM ? Date.parse(mtimeM[1].trim()) : 0;
      const size = sizeM ? parseInt(sizeM[1].trim(), 10) : 0;
      const u = new URL(href, base);
      let rel = decodeURIComponent(u.pathname);
      const basePath = decodeURIComponent(new URL(dirUrl).pathname).replace(/\/+$/, "");
      if (rel.startsWith(basePath)) rel = rel.slice(basePath.length);
      rel = rel.replace(/^\/+/, "");
      if (!rel) continue;
      if (rel === TOMBSTONE_FILE) continue;
      map.set(rel, { mtime: isNaN(mtime) ? 0 : mtime, size });
    }
    return map;
  }
  async ensureRemoteDir(url) {
    if (this.knownDirs.has(url)) return;
    try {
      const r = await this.req("MKCOL", url);
      if (r.status >= 200 && r.status < 300 || r.status === 405) this.knownDirs.add(url);
    } catch (e) {
    }
  }
  isEncodedJunk(p) {
    return p.split("/").some((seg) => seg.length > 0 && /^(?:%[0-9A-Fa-f]{2})+$/.test(seg));
  }
  // ---------- tombstones (Joplin-style deletion records) ----------
  tombstoneUrl(base) {
    return base + "/" + TOMBSTONE_FILE;
  }
  textToBuffer(text) {
    return new TextEncoder().encode(text).buffer;
  }
  async readTombstones(base) {
    let res;
    try {
      res = await this.req("GET", this.tombstoneUrl(base));
    } catch (e) {
      throw new Error("Tombstone GET failed: " + ((e == null ? void 0 : e.message) || e));
    }
    if (res.status === 404) return { deletions: {}, existed: false };
    if (res.status < 200 || res.status >= 300) throw this.httpError("Tombstone GET", res);
    const out = {};
    try {
      const obj = JSON.parse(res.text);
      if (obj && typeof obj.deletions === "object") {
        for (const k of Object.keys(obj.deletions)) {
          const ts = Number(obj.deletions[k]);
          if (Number.isFinite(ts) && ts > 0) out[k] = ts;
        }
      }
    } catch (e) {
    }
    return { deletions: out, existed: true };
  }
  async writeTombstones(base, deletions) {
    const r = await this.req("PUT", this.tombstoneUrl(base), this.textToBuffer(JSON.stringify({ deletions })), { "Content-Type": "application/json" });
    if (r.status < 200 || r.status >= 300) throw this.httpError("Tombstone PUT", r);
  }
  async deleteTombstoneFile(base) {
    try {
      await this.req("DELETE", this.tombstoneUrl(base));
    } catch (e) {
    }
  }
  confirmMassDelete(localPaths, remotePaths) {
    const localCount = localPaths.length;
    const remoteCount = remotePaths.length;
    const total = localCount + remoteCount;
    const parts = [];
    if (localCount > 0) parts.push(`${localCount} local file(s)`);
    if (remoteCount > 0) parts.push(`${remoteCount} remote file(s)`);
    return new Promise((resolve) => {
      const modal = new import_obsidian.Modal(this.app);
      this.activeModal = modal;
      modal.titleEl.setText("easy backup");
      modal.contentEl.createEl("p", { text: `This sync will delete ${parts.join(" and ")} (${total} total). Continue?` });
      const list = modal.contentEl.createEl("div", { cls: "easy-backup-delete-list" });
      list.style.maxHeight = "300px";
      list.style.overflowY = "auto";
      list.style.marginTop = "8px";
      list.style.fontSize = "12px";
      list.style.fontFamily = "monospace";
      for (const p of localPaths) {
        const el = list.createEl("div");
        el.setText("[L] " + p);
      }
      for (const p of remotePaths) {
        const el = list.createEl("div");
        el.setText("[R] " + p);
      }
      const buttons = new import_obsidian.Setting(modal.contentEl);
      buttons.addButton((b) => b.setButtonText("Delete").setCta().onClick(() => {
        resolve(true);
        modal.close();
      }));
      buttons.addButton((b) => b.setButtonText("Cancel").onClick(() => {
        resolve(false);
        modal.close();
      }));
      modal.onClose = () => {
        if (this.activeModal === modal) this.activeModal = null;
        resolve(false);
      };
      modal.open();
    });
  }
  addAncestorDirs(base, filePath, set) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = base;
    for (const p of parts) {
      cur += "/" + p;
      set.add(cur);
    }
  }
  /** DELETE a remote dir only when it is empty (PROPFIND Depth:1 shows only itself) */
  async remoteDirIsEmpty(url) {
    try {
      const res = await this.req("PROPFIND", url, void 0, { Depth: "1", "Content-Type": "application/xml" });
      if (res.status >= 400) return false;
      const responses = res.text.split(/<(?:[\w.-]+:)?response[\s>]/i).length - 1;
      return responses <= 1;
    } catch (e) {
      return false;
    }
  }
  /** remove empty folders left behind after local deletion */
  async pruneLocalEmptyDirs(filePath) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = parts.join("/");
    while (cur) {
      if (cur === this.configRoot()) break;
      try {
        await this.app.vault.adapter.rmdir(cur, false);
      } catch (e) {
        break;
      }
      const idx = cur.lastIndexOf("/");
      cur = idx === -1 ? "" : cur.slice(0, idx);
    }
  }
  // ---------- obsidian config (.obsidian) ----------
  /** Vault-relative config dir, normally ".obsidian". */
  configRoot() {
    return (this.app.vault.configDir || ".obsidian").replace(/^\/+|\/+$/g, "");
  }
  isConfigPath(p) {
    return p === this.configRoot() || p.startsWith(this.configRoot() + "/");
  }
  /** Path relative to the config dir. */
  configRel(p) {
    const root = this.configRoot() + "/";
    return p.startsWith(root) ? p.slice(root.length) : p;
  }
  configGlobToRegExp(glob) {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const re = esc.replace(/\*\*/g, "\0").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
    return new RegExp("^" + re + "$");
  }
  configPatterns() {
    const user = (this.settings.configExcludes || "").split(/\r?\n/).map((s) => s.trim().replace(/^\/+/, "")).filter(Boolean);
    return [...CONFIG_ALWAYS_SKIP, ...user];
  }
  /** True for paths (relative to .obsidian/) that must not be synced. */
  configSkipped(rel) {
    if (!rel) return false;
    if (!this.settings.syncPluginData && /^plugins\/[^/]+\/data\.json$/.test(rel)) return true;
    for (const pat of this.configPatterns()) {
      if (pat.endsWith("/")) {
        const dir = pat.slice(0, -1);
        if (rel === dir || rel.startsWith(pat)) return true;
        continue;
      }
      if (rel === pat || rel.startsWith(pat + "/")) return true;
      if (this.configGlobToRegExp(pat).test(rel)) return true;
    }
    return false;
  }
  /** Drop config entries that are disabled or excluded, so they are neither synced nor recorded. */
  filterConfigEntries(map) {
    for (const p of [...map.keys()]) {
      if (!this.isConfigPath(p)) continue;
      if (!this.settings.syncConfig || this.configSkipped(this.configRel(p))) map.delete(p);
    }
  }
  /**
   * Walk .obsidian/ through the adapter: config files are not part of the vault index,
   * so getFiles() never sees them.
   */
  async listLocalConfig() {
    const out = /* @__PURE__ */ new Map();
    const walk = async (dir) => {
      var _a, _b;
      let listing;
      try {
        listing = await this.app.vault.adapter.list(dir);
      } catch (e) {
        return;
      }
      for (const f of listing.files) {
        const rel = this.configRel(f);
        if (this.configSkipped(rel)) continue;
        const st = await this.app.vault.adapter.stat(f);
        out.set(f, { mtime: (_a = st == null ? void 0 : st.mtime) != null ? _a : 0, size: (_b = st == null ? void 0 : st.size) != null ? _b : 0 });
      }
      for (const d of listing.folders) {
        if (this.configSkipped(this.configRel(d))) continue;
        await walk(d);
      }
    };
    await walk(this.configRoot());
    return out;
  }
  /** snapshot of all vault files (plus .obsidian/ when enabled): path -> {mtime,size} */
  async snapshotLocal() {
    var _a, _b;
    const snap = /* @__PURE__ */ new Map();
    for (const f of this.app.vault.getFiles()) {
      if (this.isConfigPath(f.path)) continue;
      const st = await this.app.vault.adapter.stat(f.path);
      snap.set(f.path, { mtime: (_a = st == null ? void 0 : st.mtime) != null ? _a : f.stat.mtime, size: (_b = st == null ? void 0 : st.size) != null ? _b : f.stat.size });
    }
    if (this.settings.syncConfig) {
      for (const [p, s] of await this.listLocalConfig()) snap.set(p, s);
    }
    return { snap };
  }
  // ---------- sync ----------
  async sync(strategyOverride) {
    if (this.syncing) {
      new import_obsidian.Notice("Sync already in progress");
      return;
    }
    if (!this.settings.serverUrl) {
      new import_obsidian.Notice("Please configure server URL");
      return;
    }
    const base = this.base();
    this.syncing = true;
    this.aborted = false;
    this.configTouched = false;
    this.doneCount = 0;
    this.totalCount = 0;
    this.updateRibbon();
    new import_obsidian.Notice("Syncing...");
    const failNotice = (msg) => {
      console.error(msg);
      new import_obsidian.Notice(msg);
    };
    try {
      this.knownDirs = /* @__PURE__ */ new Set();
      await this.ensureRemoteDir(base);
      const { snap: localSnap } = await this.snapshotLocal();
      const remoteSnap = await this.remoteList(base);
      this.filterConfigEntries(remoteSnap);
      const strategy = strategyOverride || this.settings.syncStrategy;
      const isMerge = strategy === "merge";
      let tombs = {};
      let tombFileExisted = false;
      let expiredRemoved = 0;
      const tombRemove = /* @__PURE__ */ new Set();
      const tombAdd = {};
      if (isMerge) {
        const t = await this.readTombstones(base);
        tombs = t.deletions;
        tombFileExisted = t.existed;
        const cutoff = Date.now() - TOMBSTONE_TTL_MS;
        for (const k of Object.keys(tombs)) {
          if (tombs[k] < cutoff) {
            delete tombs[k];
            expiredRemoved++;
          }
        }
      }
      const actions = [];
      let skip = 0;
      const all = /* @__PURE__ */ new Set([...localSnap.keys(), ...remoteSnap.keys()]);
      const handled = /* @__PURE__ */ new Set();
      for (const [p, pd] of Object.entries(this.pendingDeletes)) {
        const L = localSnap.get(p);
        const R = remoteSnap.get(p);
        if (pd.side === "remote") {
          if (!R || R.mtime > pd.ts + TOMBSTONE_SKEW_MS) {
            delete this.pendingDeletes[p];
            continue;
          }
          actions.push({ type: "deleteRemote", path: p });
        } else {
          if (!L || L.mtime > pd.ts + TOMBSTONE_SKEW_MS) {
            delete this.pendingDeletes[p];
            continue;
          }
          actions.push({ type: "deleteLocal", path: p });
        }
        handled.add(p);
      }
      for (const p of all) {
        if (this.isEncodedJunk(p) || p === TOMBSTONE_FILE) {
          skip++;
          continue;
        }
        if (handled.has(p)) continue;
        const L = localSnap.get(p);
        const R = remoteSnap.get(p);
        const prev = this.state[p];
        const localChanged = !!L && (!(prev == null ? void 0 : prev.local) || prev.local.mtime !== L.mtime || prev.local.size !== L.size);
        const remoteChanged = !!R && (!(prev == null ? void 0 : prev.remote) || prev.remote.mtime !== R.mtime || prev.remote.size !== R.size);
        if (localChanged || remoteChanged) {
          const f = (s) => s ? `${s.mtime}/${s.size}` : "-";
          console.log(`[easy-backup] decide ${p} local=${f(L)} remote=${f(R)} prev=${f(prev == null ? void 0 : prev.local)}|${f(prev == null ? void 0 : prev.remote)} lc=${localChanged} rc=${remoteChanged}`);
        }
        if (strategy === "upload") {
          if (L && (!R || localChanged || remoteChanged)) {
            actions.push({ type: "upload", path: p });
          } else if (!L && R && (prev == null ? void 0 : prev.local) && this.settings.syncDeletions) {
            actions.push({ type: "deleteRemote", path: p });
            this.pendingDeletes[p] = { side: "remote", ts: Date.now() };
          }
        } else if (strategy === "download") {
          if (R && (!L || remoteChanged || localChanged)) {
            actions.push({ type: "download", path: p });
          } else if (!R && L && (prev == null ? void 0 : prev.remote) && this.settings.syncDeletions) {
            actions.push({ type: "deleteLocal", path: p });
            this.pendingDeletes[p] = { side: "local", ts: Date.now() };
          }
        } else {
          if (L && R) {
            if (localChanged && remoteChanged) {
              if (!prev) {
                if (L.mtime >= R.mtime) actions.push({ type: "upload", path: p });
                else actions.push({ type: "download", path: p });
              } else {
                const conflictPath = p.replace(/(\.[^.]+)?$/, (m) => `.conflict-${Date.now()}${m || ""}`);
                actions.push({ type: "conflict", path: p, conflictPath });
              }
            } else if (localChanged) {
              actions.push({ type: "upload", path: p });
            } else if (remoteChanged) {
              actions.push({ type: "download", path: p });
            }
          } else if (L && !R) {
            const t = tombs[p];
            if (t !== void 0) {
              if (L.mtime > t - TOMBSTONE_SKEW_MS) {
                tombRemove.add(p);
                actions.push({ type: "upload", path: p });
              } else {
                actions.push({ type: "deleteLocal", path: p });
              }
            } else if (prev == null ? void 0 : prev.remote) {
              if (localChanged) {
                actions.push({ type: "upload", path: p });
              } else {
                actions.push({ type: "deleteLocal", path: p });
                tombAdd[p] = Date.now();
              }
            } else {
              actions.push({ type: "upload", path: p });
            }
          } else if (!L && R) {
            const t = tombs[p];
            if (t !== void 0) {
              if (R.mtime > t - TOMBSTONE_SKEW_MS) {
                tombRemove.add(p);
                actions.push({ type: "download", path: p });
              } else {
                actions.push({ type: "deleteRemote", path: p });
              }
            } else if (prev == null ? void 0 : prev.local) {
              if (remoteChanged) {
                actions.push({ type: "download", path: p });
              } else {
                actions.push({ type: "deleteRemote", path: p });
                tombAdd[p] = Date.now();
              }
            } else {
              actions.push({ type: "download", path: p });
            }
          }
        }
      }
      const CONFIG_TRIGGERS = ["app.json", "appearance.json", "community-plugins.json", "core-plugins.json", "hotkeys.json"];
      const isConfigTrigger = (p) => this.isConfigPath(p) && CONFIG_TRIGGERS.includes(this.configRel(p));
      actions.sort((a, b) => Number(isConfigTrigger(a.path)) - Number(isConfigTrigger(b.path)));
      this.totalCount = actions.length;
      const delLocalPaths = actions.filter((a) => a.type === "deleteLocal").map((a) => a.path);
      const delRemotePaths = actions.filter((a) => a.type === "deleteRemote").map((a) => a.path);
      const delCount = delLocalPaths.length + delRemotePaths.length;
      const threshold = this.settings.deleteConfirmThreshold;
      if (delCount > 0 && (threshold <= 0 || delCount > threshold)) {
        const ok = await this.confirmMassDelete(delLocalPaths, delRemotePaths);
        if (!ok) {
          new import_obsidian.Notice("Sync cancelled: deletion not confirmed");
          return;
        }
      }
      const dirsNeeded = /* @__PURE__ */ new Set();
      for (const a of actions) {
        if (a.type === "upload" || a.type === "conflict") this.addAncestorDirs(base, a.path, dirsNeeded);
      }
      for (const dir of [...dirsNeeded].sort((a, b) => a.length - b.length)) {
        if (this.aborted) {
          new import_obsidian.Notice("Sync cancelled");
          return;
        }
        await this.ensureRemoteDir(dir);
      }
      const counters = { up: 0, down: 0, del: 0, conf: 0, fail: 0 };
      const deletedRemoteDirs = /* @__PURE__ */ new Set();
      const deletedLocalPaths = [];
      const executed = /* @__PURE__ */ new Set();
      let concurrency = Number(this.settings.concurrency);
      if (!Number.isFinite(concurrency)) concurrency = 3;
      concurrency = Math.max(1, Math.min(8, concurrency));
      let idx = 0;
      const execAction = async (a) => {
        var _a, _b;
        switch (a.type) {
          case "upload":
            await this.putLocalFile(base + "/" + a.path, a.path);
            counters.up++;
            break;
          case "download":
            await this.downloadFile(base + "/" + a.path, a.path);
            counters.down++;
            break;
          case "deleteRemote": {
            const r = await this.reqLockAware("DELETE", base + "/" + a.path);
            if ((r.status < 200 || r.status >= 300) && r.status !== 404) throw this.httpError("DELETE", r);
            this.addAncestorDirs(base, a.path, deletedRemoteDirs);
            counters.del++;
            break;
          }
          case "deleteLocal": {
            await this.deleteLocalPath(a.path);
            deletedLocalPaths.push(a.path);
            counters.del++;
            break;
          }
          case "conflict": {
            const localBuf = await this.readLocalBinary(a.path);
            const remoteBuf = await this.fetchBinary(base + "/" + a.path);
            if (sameBytes(localBuf, remoteBuf)) {
              console.log("[easy-backup] conflict but content identical:", a.path);
              break;
            }
            await this.writeLocalFile(a.conflictPath, remoteBuf);
            if (!this.isConfigPath(a.path)) {
              await this.writeConflictReport(
                a.conflictPath,
                a.path,
                localBuf,
                remoteBuf,
                (_a = localSnap.get(a.path)) == null ? void 0 : _a.mtime,
                (_b = remoteSnap.get(a.path)) == null ? void 0 : _b.mtime
              );
            }
            await this.putBytes(base + "/" + a.path, localBuf);
            counters.conf++;
            break;
          }
        }
        executed.add(a.path);
        if (a.type === "deleteRemote" || a.type === "deleteLocal") delete this.pendingDeletes[a.path];
      };
      const worker = async () => {
        while (true) {
          if (this.aborted) return;
          const i = idx++;
          if (i >= actions.length) return;
          try {
            await execAction(actions[i]);
          } catch (e) {
            counters.fail++;
            failNotice("Error: " + actions[i].path + " - " + ((e == null ? void 0 : e.message) || e));
          }
          this.doneCount = (this.doneCount || 0) + 1;
          this.updateRibbon();
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, actions.length) }, worker));
      for (const p of deletedLocalPaths) await this.pruneLocalEmptyDirs(p);
      if (deletedRemoteDirs.size) {
        const dirs = [...deletedRemoteDirs].sort((a, b) => b.length - a.length);
        for (const dir of dirs) {
          if (dir === base) continue;
          if (await this.remoteDirIsEmpty(dir)) {
            try {
              await this.req("DELETE", dir);
              console.log("[easy-backup] pruned empty remote dir:", dir);
            } catch (e) {
            }
          }
        }
      }
      if (isMerge) {
        const tombDirty = expiredRemoved > 0 || tombRemove.size > 0 || Object.keys(tombAdd).length > 0;
        if (tombDirty) {
          const final = {};
          for (const k of Object.keys(tombs)) {
            if (tombRemove.has(k) && executed.has(k)) continue;
            final[k] = tombs[k];
          }
          for (const [p, ts] of Object.entries(tombAdd)) {
            final[p] = ts;
          }
          const keys = Object.keys(final);
          if (keys.length) {
            await this.writeTombstones(base, final);
          } else if (tombFileExisted) {
            await this.deleteTombstoneFile(base);
          }
        }
      }
      const { snap: newLocal } = await this.snapshotLocal();
      const newRemote = await this.remoteList(base);
      this.filterConfigEntries(newRemote);
      const newState = {};
      const union = /* @__PURE__ */ new Set([...newLocal.keys(), ...newRemote.keys()]);
      for (const p of union) {
        if (this.isEncodedJunk(p)) continue;
        newState[p] = { local: newLocal.get(p), remote: newRemote.get(p) };
      }
      this.lastSync = { time: Date.now(), up: counters.up, down: counters.down, del: counters.del, conf: counters.conf };
      this.state = newState;
      await this.saveState();
      new import_obsidian.Notice(`Sync done: \u2191${counters.up} \u2193${counters.down} \u2715${counters.del} \u26A0${counters.conf} \u23ED${skip}${counters.fail ? " \u2717" + counters.fail : ""}`);
      if (this.configTouched) {
        new import_obsidian.Notice("Obsidian config was written \u2014 reload the app (Ctrl+R / command palette: Reload app without saving) to apply plugin changes.");
        console.log("[easy-backup] config files written this run");
      }
    } catch (e) {
      console.error(e);
      new import_obsidian.Notice("Sync failed: " + ((e == null ? void 0 : e.message) || e));
    } finally {
      this.syncing = false;
      this.updateRibbon();
    }
  }
  onunload() {
    var _a;
    this.aborted = true;
    (_a = this.activeModal) == null ? void 0 : _a.close();
  }
  toggleSync() {
    var _a;
    if (this.syncing) {
      this.aborted = true;
      console.log("[easy-backup] stop requested");
      new import_obsidian.Notice("Stopping sync...");
      (_a = this.settingTab) == null ? void 0 : _a.refreshLastSync();
    } else {
      this.sync();
    }
  }
  /** ribbon click menu: pick the strategy for this sync (default strategy stays unchanged) */
  showSyncMenu(evt) {
    const menu = new import_obsidian.Menu();
    const current = this.settings.syncStrategy || "merge";
    const add = (strategy) => {
      menu.addItem((item) => {
        const marks = { upload: "\u21E7", download: "\u21E9", merge: "\u21C4" };
        item.setTitle(`${marks[strategy]} Sync now (${strategy})${strategy === current ? "  \u2022default" : ""}`).onClick(() => this.sync(strategy));
      });
    };
    add("merge");
    add("upload");
    add("download");
    menu.showAtMouseEvent(evt);
  }
  ribbonLabel() {
    if (this.syncing) return "easy backup: syncing (click to stop)";
    const ls = this.lastSync;
    if (!ls) return "easy backup: sync";
    const t = new Date(ls.time);
    const pad = (n) => String(n).padStart(2, "0");
    return `easy backup: sync (click for menu)
Last: ${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}  \u2191${ls.up} \u2193${ls.down} \u2715${ls.del} \u26A0${ls.conf}`;
  }
  updateRibbon() {
    var _a;
    if (!this.ribbonEl) return;
    const label = this.ribbonLabel();
    if (this.syncing) {
      (0, import_obsidian.setIcon)(this.ribbonEl, "refresh-cw");
      this.ribbonEl.addClass("easy-sync-spinning");
    } else {
      this.ribbonEl.removeClass("easy-sync-spinning");
      (0, import_obsidian.setIcon)(this.ribbonEl, "cloud-upload");
    }
    this.ribbonEl.setAttribute("aria-label", label);
    (_a = this.settingTab) == null ? void 0 : _a.refreshLastSync(this.syncing ? { done: this.doneCount, total: this.totalCount } : void 0);
  }
  async putBytes(url, data) {
    const r = await this.reqLockAware("PUT", url, data, { "Content-Type": "application/octet-stream" });
    if (r.status < 200 || r.status >= 300) {
      const err = this.httpError("PUT", r);
      if (r.status === 423) err.message += (await this.probeLock(url)).desc;
      throw err;
    }
  }
  async readLocalBinary(p) {
    if (this.isConfigPath(p)) return this.app.vault.adapter.readBinary(p);
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!(f instanceof import_obsidian.TFile)) throw new Error("local file missing: " + p);
    return this.app.vault.readBinary(f);
  }
  async putLocalFile(url, p) {
    await this.putBytes(url, await this.readLocalBinary(p));
  }
  async deleteLocalPath(p) {
    if (this.isConfigPath(p)) {
      this.configTouched = true;
      try {
        await this.app.vault.adapter.remove(p);
      } catch (e) {
        if (!await this.app.vault.adapter.exists(p)) return;
        throw e;
      }
      return;
    }
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof import_obsidian.TFile) await this.app.vault.delete(f);
  }
  async fetchBinary(url) {
    const res = await this.req("GET", url);
    if (res.status < 200 || res.status >= 300 || !res.arrayBuffer) throw this.httpError("GET", res);
    return res.arrayBuffer;
  }
  async writeLocalFile(localPath, buf) {
    if (this.isConfigPath(localPath)) {
      await this.ensureLocalDirs(localPath);
      await this.app.vault.adapter.writeBinary(localPath, buf);
      this.configTouched = true;
      return;
    }
    const existing = this.app.vault.getAbstractFileByPath(localPath);
    await this.ensureParentFolders(localPath);
    if (existing instanceof import_obsidian.TFile) {
      await this.app.vault.modifyBinary(existing, buf);
    } else {
      await this.app.vault.createBinary(localPath, buf);
    }
  }
  async downloadFile(url, localPath) {
    await this.writeLocalFile(localPath, await this.fetchBinary(url));
  }
  fmtTime(ms) {
    if (!ms) return "-";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  /** Markdown fence longer than any backtick run inside the text. */
  fenceFor(text) {
    let longest = 0;
    for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
    return "`".repeat(Math.max(3, longest + 1));
  }
  /**
   * Write "<name>.conflict-<ts>.diff.md" next to a conflict copy: a unified diff
   * between the kept local version and the remote backup, wrapped in a fence so
   * Obsidian renders it readably. Binary or oversized content is skipped.
   */
  async writeConflictReport(conflictPath, localPath, localBuf, remoteBuf, localMtime, remoteMtime) {
    const diffPath = conflictPath.replace(/(\.[^.]+)?$/, (m) => `.diff${m || ".md"}`);
    const isText = looksLikeText(localBuf) && looksLikeText(remoteBuf);
    let body;
    if (!isText) {
      console.log("[easy-backup] conflict diff skipped (binary):", localPath);
      return;
    }
    const diff = unifiedDiff(decodeText(localBuf), decodeText(remoteBuf), "local/" + localPath, "remote/" + conflictPath);
    if (diff === null) {
      body = "_Diff skipped: the files are too large to compare cheaply. Compare the two files manually._";
      console.log("[easy-backup] conflict diff skipped (too large):", localPath);
    } else if (diff === "") {
      body = "_No line-level differences (the files differ only in whitespace, line endings or a trailing newline)._";
    } else {
      const fence = this.fenceFor(diff);
      body = fence + "diff\n" + diff + "\n" + fence;
    }
    const report = [
      `# Conflict: ${localPath}`,
      "",
      `- local (kept): \`${localPath}\` \u2014 ${this.fmtTime(localMtime)}`,
      `- remote (backup): \`${conflictPath}\` \u2014 ${this.fmtTime(remoteMtime)}`,
      "",
      body,
      ""
    ].join("\n");
    await this.writeLocalFile(diffPath, this.textToBuffer(report));
  }
  async ensureParentFolders(filePath) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur += (cur ? "/" : "") + p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
        }
      }
    }
  }
  /** mkdir -p through the adapter (needed for .obsidian/, which the vault API does not manage) */
  async ensureLocalDirs(filePath) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur += (cur ? "/" : "") + p;
      try {
        if (!await this.app.vault.adapter.exists(cur)) await this.app.vault.adapter.mkdir(cur);
      } catch (e) {
      }
    }
  }
};
// ---------- transport ----------
// Statuses that mean "try again later": Nextcloud's files_lock returns 423 while a
// file is locked (by another client, or by a lock left behind by an interrupted
// request), and 5xx/429 are plain transient server pressure.
_SelfSignedSyncPlugin.RETRYABLE_STATUS = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var SelfSignedSyncPlugin = _SelfSignedSyncPlugin;
var SyncSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.lastSyncSetting = null;
    this.plugin = plugin;
  }
  refreshLastSync(progress) {
    if (!this.lastSyncSetting) return;
    const ls = this.plugin.lastSync;
    let status;
    if (this.plugin.syncing && this.plugin.aborted) status = "Stopping...";
    else if (this.plugin.syncing && progress && progress.total > 0) {
      const pct = Math.round(progress.done / progress.total * 100);
      status = `Syncing... ${progress.done}/${progress.total} (${pct}%)`;
    } else if (this.plugin.syncing) status = "Syncing...";
    else status = ls ? `${new Date(ls.time).toLocaleString()}  \u2191${ls.up} \u2193${ls.down} \u2715${ls.del} \u26A0${ls.conf}` : "Never";
    this.lastSyncSetting.setDesc(status);
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const ls = this.plugin.lastSync;
    const status = ls ? `${new Date(ls.time).toLocaleString()}  \u2191${ls.up} \u2193${ls.down} \u2715${ls.del} \u26A0${ls.conf}` : "Never";
    this.lastSyncSetting = new import_obsidian.Setting(containerEl).setName("Last sync").setDesc(status);
    if (this.plugin.syncing) this.lastSyncSetting.setDesc("Syncing...");
    new import_obsidian.Setting(containerEl).setName("Server URL").setDesc("WebDAV base URL, e.g. https://nas.local:5006").addText((t) => t.setPlaceholder("https://...").setValue(this.plugin.settings.serverUrl).onChange(async (v) => {
      this.plugin.settings.serverUrl = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Username").addText((t) => t.setValue(this.plugin.settings.username).onChange(async (v) => {
      this.plugin.settings.username = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Password").addText((t) => {
      t.setValue(this.plugin.settings.password).onChange(async (v) => {
        this.plugin.settings.password = v;
        await this.plugin.saveSettings();
      });
      t.inputEl.type = "password";
    });
    new import_obsidian.Setting(containerEl).setName("Remote path").addText((t) => t.setValue(this.plugin.settings.remotePath).onChange(async (v) => {
      this.plugin.settings.remotePath = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Test connection").setDesc("Verify the WebDAV URL and credentials.").addButton((b) => b.setButtonText("Test").onClick(async () => {
      const base = this.plugin.base();
      if (!base) {
        new import_obsidian.Notice("Please configure server URL");
        return;
      }
      try {
        console.log("[easy-backup] testing base:", base, "user:", this.plugin.settings.username);
        let r = await this.plugin.req("PROPFIND", base, void 0, { Depth: "0" });
        if (r.status === 404) {
          await this.plugin.req("MKCOL", base);
          r = await this.plugin.req("PROPFIND", base, void 0, { Depth: "0" });
        }
        if (r.status >= 200 && r.status < 300) new import_obsidian.Notice("Connection OK (" + r.status + ")");
        else new import_obsidian.Notice("Connection failed: HTTP " + r.status + " @ " + base);
      } catch (e) {
        new import_obsidian.Notice("Connection failed: " + ((e == null ? void 0 : e.message) || e));
      }
    }));
    new import_obsidian.Setting(containerEl).setName("Sync on startup").addToggle((t) => t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
      this.plugin.settings.syncOnStartup = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Sync strategy").addDropdown((d) => d.addOption("upload", "Upload (overwrite remote)").addOption("download", "Download (overwrite local)").addOption("merge", "Merge (bidirectional)").setValue(this.plugin.settings.syncStrategy).onChange(async (v) => {
      this.plugin.settings.syncStrategy = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Mirror deletions (upload/download only)").setDesc("In Upload mode: deleting locally also deletes on the server. In Download mode: deleting remotely also deletes locally. Merge mode propagates deletions via tombstone records with the confirmation threshold below.").addToggle((t) => {
      var _a;
      return t.setValue((_a = this.plugin.settings.syncDeletions) != null ? _a : true).onChange(async (v) => {
        this.plugin.settings.syncDeletions = v;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Delete confirmation threshold").setDesc("Ask for confirmation before a sync deletes more than this many files. 0 = always confirm any deletion.").addDropdown((d) => {
      var _a;
      return d.addOption("0", "Always confirm").addOption("5", "More than 5").addOption("20", "More than 20 (default)").addOption("50", "More than 50").addOption("1000000", "Never confirm").setValue(String((_a = this.plugin.settings.deleteConfirmThreshold) != null ? _a : 20)).onChange(async (v) => {
        this.plugin.settings.deleteConfirmThreshold = parseInt(v, 10);
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Force-unlock server locks (Nextcloud)").setDesc("When an upload/delete fails with HTTP 423, release the Nextcloud files_lock entry (e.g. a stale lock left by the web Text editor) and retry once.").addToggle((t) => {
      var _a;
      return t.setValue((_a = this.plugin.settings.forceUnlockLocks) != null ? _a : true).onChange(async (v) => {
        this.plugin.settings.forceUnlockLocks = v;
        await this.plugin.saveSettings();
      });
    });
    new import_obsidian.Setting(containerEl).setName("Concurrency").setDesc("Parallel transfer count. 2-3 is safe for most servers; higher is faster for large initial syncs.").addDropdown((d) => {
      var _a;
      return d.addOption("1", "1 (sequential)").addOption("2", "2").addOption("3", "3 (default)").addOption("4", "4").addOption("6", "6").addOption("8", "8").setValue(String((_a = this.plugin.settings.concurrency) != null ? _a : 3)).onChange(async (v) => {
        this.plugin.settings.concurrency = parseInt(v, 10);
        await this.plugin.saveSettings();
      });
    });
    containerEl.createEl("h3", { text: "Obsidian config sync" });
    new import_obsidian.Setting(containerEl).setName("Sync Obsidian config (.obsidian)").setDesc("Sync plugins, themes, CSS snippets, hotkeys and app settings so a new device picks up the same setup. Always excluded: workspace*.json (pane layout), cache/, .git/, and this plugin's own folder. Reload Obsidian after a run that downloads plugins.").addToggle((t) => t.setValue(!!this.plugin.settings.syncConfig).onChange(async (v) => {
      this.plugin.settings.syncConfig = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Include plugin settings (plugins/*/data.json)").setDesc("Off by default: plugin data often holds device-specific paths or credentials (this vault's remotely-save data.json, for example). Enable only if you want every plugin preconfigured on other devices.").addToggle((t) => t.setValue(!!this.plugin.settings.syncPluginData).onChange(async (v) => {
      this.plugin.settings.syncPluginData = v;
      await this.plugin.saveSettings();
    }));
    new import_obsidian.Setting(containerEl).setName("Config exclusions").setDesc("One glob per line, relative to .obsidian/ (e.g. plugins/obsidian-git/ or snippets/private.css). * stays inside a folder, ** crosses folders.").addTextArea((t) => {
      t.setPlaceholder("plugins/some-plugin/\nsnippets/private.css").setValue(this.plugin.settings.configExcludes || "").onChange(async (v) => {
        this.plugin.settings.configExcludes = v;
        await this.plugin.saveSettings();
      });
      t.inputEl.rows = 6;
      t.inputEl.style.width = "100%";
      t.inputEl.style.minWidth = "280px";
      t.inputEl.style.maxWidth = "none";
    });
    new import_obsidian.Setting(containerEl).setName("Manual sync").setDesc("Start sync; click again while syncing to stop.").addButton((b) => b.setButtonText("Sync now").onClick(() => this.plugin.toggleSync()));
  }
};
