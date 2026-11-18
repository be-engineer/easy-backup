import { App, Menu, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl, setIcon } from "obsidian";
import { decodeText, looksLikeText, unifiedDiff } from "./diff";

const TOMBSTONE_FILE = ".easy-sync-deleted.json";
const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000; // keep deletion records 30 days
const TOMBSTONE_SKEW_MS = 5 * 60 * 1000; // clock-skew tolerance for recreate detection

/**
 * Never synced, whatever the settings say. workspace*.json is rewritten constantly by
 * Obsidian and describes this device's pane layout; our own plugin dir holds code plus
 * credentials/sync state, so syncing it would both leak state and overwrite a running plugin.
 */
const CONFIG_ALWAYS_SKIP = ["workspace.json", "workspace-mobile.json", "cache/", "plugins/easy-backup/", ".git/"];

interface DavResponse { status: number; text: string; arrayBuffer?: ArrayBuffer }

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

interface Settings {
  serverUrl: string;
  username: string;
  password: string;
  remotePath: string;
  // (removed)
  syncOnStartup: boolean;
  syncStrategy: "upload" | "download" | "merge";
  syncDeletions: boolean;
  concurrency: number;
  deleteConfirmThreshold: number;
  forceUnlockLocks: boolean;
  syncConfig: boolean;
  syncPluginData: boolean;
  configExcludes: string;
}

const DEFAULT_SETTINGS: Settings = {
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
  configExcludes: "",
};

interface FileSnap { mtime: number; size: number; }
interface SyncState { [path: string]: { local?: FileSnap; remote?: FileSnap } }

type SyncAction =
  | { type: "upload"; path: string }
  | { type: "download"; path: string }
  | { type: "deleteRemote"; path: string }
  | { type: "deleteLocal"; path: string }
  | { type: "conflict"; path: string; conflictPath: string };

export default class SelfSignedSyncPlugin extends Plugin {
  settings: Settings;
  state: SyncState = {};
  lastSync?: { time: number; up: number; down: number; del: number; conf: number };
  pendingDeletes: Record<string, { side: "local" | "remote"; ts: number }> = {};
  private knownDirs = new Set<string>();
  syncing = false;
  aborted = false;
  private configTouched = false;
  private ribbonEl: HTMLElement | null = null;
  private settingTab: SyncSettingTab | null = null;
  doneCount = 0;
  totalCount = 0;
  private activeModal: Modal | null = null;

  async onload() {
    console.log("[easy-backup] loaded v" + this.manifest.version);
    await this.loadSettings();
    await this.loadState();
    this.ribbonEl = this.addRibbonIcon("cloud-upload", "easy backup", (evt: MouseEvent) => {
      if (this.syncing) {
        this.toggleSync(); // click while syncing = stop
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
    this.addCommand({ id: "stop-sync", name: "Stop sync", callback: () => { this.aborted = true; new Notice("Stopping sync..."); } });
    this.settingTab = new SyncSettingTab(this.app, this);
  this.addSettingTab(this.settingTab);
    if (this.settings.syncOnStartup) {
      this.app.workspace.onLayoutReady(() => this.sync());
    }
  }

  private readonly passwordSecretId = "easy-backup-password";
  async loadSettings() {
    const d = await this.loadData() || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, d);
    // password is never stored in data.json in plaintext; read from SecretStorage
    const secret = this.app.secretStorage.getSecret(this.passwordSecretId);
    if (secret !== null) this.settings.password = secret;
    else if (d.password) { // migrate legacy plaintext password once
      this.settings.password = d.password;
      this.app.secretStorage.setSecret(this.passwordSecretId, d.password);
      delete d.password;
      await this.saveData(d);
    }
  }
  async saveSettings() {
    const d = (await this.loadData()) || {};
    const password = this.settings.password;
    // settings must never carry the sync bookkeeping: loadSettings() merged these in,
    // so writing them back would resurrect an old snapshot and corrupt change detection.
    const plain: Record<string, any> = { ...(this.settings as any) };
    delete plain.password;
    delete plain.syncState;
    delete plain.lastSync;
    delete plain.pendingDeletes;
    Object.assign(d, plain);
    delete d.password; // never persist password in plaintext
    if (password) this.app.secretStorage.setSecret(this.passwordSecretId, password);
    await this.saveData(d);
  }
  async loadState() {
    const d = await this.loadData();
    this.state = d?.syncState || {};
    this.lastSync = d?.lastSync;
    this.pendingDeletes = d?.pendingDeletes || {};
  }
  async saveState() {
    const d = (await this.loadData()) || {};
    d.syncState = this.state;
    d.lastSync = this.lastSync;
    d.pendingDeletes = this.pendingDeletes;
    await this.saveData(d);
  }

  private headers(extra: Record<string, string>) {
    const h: Record<string, string> = { ...extra };
    if (this.settings.username) h["Authorization"] = "Basic " + btoa(this.settings.username + ":" + this.settings.password);
    return h;
  }
  base() { return this.settings.serverUrl.replace(/\/+$/, "") + (this.settings.remotePath || "").replace(/\/+$/, ""); }

  // ---------- transport ----------
  // Statuses that mean "try again later": Nextcloud's files_lock returns 423 while a
  // file is locked (by another client, or by a lock left behind by an interrupted
  // request), and 5xx/429 are plain transient server pressure.
  private static readonly RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

  /** Pull the useful bits out of a Sabre/Nextcloud error body. */
  private davDetail(r: { status: number; text?: string }): string {
    const t = (r.text || "").replace(/\s+/g, " ").trim();
    if (!t) return "";
    const pick = (name: string) => {
      const m = new RegExp(`<(?:[\\w.-]+:)?${name}[^>]*>([^<]*)<`, "i").exec(t);
      return m ? m[1].trim() : "";
    };
    const ex = pick("exception");
    const msg = pick("message");
    const parts = [ex, msg].filter(Boolean);
    const detail = parts.length ? parts.join(": ") : t.slice(0, 200);
    return detail ? ` (${detail})` : "";
  }

  private httpError(what: string, r: { status: number; text?: string }): Error {
    let hint = "";
    if (r.status === 423) hint = " — the file is locked on the server (Nextcloud files_lock); close it in the Nextcloud web editor or wait for the lock to expire";
    if (r.status === 401) hint = " — check username/password";
    if (r.status === 403) hint = " — permission denied";
    if (r.status === 409) hint = " — a remote folder with the same name may exist";
    if (r.status === 507) hint = " — server storage quota exceeded";
    return new Error(`${what} failed: HTTP ${r.status}${this.davDetail(r)}${hint}`);
  }

  /** Ask Nextcloud who holds the lock on a path and, if possible, force-unlock it. */
  private async probeLock(url: string): Promise<{ fileId?: number; desc: string; locked: boolean }> {
    try {
      const xml = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns" xmlns:oc="http://owncloud.org/ns"><d:prop>'
        + "<d:lockdiscovery/><oc:fileid/><nc:lock/><nc:lock-owner/><nc:lock-owner-displayname/><nc:lock-time/><nc:lock-timeout/>"
        + "</d:prop></d:propfind>";
      const buf = new TextEncoder().encode(xml);
      const r = await this.req("PROPFIND", url, buf.buffer as ArrayBuffer, { Depth: "0", "Content-Type": "application/xml" });
      console.log("[easy-backup] lock probe:", r.status, r.text.slice(0, 800));
      const pick = (name: string) => {
        const m = new RegExp(`<(?:[\\w.-]+:)?${name}[^>]*>([^<]*)<`, "i").exec(r.text);
        return m ? m[1].trim() : "";
      };
      const fileId = parseInt(pick("fileid"), 10);
      const parts: string[] = [];
      const lockState = pick("lock");
      const owner = pick("lock-owner-displayname") || pick("lock-owner");
      if (owner) parts.push("owner=" + owner);
      const t = parseInt(pick("lock-time"), 10);
      if (Number.isFinite(t) && t > 0) parts.push("since=" + new Date(t * 1000).toLocaleString());
      const timeout = pick("lock-timeout");
      if (timeout) parts.push("timeout=" + timeout);
      return {
        fileId: Number.isFinite(fileId) && fileId > 0 ? fileId : undefined,
        desc: parts.length ? " [" + parts.join(", ") + "]" : "",
        locked: parts.length > 0 || lockState !== "",
      };
    } catch (e: any) {
      console.log("[easy-backup] lock probe failed:", e?.message || e);
      return { desc: "", locked: false };
    }
  }

  /** Release a Nextcloud files_lock lock (OCS API). The file owner may always do this. */
  private async unlockRemoteLock(url: string): Promise<{ ok: boolean; note: string }> {
    const probe = await this.probeLock(url);
    const path = url.slice(this.base().length + 1);
    if (!probe.fileId) return { ok: false, note: probe.desc };
    try {
      const rootMatch = /^(.*?)\/remote\.php\//.exec(this.settings.serverUrl);
      const root = rootMatch ? rootMatch[1] : new URL(this.settings.serverUrl).origin;
      const target = `${root}/ocs/v2.php/apps/files_lock/lock/${probe.fileId}?format=json`;
      const r = await this.req("DELETE", target, undefined, { "OCS-APIRequest": "true", "Accept": "application/json" });
      console.log("[easy-backup] unlock", probe.fileId, r.status, r.text.slice(0, 300));
      if (r.status >= 200 && r.status < 300) return { ok: true, note: path + probe.desc };
      // 412 = nothing to unlock, 423 = lock belongs to someone we may not override
      return { ok: false, note: probe.desc + " (unlock HTTP " + r.status + ")" };
    } catch (e: any) {
      return { ok: false, note: probe.desc + " (unlock failed: " + (e?.message || e) + ")" };
    }
  }

  /**
   * Request with lock recovery: a 423 from Nextcloud files_lock is permanent until
   * somebody releases the lock, so probe, force-unlock, then retry once.
   */
  private async reqLockAware(method: string, url: string, body?: ArrayBuffer, headers: Record<string,string> = {}): Promise<DavResponse> {
    let r = await this.req(method, url, body, headers);
    if (r.status !== 423 || !this.settings.forceUnlockLocks || this.aborted) return r;
    const res = await this.unlockRemoteLock(url);
    if (!res.ok) {
      console.warn("[easy-backup] could not unlock", url, res.note);
      return r;
    }
    new Notice("Unlocked server lock: " + res.note);
    console.log("[easy-backup] unlocked, retrying", method, url);
    r = await this.req(method, url, body, headers);
    return r;
  }

  async req(method: string, url: string, body?: ArrayBuffer, headers: Record<string,string> = {}): Promise<DavResponse> {
    const MAX_RETRIES = 3;
    for (let attempt = 0; ; attempt++) {
      const r = await this.reqNet(method, url, body, headers);
      if (SelfSignedSyncPlugin.RETRYABLE_STATUS.has(r.status) && attempt < MAX_RETRIES && !this.aborted) {
        const delay = 600 * (attempt + 1);
        console.warn(`[easy-backup] HTTP ${r.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms:`, method, url, this.davDetail(r));
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      if (r.status >= 400) console.warn("[easy-backup] HTTP", r.status, method, url, r.text.slice(0, 300));
      return r;
    }
  }

  /** one request, retrying only socket-level hiccups (DNS, reset, refused) */
  private async reqNet(method: string, url: string, body?: ArrayBuffer, headers: Record<string,string> = {}): Promise<DavResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.reqOnce(method, url, body, headers);
      } catch (e: any) {
        const code = e?.code || "";
        const transient = ["ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED"].includes(code);
        if (transient && attempt < 2) {
          console.log("[easy-backup] retry", attempt + 1, method, url, code);
          await new Promise(res => setTimeout(res, 500 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  private async reqOnce(method: string, url: string, body?: ArrayBuffer, headers: Record<string,string> = {}) {
    const TIMEOUT_MS = 60000; // 60 seconds timeout
    const hdrs = this.headers(headers);
    if (body) hdrs["Content-Length"] = String(body.byteLength);
    // Node path: only on desktop (real require with http/https). Mobile lacks these modules.
    let nodeRequest: Promise<{ status: number; text: string; arrayBuffer?: ArrayBuffer }> | null = null;
    if (typeof require === "function") {
      try {
        const mod = url.startsWith("https") ? require("https") : require("http");
        if (mod) {
          const u = new URL(url);
          console.log("[easy-backup] req (node):", method, url);
          let reqRef: any = null;
          nodeRequest = new Promise<{ status: number; text: string; arrayBuffer?: ArrayBuffer }>((resolve, reject) => {
            const req = reqRef = mod.request({
              hostname: u.hostname, port: u.port || (url.startsWith("https") ? 443 : 80),
              path: u.pathname + u.search, method, headers: hdrs,
              rejectUnauthorized: false,
              timeout: TIMEOUT_MS,
            }, (res: any) => {
              console.log("[easy-backup] response:", res.statusCode, url);
              const chunks: Buffer[] = [];
              res.on("data", (c: Buffer) => chunks.push(c));
              res.on("end", () => {
                console.log("[easy-backup] response done:", res.statusCode, url);
                const buf = Buffer.concat(chunks);
                resolve({ status: res.statusCode, text: buf.toString("utf8"), arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
              });
            });
            req.on("error", (e: any) => { console.error("[easy-backup] req error:", method, url, e); reject(e); });
            req.on("timeout", () => {
              console.error("[easy-backup] req timeout:", method, url);
              req.destroy();
              reject(new Error("Request timed out after " + (TIMEOUT_MS / 1000) + "s"));
            });
            if (body) req.write(Buffer.from(body));
            req.end();
          });
          // hard cap: never hang longer than TIMEOUT_MS; destroy the socket too
          nodeRequest = Promise.race([
            nodeRequest,
            new Promise<never>((_, reject) => setTimeout(() => {
              try { reqRef?.destroy(); } catch {}
              reject(new Error("Hard timeout after " + (TIMEOUT_MS / 1000) + "s: " + method + " " + url));
            }, TIMEOUT_MS + 5000)),
          ]);
        }
      } catch (e: any) {
        console.log("[easy-backup] require http/https not available, falling back:", e?.message || e);
      }
    }
    // Fallback for mobile or non-node environment
    if (nodeRequest) return nodeRequest;
    const timeoutPromise = new Promise<never>((_, reject) => 
      setTimeout(() => reject(new Error("Request timed out after " + (TIMEOUT_MS / 1000) + "s")), TIMEOUT_MS)
    );
    try {
      const r = await Promise.race([
        requestUrl({ url, method, body, headers: hdrs, throw: false }),
        timeoutPromise
      ]);
      return { status: r.status, text: r.text, arrayBuffer: r.arrayBuffer };
    } catch (e: any) {
      const msg = String(e?.message || e);
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
  private async remoteList(dirUrl: string): Promise<Map<string, FileSnap>> {
    const res = await this.req("PROPFIND", dirUrl, undefined, { Depth: "infinity", "Content-Type": "application/xml" });
    const map = new Map<string, FileSnap>();
    // never treat auth/server errors as "empty remote": that could cause mass deletions
    if (res.status < 200 || res.status >= 300) throw this.httpError("PROPFIND", res);
    console.log("[easy-backup] PROPFIND bytes:", res.text.length, "responses:", (res.text.match(/<(?:[\w.-]+:)?response[\s>]/gi) || []).length - 1);
    // namespace-agnostic split: matches <d:response>, <D:response>, <x1:response>, <response>...
    const responses = res.text.split(/<(?:[\w.-]+:)?response[\s>]/i).slice(1);
    const base = new URL(dirUrl);
    for (const r of responses) {
      const hrefM = r.match(/<(?:[\w.-]+:)?href>([\s\S]*?)<\//i);
      if (!hrefM) continue;
      // decode XML entities (&amp; etc.) before URL decoding
      const entityMap: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
      const href = hrefM[1].trim().replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => entityMap[e]);
      const isCollection = /<(?:[\w.-]+:)?collection[\s/>]/i.test(r);
      if (isCollection) continue;
      const mtimeM = r.match(/<(?:[\w.-]+:)?getlastmodified>([\s\S]*?)<\//i);
      const sizeM = r.match(/<(?:[\w.-]+:)?getcontentlength>([\s\S]*?)<\//i);
      const mtime = mtimeM ? Date.parse(mtimeM[1].trim()) : 0;
      const size = sizeM ? parseInt(sizeM[1].trim(), 10) : 0;
      // relative path
      const u = new URL(href, base);
      let rel = decodeURIComponent(u.pathname); // decode %XX back to real names
      const basePath = decodeURIComponent(new URL(dirUrl).pathname).replace(/\/+$/, "");
      if (rel.startsWith(basePath)) rel = rel.slice(basePath.length);
      rel = rel.replace(/^\/+/, "");
      if (!rel) continue;
      if (rel === TOMBSTONE_FILE) continue; // deletion records are metadata, not synced content
      map.set(rel, { mtime: isNaN(mtime) ? 0 : mtime, size });
    }
    return map;
  }

  private async ensureRemoteDir(url: string) {
    if (this.knownDirs.has(url)) return;
    try {
      const r = await this.req("MKCOL", url);
      // 201 created, 405 already exists, 2xx ok -> safe to cache
      if ((r.status >= 200 && r.status < 300) || r.status === 405) this.knownDirs.add(url);
    } catch {}
  }

  private isEncodedJunk(p: string): boolean {
    return p.split("/").some(seg => seg.length > 0 && /^(?:%[0-9A-Fa-f]{2})+$/.test(seg));
  }

  // ---------- tombstones (Joplin-style deletion records) ----------
  private tombstoneUrl(base: string) { return base + "/" + TOMBSTONE_FILE; }

  private textToBuffer(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer as ArrayBuffer;
  }

  private async readTombstones(base: string): Promise<{ deletions: Record<string, number>; existed: boolean }> {
    let res;
    try {
      res = await this.req("GET", this.tombstoneUrl(base));
    } catch (e) {
      // network failure: do NOT pretend the file is missing — overwriting later could
      // wipe other devices' deletion records. Let the sync fail instead.
      throw new Error("Tombstone GET failed: " + (e?.message || e));
    }
    if (res.status === 404) return { deletions: {}, existed: false };
    if (res.status < 200 || res.status >= 300) throw this.httpError("Tombstone GET", res);
    const out: Record<string, number> = {};
    try {
      const obj = JSON.parse(res.text);
      if (obj && typeof obj.deletions === "object") {
        for (const k of Object.keys(obj.deletions)) {
          const ts = Number(obj.deletions[k]);
          if (Number.isFinite(ts) && ts > 0) out[k] = ts;
        }
      }
    } catch { /* corrupt file: treat as empty */ }
    return { deletions: out, existed: true };
  }

  private async writeTombstones(base: string, deletions: Record<string, number>) {
    const r = await this.req("PUT", this.tombstoneUrl(base), this.textToBuffer(JSON.stringify({ deletions })), { "Content-Type": "application/json" });
    if (r.status < 200 || r.status >= 300) throw this.httpError("Tombstone PUT", r);
  }

  private async deleteTombstoneFile(base: string) {
    try { await this.req("DELETE", this.tombstoneUrl(base)); } catch {}
  }

  private confirmMassDelete(localPaths: string[], remotePaths: string[]): Promise<boolean> {
    const localCount = localPaths.length;
    const remoteCount = remotePaths.length;
    const total = localCount + remoteCount;
    const parts: string[] = [];
    if (localCount > 0) parts.push(`${localCount} local file(s)`);
    if (remoteCount > 0) parts.push(`${remoteCount} remote file(s)`);
    return new Promise(resolve => {
      const modal = new Modal(this.app);
      this.activeModal = modal;
      modal.titleEl.setText("easy backup");
      modal.contentEl.createEl("p", { text: `This sync will delete ${parts.join(" and ")} (${total} total). Continue?` });
      const list = modal.contentEl.createEl("div", { cls: "easy-backup-delete-list" });
      list.style.maxHeight = "300px";
      list.style.overflowY = "auto";
      list.style.marginTop = "8px";
      list.style.fontSize = "12px";
      list.style.fontFamily = "monospace";
      for (const p of localPaths) { const el = list.createEl("div"); el.setText("[L] " + p); }
      for (const p of remotePaths) { const el = list.createEl("div"); el.setText("[R] " + p); }
      const buttons = new Setting(modal.contentEl);
      buttons.addButton(b => b.setButtonText("Delete").setCta().onClick(() => { resolve(true); modal.close(); }));
      buttons.addButton(b => b.setButtonText("Cancel").onClick(() => { resolve(false); modal.close(); }));
      modal.onClose = () => { if (this.activeModal === modal) this.activeModal = null; resolve(false); }; // Esc / clicking outside = cancel
      modal.open();
    });
  }

  private addAncestorDirs(base: string, filePath: string, set: Set<string>) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = base;
    for (const p of parts) {
      cur += "/" + p;
      set.add(cur);
    }
  }

  /** DELETE a remote dir only when it is empty (PROPFIND Depth:1 shows only itself) */
  private async remoteDirIsEmpty(url: string): Promise<boolean> {
    try {
      const res = await this.req("PROPFIND", url, undefined, { Depth: "1", "Content-Type": "application/xml" });
      if (res.status >= 400) return false;
      const responses = res.text.split(/<(?:[\w.-]+:)?response[\s>]/i).length - 1;
      return responses <= 1; // only the collection itself
    } catch { return false; }
  }

  /** remove empty folders left behind after local deletion */
  private async pruneLocalEmptyDirs(filePath: string) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = parts.join("/");
    while (cur) {
      if (cur === this.configRoot()) break; // never delete .obsidian itself
      try {
        await this.app.vault.adapter.rmdir(cur, false); // fails if not empty
      } catch { break; }
      const idx = cur.lastIndexOf("/");
      cur = idx === -1 ? "" : cur.slice(0, idx);
    }
  }

  // ---------- obsidian config (.obsidian) ----------
  /** Vault-relative config dir, normally ".obsidian". */
  private configRoot(): string {
    return (this.app.vault.configDir || ".obsidian").replace(/^\/+|\/+$/g, "");
  }

  private isConfigPath(p: string): boolean {
    return p === this.configRoot() || p.startsWith(this.configRoot() + "/");
  }

  /** Path relative to the config dir. */
  private configRel(p: string): string {
    const root = this.configRoot() + "/";
    return p.startsWith(root) ? p.slice(root.length) : p;
  }

  private configGlobToRegExp(glob: string): RegExp {
    const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    // ** crosses directories, * and ? stay inside one path segment
    const re = esc.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*");
    return new RegExp("^" + re + "$");
  }

  private configPatterns(): string[] {
    const user = (this.settings.configExcludes || "").split(/\r?\n/).map(s => s.trim().replace(/^\/+/, "")).filter(Boolean);
    return [...CONFIG_ALWAYS_SKIP, ...user];
  }

  /** True for paths (relative to .obsidian/) that must not be synced. */
  private configSkipped(rel: string): boolean {
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
  private filterConfigEntries(map: Map<string, FileSnap>) {
    for (const p of [...map.keys()]) {
      if (!this.isConfigPath(p)) continue;
      if (!this.settings.syncConfig || this.configSkipped(this.configRel(p))) map.delete(p);
    }
  }

  /**
   * Walk .obsidian/ through the adapter: config files are not part of the vault index,
   * so getFiles() never sees them.
   */
  private async listLocalConfig(): Promise<Map<string, FileSnap>> {
    const out = new Map<string, FileSnap>();
    const walk = async (dir: string) => {
      let listing: { files: string[]; folders: string[] };
      try {
        listing = await this.app.vault.adapter.list(dir);
      } catch { return; }
      for (const f of listing.files) {
        const rel = this.configRel(f);
        if (this.configSkipped(rel)) continue;
        const st = await this.app.vault.adapter.stat(f);
        out.set(f, { mtime: st?.mtime ?? 0, size: st?.size ?? 0 });
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
  private async snapshotLocal(): Promise<{ snap: Map<string, FileSnap> }> {
    const snap = new Map<string, FileSnap>();
    for (const f of this.app.vault.getFiles()) {
      if (this.isConfigPath(f.path)) continue; // .obsidian/ is listed through the adapter below
      const st = await this.app.vault.adapter.stat(f.path);
      // use the adapter stat for both fields: f.stat.size can lag behind changes made
      // outside the editor, and mixing the two sources makes change detection lie.
      snap.set(f.path, { mtime: st?.mtime ?? f.stat.mtime, size: st?.size ?? f.stat.size });
    }
    if (this.settings.syncConfig) {
      for (const [p, s] of await this.listLocalConfig()) snap.set(p, s);
    }
    return { snap };
  }

  // ---------- sync ----------
  async sync(strategyOverride?: "upload" | "download" | "merge") {
    if (this.syncing) { new Notice("Sync already in progress"); return; }
    if (!this.settings.serverUrl) { new Notice("Please configure server URL"); return; }
    const base = this.base();
    this.syncing = true;
    this.aborted = false;
    this.configTouched = false;
    this.doneCount = 0;
    this.totalCount = 0;
    this.updateRibbon();
    new Notice("Syncing...");
    const failNotice = (msg: string) => { console.error(msg); new Notice(msg); };
    try {
      // ---- phase 0: snapshots ----
      this.knownDirs = new Set();
      await this.ensureRemoteDir(base);

      const { snap: localSnap } = await this.snapshotLocal();
      const remoteSnap = await this.remoteList(base);
      this.filterConfigEntries(remoteSnap);
      const strategy = strategyOverride || this.settings.syncStrategy;
      const isMerge = strategy === "merge";

      // ---- phase 1: build action list (pure computation, no I/O) ----
      let tombs: Record<string, number> = {};
      let tombFileExisted = false;
      let expiredRemoved = 0;
      const tombRemove = new Set<string>();   // recreate-after-delete -> drop the record
      const tombAdd: Record<string, number> = {}; // new deletions to record
      if (isMerge) {
        const t = await this.readTombstones(base);
        tombs = t.deletions;
        tombFileExisted = t.existed;
        const cutoff = Date.now() - TOMBSTONE_TTL_MS;
        for (const k of Object.keys(tombs)) {
          if (tombs[k] < cutoff) { delete tombs[k]; expiredRemoved++; } // expired: give up on old records
        }
      }

      const actions: SyncAction[] = [];
      let skip = 0;
      const all = new Set([...localSnap.keys(), ...remoteSnap.keys()]);
      const handled = new Set<string>();

      // retry deletion intents that failed in earlier syncs (mirror strategies have no tombstones)
      for (const [p, pd] of Object.entries(this.pendingDeletes)) {
        const L = localSnap.get(p);
        const R = remoteSnap.get(p);
        if (pd.side === "remote") {
          if (!R || R.mtime > pd.ts + TOMBSTONE_SKEW_MS) { delete this.pendingDeletes[p]; continue; } // gone or recreated
          actions.push({ type: "deleteRemote", path: p });
        } else {
          if (!L || L.mtime > pd.ts + TOMBSTONE_SKEW_MS) { delete this.pendingDeletes[p]; continue; }
          actions.push({ type: "deleteLocal", path: p });
        }
        handled.add(p);
      }

      for (const p of all) {
        if (this.isEncodedJunk(p) || p === TOMBSTONE_FILE) { skip++; continue; }
        if (handled.has(p)) continue;
        const L = localSnap.get(p);
        const R = remoteSnap.get(p);
        const prev = this.state[p];
        const localChanged = !!L && (!prev?.local || prev.local.mtime !== L.mtime || prev.local.size !== L.size);
        const remoteChanged = !!R && (!prev?.remote || prev.remote.mtime !== R.mtime || prev.remote.size !== R.size);
        if (localChanged || remoteChanged) {
          const f = (s?: FileSnap) => s ? `${s.mtime}/${s.size}` : "-";
          console.log(`[easy-backup] decide ${p} local=${f(L)} remote=${f(R)} prev=${f(prev?.local)}|${f(prev?.remote)} lc=${localChanged} rc=${remoteChanged}`);
        }

        if (strategy === "upload") {
          // mirror local -> remote; local always wins; never download
          if (L && (!R || localChanged || remoteChanged)) {
            actions.push({ type: "upload", path: p });
          } else if (!L && R && prev?.local && this.settings.syncDeletions) {
            actions.push({ type: "deleteRemote", path: p });
            this.pendingDeletes[p] = { side: "remote", ts: Date.now() };
          }
        } else if (strategy === "download") {
          // mirror remote -> local; remote always wins; never upload
          if (R && (!L || remoteChanged || localChanged)) {
            actions.push({ type: "download", path: p });
          } else if (!R && L && prev?.remote && this.settings.syncDeletions) {
            actions.push({ type: "deleteLocal", path: p });
            this.pendingDeletes[p] = { side: "local", ts: Date.now() };
          }
        } else {
          // merge (tombstone semantics: deletions propagate explicitly)
          if (L && R) {
            if (localChanged && remoteChanged) {
              if (!prev) {
                // no sync history yet (first sync): newer side wins instead of duplicating every file
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
            if (t !== undefined) {
              if (L.mtime > t - TOMBSTONE_SKEW_MS) {
                // file was recreated locally after it was deleted elsewhere: keep it, drop the record
                tombRemove.add(p);
                actions.push({ type: "upload", path: p });
              } else {
                // tombstone says this file was deleted: apply it
                actions.push({ type: "deleteLocal", path: p });
              }
            } else if (prev?.remote) {
              if (localChanged) {
                // local was modified while remote vanished: local wins, re-upload
                actions.push({ type: "upload", path: p });
              } else {
                // remote deleted out-of-band: propagate, record tombstone
                actions.push({ type: "deleteLocal", path: p });
                tombAdd[p] = Date.now();
              }
            } else {
              // new local file
              actions.push({ type: "upload", path: p });
            }
          } else if (!L && R) {
            const t = tombs[p];
            if (t !== undefined) {
              if (R.mtime > t - TOMBSTONE_SKEW_MS) {
                // file was recreated/modified remotely after the tombstone: keep it, drop the record
                tombRemove.add(p);
                actions.push({ type: "download", path: p });
              } else {
                // tombstone says this file was deleted: apply it
                actions.push({ type: "deleteRemote", path: p });
              }
            } else if (prev?.local) {
              if (remoteChanged) {
                // remote was modified while local file was missing: accept remote change
                actions.push({ type: "download", path: p });
              } else {
                // local deleted out-of-band: propagate, record tombstone
                actions.push({ type: "deleteRemote", path: p });
                tombAdd[p] = Date.now();
              }
            } else {
              // new remote file
              actions.push({ type: "download", path: p });
            }
          }
        }
      }

      // Config files that make Obsidian act immediately (enable plugins, switch theme, rebind keys)
      // go last: otherwise a plugin list can be applied before that plugin's main.js is on disk.
      const CONFIG_TRIGGERS = ["app.json", "appearance.json", "community-plugins.json", "core-plugins.json", "hotkeys.json"];
      const isConfigTrigger = (p: string) => this.isConfigPath(p) && CONFIG_TRIGGERS.includes(this.configRel(p));
      actions.sort((a, b) => Number(isConfigTrigger(a.path)) - Number(isConfigTrigger(b.path)));
      this.totalCount = actions.length;

      // ---- phase 2: safety net for mass deletions ----
      const delLocalPaths = actions.filter(a => a.type === "deleteLocal").map(a => a.path);
      const delRemotePaths = actions.filter(a => a.type === "deleteRemote").map(a => a.path);
      const delCount = delLocalPaths.length + delRemotePaths.length;
      const threshold = this.settings.deleteConfirmThreshold;
      if (delCount > 0 && (threshold <= 0 || delCount > threshold)) {
        const ok = await this.confirmMassDelete(delLocalPaths, delRemotePaths);
        if (!ok) { new Notice("Sync cancelled: deletion not confirmed"); return; }
      }

      // ---- phase 3: pre-create remote parent dirs for uploads (sequential, race-free) ----
      const dirsNeeded = new Set<string>();
      for (const a of actions) {
        if (a.type === "upload" || a.type === "conflict") this.addAncestorDirs(base, a.path, dirsNeeded);
      }
      for (const dir of [...dirsNeeded].sort((a, b) => a.length - b.length)) {
        if (this.aborted) { new Notice("Sync cancelled"); return; }
        await this.ensureRemoteDir(dir);
      }

      // ---- phase 4: execute actions concurrently ----
      const counters = { up: 0, down: 0, del: 0, conf: 0, fail: 0 };
      const deletedRemoteDirs = new Set<string>();
      const deletedLocalPaths: string[] = [];
      const executed = new Set<string>();
      let concurrency = Number(this.settings.concurrency);
      if (!Number.isFinite(concurrency)) concurrency = 3;
      concurrency = Math.max(1, Math.min(8, concurrency));
      let idx = 0;
      const execAction = async (a: SyncAction) => {
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
            // 404 = already gone -> treat as success
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
              // both sides "changed" by mtime/size, but the content never diverged:
              // no backup copy, no diff — the next baseline records both sides as equal.
              console.log("[easy-backup] conflict but content identical:", a.path);
              break;
            }
            await this.writeLocalFile(a.conflictPath, remoteBuf);
            // a diff report inside .obsidian/ is not readable as a note; the copy is enough
            if (!this.isConfigPath(a.path)) {
              await this.writeConflictReport(
                a.conflictPath, a.path, localBuf, remoteBuf,
                localSnap.get(a.path)?.mtime, remoteSnap.get(a.path)?.mtime,
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
          } catch (e: any) {
            counters.fail++;
            failNotice("Error: " + actions[i].path + " - " + (e?.message || e));
          }
          this.doneCount = (this.doneCount || 0) + 1;
          this.updateRibbon();
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, actions.length) }, worker));

      // ---- phase 5: cleanup and finalize ----
      // prune empty folders left by deletions, serially (avoids rmdir/createBinary races in workers)
      for (const p of deletedLocalPaths) await this.pruneLocalEmptyDirs(p);
      // prune empty remote dirs left by deletions (deepest first)
      if (deletedRemoteDirs.size) {
        const dirs = [...deletedRemoteDirs].sort((a, b) => b.length - a.length);
        for (const dir of dirs) {
          if (dir === base) continue;
          if (await this.remoteDirIsEmpty(dir)) {
            try { await this.req("DELETE", dir); console.log("[easy-backup] pruned empty remote dir:", dir); } catch {}
          }
        }
      }

      // persist tombstone records.
      // tombAdd: the deletion intent is already a fact (the file is gone from its source side),
      // so it is persisted regardless of whether the remote DELETE succeeded — the tombstone
      // makes the next sync retry the deletion (self-healing), instead of resurrecting the file.
      // tombRemove (recreate-after-delete): only drop the record if the keep/upload action executed.
      if (isMerge) {
        const tombDirty = expiredRemoved > 0 || tombRemove.size > 0 || Object.keys(tombAdd).length > 0;
        if (tombDirty) {
          const final: Record<string, number> = {};
          for (const k of Object.keys(tombs)) {
            if (tombRemove.has(k) && executed.has(k)) continue; // recreate confirmed uploaded/downloaded
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

      // rebuild state from current reality
      const { snap: newLocal } = await this.snapshotLocal();
      const newRemote = await this.remoteList(base);
      this.filterConfigEntries(newRemote);
      const newState: SyncState = {};
      const union = new Set([...newLocal.keys(), ...newRemote.keys()]);
      for (const p of union) {
        if (this.isEncodedJunk(p)) continue;
        newState[p] = { local: newLocal.get(p), remote: newRemote.get(p) };
      }
      this.lastSync = { time: Date.now(), up: counters.up, down: counters.down, del: counters.del, conf: counters.conf };
      this.state = newState;
      await this.saveState();
      new Notice(`Sync done: ↑${counters.up} ↓${counters.down} ✕${counters.del} ⚠${counters.conf} ⏭${skip}${counters.fail ? " ✗" + counters.fail : ""}`);
      if (this.configTouched) {
        new Notice("Obsidian config was written — reload the app (Ctrl+R / command palette: Reload app without saving) to apply plugin changes.");
        console.log("[easy-backup] config files written this run");
      }
    } catch (e) {
      console.error(e);
      new Notice("Sync failed: " + (e?.message || e));
    } finally {
      this.syncing = false;
      this.updateRibbon();
    }
  }

  onunload() {
    this.aborted = true; // stop any in-flight sync loop
    this.activeModal?.close(); // don't leave the confirm dialog dangling
  }

  toggleSync() {
    if (this.syncing) {
      this.aborted = true;
      console.log("[easy-backup] stop requested");
      new Notice("Stopping sync...");
      this.settingTab?.refreshLastSync();
    } else {
      this.sync();
    }
  }

  /** ribbon click menu: pick the strategy for this sync (default strategy stays unchanged) */
  private showSyncMenu(evt: MouseEvent) {
    const menu = new Menu();
    const current = this.settings.syncStrategy || "merge";
    const add = (strategy: "upload" | "download" | "merge") => {
      menu.addItem((item) => {
        const marks: Record<string, string> = { upload: "⇧", download: "⇩", merge: "⇄" };
        item.setTitle(`${marks[strategy]} Sync now (${strategy})${strategy === current ? "  •default" : ""}`)
          .onClick(() => this.sync(strategy));
      });
    };
    add("merge");
    add("upload");
    add("download");
    menu.showAtMouseEvent(evt);
  }

  private ribbonLabel(): string {
    if (this.syncing) return "easy backup: syncing (click to stop)";
    const ls = this.lastSync;
    if (!ls) return "easy backup: sync";
    const t = new Date(ls.time);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `easy backup: sync (click for menu)\nLast: ${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}  ↑${ls.up} ↓${ls.down} ✕${ls.del} ⚠${ls.conf}`;
  }

  private updateRibbon() {
    if (!this.ribbonEl) return;
    const label = this.ribbonLabel();
    if (this.syncing) {
      setIcon(this.ribbonEl, "refresh-cw");
      this.ribbonEl.addClass("easy-sync-spinning");
    } else {
      this.ribbonEl.removeClass("easy-sync-spinning");
      setIcon(this.ribbonEl, "cloud-upload");
    }
    this.ribbonEl.setAttribute("aria-label", label);
    this.settingTab?.refreshLastSync(this.syncing ? { done: this.doneCount, total: this.totalCount } : undefined);
  }

  private async putBytes(url: string, data: ArrayBuffer) {
    const r = await this.reqLockAware("PUT", url, data, { "Content-Type": "application/octet-stream" });
    if (r.status < 200 || r.status >= 300) {
      const err = this.httpError("PUT", r);
      if (r.status === 423) err.message += (await this.probeLock(url)).desc;
      throw err;
    }
  }

  private async readLocalBinary(p: string): Promise<ArrayBuffer> {
    if (this.isConfigPath(p)) return this.app.vault.adapter.readBinary(p);
    const f = this.app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) throw new Error("local file missing: " + p);
    return this.app.vault.readBinary(f);
  }

  private async putLocalFile(url: string, p: string) {
    await this.putBytes(url, await this.readLocalBinary(p));
  }

  private async deleteLocalPath(p: string) {
    if (this.isConfigPath(p)) {
      this.configTouched = true;
      try { await this.app.vault.adapter.remove(p); } catch (e: any) {
        // already gone is fine
        if (!(await this.app.vault.adapter.exists(p))) return;
        throw e;
      }
      return;
    }
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) await this.app.vault.delete(f);
  }

  private async fetchBinary(url: string): Promise<ArrayBuffer> {
    const res = await this.req("GET", url);
    if (res.status < 200 || res.status >= 300 || !res.arrayBuffer) throw this.httpError("GET", res);
    return res.arrayBuffer;
  }

  private async writeLocalFile(localPath: string, buf: ArrayBuffer) {
    if (this.isConfigPath(localPath)) {
      await this.ensureLocalDirs(localPath);
      await this.app.vault.adapter.writeBinary(localPath, buf);
      this.configTouched = true;
      return;
    }
    const existing = this.app.vault.getAbstractFileByPath(localPath);
    await this.ensureParentFolders(localPath);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, buf);
    } else {
      await this.app.vault.createBinary(localPath, buf);
    }
  }

  private async downloadFile(url: string, localPath: string) {
    await this.writeLocalFile(localPath, await this.fetchBinary(url));
  }

  private fmtTime(ms?: number): string {
    if (!ms) return "-";
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** Markdown fence longer than any backtick run inside the text. */
  private fenceFor(text: string): string {
    let longest = 0;
    for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
    return "`".repeat(Math.max(3, longest + 1));
  }

  /**
   * Write "<name>.conflict-<ts>.diff.md" next to a conflict copy: a unified diff
   * between the kept local version and the remote backup, wrapped in a fence so
   * Obsidian renders it readably. Binary or oversized content is skipped.
   */
  private async writeConflictReport(conflictPath: string, localPath: string, localBuf: ArrayBuffer, remoteBuf: ArrayBuffer, localMtime?: number, remoteMtime?: number) {
    const diffPath = conflictPath.replace(/(\.[^.]+)?$/, (m) => `.diff${m || ".md"}`);
    const isText = looksLikeText(localBuf) && looksLikeText(remoteBuf);
    let body: string;
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
      `- local (kept): \`${localPath}\` — ${this.fmtTime(localMtime)}`,
      `- remote (backup): \`${conflictPath}\` — ${this.fmtTime(remoteMtime)}`,
      "",
      body,
      "",
    ].join("\n");
    await this.writeLocalFile(diffPath, this.textToBuffer(report));
  }

  private async ensureParentFolders(filePath: string) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur += (cur ? "/" : "") + p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try { await this.app.vault.createFolder(cur); } catch {}
      }
    }
  }

  /** mkdir -p through the adapter (needed for .obsidian/, which the vault API does not manage) */
  private async ensureLocalDirs(filePath: string) {
    const parts = filePath.split("/");
    parts.pop();
    let cur = "";
    for (const p of parts) {
      cur += (cur ? "/" : "") + p;
      try {
        if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.adapter.mkdir(cur);
      } catch {}
    }
  }
}

class SyncSettingTab extends PluginSettingTab {
  plugin: SelfSignedSyncPlugin;
  constructor(app: App, plugin: SelfSignedSyncPlugin) { super(app, plugin); this.plugin = plugin; }
  private lastSyncSetting: Setting | null = null;
  refreshLastSync(progress?: { done: number; total: number }) {
    if (!this.lastSyncSetting) return;
    const ls = this.plugin.lastSync;
    let status: string;
    if (this.plugin.syncing && this.plugin.aborted) status = "Stopping...";
    else if (this.plugin.syncing && progress && progress.total > 0) {
      const pct = Math.round((progress.done / progress.total) * 100);
      status = `Syncing... ${progress.done}/${progress.total} (${pct}%)`;
    } else if (this.plugin.syncing) status = "Syncing...";
    else status = ls ? `${new Date(ls.time).toLocaleString()}  ↑${ls.up} ↓${ls.down} ✕${ls.del} ⚠${ls.conf}` : "Never";
    this.lastSyncSetting.setDesc(status);
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    const ls = this.plugin.lastSync;
    const status = ls
      ? `${new Date(ls.time).toLocaleString()}  ↑${ls.up} ↓${ls.down} ✕${ls.del} ⚠${ls.conf}`
      : "Never";
    this.lastSyncSetting = new Setting(containerEl).setName("Last sync").setDesc(status);
    if (this.plugin.syncing) this.lastSyncSetting.setDesc("Syncing...");
    new Setting(containerEl).setName("Server URL").setDesc("WebDAV base URL, e.g. https://nas.local:5006").addText(t => t
      .setPlaceholder("https://...")
      .setValue(this.plugin.settings.serverUrl)
      .onChange(async v => { this.plugin.settings.serverUrl = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Username").addText(t => t.setValue(this.plugin.settings.username).onChange(async v => { this.plugin.settings.username = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Password").addText(t => { t.setValue(this.plugin.settings.password).onChange(async v => { this.plugin.settings.password = v; await this.plugin.saveSettings(); }); t.inputEl.type = "password"; });
    new Setting(containerEl).setName("Remote path").addText(t => t.setValue(this.plugin.settings.remotePath).onChange(async v => { this.plugin.settings.remotePath = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Test connection").setDesc("Verify the WebDAV URL and credentials.").addButton(b => b.setButtonText("Test").onClick(async () => {
      const base = this.plugin.base();
      if (!base) { new Notice("Please configure server URL"); return; }
      try {
        console.log("[easy-backup] testing base:", base, "user:", this.plugin.settings.username);
        let r = await this.plugin.req("PROPFIND", base, undefined, { Depth: "0" });
        if (r.status === 404) {
          await this.plugin.req("MKCOL", base);
          r = await this.plugin.req("PROPFIND", base, undefined, { Depth: "0" });
        }
        if (r.status >= 200 && r.status < 300) new Notice("Connection OK (" + r.status + ")");
        else new Notice("Connection failed: HTTP " + r.status + " @ " + base);
      } catch (e: any) {
        new Notice("Connection failed: " + (e?.message || e));
      }
    }));
    new Setting(containerEl).setName("Sync on startup").addToggle(t => t.setValue(this.plugin.settings.syncOnStartup).onChange(async v => { this.plugin.settings.syncOnStartup = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Sync strategy").addDropdown(d => d
      .addOption("upload", "Upload (overwrite remote)")
      .addOption("download", "Download (overwrite local)")
      .addOption("merge", "Merge (bidirectional)")
      .setValue(this.plugin.settings.syncStrategy)
      .onChange(async v => { this.plugin.settings.syncStrategy = v as any; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Mirror deletions (upload/download only)").setDesc("In Upload mode: deleting locally also deletes on the server. In Download mode: deleting remotely also deletes locally. Merge mode propagates deletions via tombstone records with the confirmation threshold below.").addToggle(t => t.setValue(this.plugin.settings.syncDeletions ?? true).onChange(async v => { this.plugin.settings.syncDeletions = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Delete confirmation threshold").setDesc("Ask for confirmation before a sync deletes more than this many files. 0 = always confirm any deletion.").addDropdown(d => d
      .addOption("0", "Always confirm")
      .addOption("5", "More than 5")
      .addOption("20", "More than 20 (default)")
      .addOption("50", "More than 50")
      .addOption("1000000", "Never confirm")
      .setValue(String(this.plugin.settings.deleteConfirmThreshold ?? 20))
      .onChange(async v => { this.plugin.settings.deleteConfirmThreshold = parseInt(v, 10); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Force-unlock server locks (Nextcloud)").setDesc("When an upload/delete fails with HTTP 423, release the Nextcloud files_lock entry (e.g. a stale lock left by the web Text editor) and retry once.").addToggle(t => t.setValue(this.plugin.settings.forceUnlockLocks ?? true).onChange(async v => { this.plugin.settings.forceUnlockLocks = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Concurrency").setDesc("Parallel transfer count. 2-3 is safe for most servers; higher is faster for large initial syncs.").addDropdown(d => d
      .addOption("1", "1 (sequential)")
      .addOption("2", "2")
      .addOption("3", "3 (default)")
      .addOption("4", "4")
      .addOption("6", "6")
      .addOption("8", "8")
      .setValue(String(this.plugin.settings.concurrency ?? 3))
      .onChange(async v => { this.plugin.settings.concurrency = parseInt(v, 10); await this.plugin.saveSettings(); }));
    containerEl.createEl("h3", { text: "Obsidian config sync" });
    new Setting(containerEl).setName("Sync Obsidian config (.obsidian)")
      .setDesc("Sync plugins, themes, CSS snippets, hotkeys and app settings so a new device picks up the same setup. Always excluded: workspace*.json (pane layout), cache/, .git/, and this plugin's own folder. Reload Obsidian after a run that downloads plugins.")
      .addToggle(t => t.setValue(!!this.plugin.settings.syncConfig).onChange(async v => { this.plugin.settings.syncConfig = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Include plugin settings (plugins/*/data.json)")
      .setDesc("Off by default: plugin data often holds device-specific paths or credentials (this vault's remotely-save data.json, for example). Enable only if you want every plugin preconfigured on other devices.")
      .addToggle(t => t.setValue(!!this.plugin.settings.syncPluginData).onChange(async v => { this.plugin.settings.syncPluginData = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("Config exclusions")
      .setDesc("One glob per line, relative to .obsidian/ (e.g. plugins/obsidian-git/ or snippets/private.css). * stays inside a folder, ** crosses folders.")
      .addTextArea(t => {
        t.setPlaceholder("plugins/some-plugin/\nsnippets/private.css")
          .setValue(this.plugin.settings.configExcludes || "")
          .onChange(async v => { this.plugin.settings.configExcludes = v; await this.plugin.saveSettings(); });
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
        // about twice the default width
        t.inputEl.style.minWidth = "280px";
        t.inputEl.style.maxWidth = "none";
      });
    new Setting(containerEl).setName("Manual sync").setDesc("Start sync; click again while syncing to stop.").addButton(b => b.setButtonText("Sync now").onClick(() => this.plugin.toggleSync()));
  }
}