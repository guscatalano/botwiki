// Attachments: images and files a page can point at, stored beside the pages.
//
// Off unless WIKI_FILES says otherwise, and unavailable on a public instance in
// any case — see ENABLED below for why that is not a configuration choice.
//
// Everything that can reach the store goes through this module, so the rules
// live here rather than in each caller. That is not style. The same invariant
// spread across call sites is an invariant enforced at *some* call sites, which
// is how quarantine, identity masking and four separate counters have each
// broken in this codebase before.

import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PAGES_DIR, WikiError, slugify } from './wiki.js';

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || ''));

/**
 * Is this a public instance?
 *
 * Read more suspiciously than anywhere else in the codebase, and deliberately
 * not with `truthy`. Elsewhere an unrecognised WIKI_PUBLIC value means "not
 * public", and the cost of being wrong is that a public instance behaves like a
 * private one — inconvenient. Here the cost of being wrong is an open upload
 * endpoint on an anonymous wiki, so the question is inverted: anything that is
 * not *explicitly* an off-value counts as public.
 *
 * WIKI_PUBLIC=maybe therefore disables attachments. That is the intended
 * behaviour, not an edge case — a typo in this variable must never be the
 * reason uploads were reachable.
 */
const OFF_VALUES = new Set(['', '0', 'false', 'no', 'off']);
const PUBLIC = !OFF_VALUES.has(String(process.env.WIKI_PUBLIC ?? '').trim().toLowerCase());
const WANTED = truthy(process.env.WIKI_FILES);

/**
 * Whether this instance holds attachments at all.
 *
 * Two conditions, and the second is not overridable. A public instance takes
 * pages from pseudonymous writers and moderates them by *reading* them — a
 * queue of diffs a human approves. That review does not exist for a blob: you
 * cannot read a JPEG, the moderation queue has nothing to show, and an open
 * upload endpoint on an anonymous wiki is an image host operating under the
 * operator's name and jurisdiction. The abuse policy the public instance
 * promises is enforceable on text and is not enforceable on binaries.
 *
 * So WIKI_PUBLIC wins over WIKI_FILES, always. Setting both is a mistake worth
 * saying out loud rather than resolving quietly, which is what the warning at
 * the bottom of this file is for.
 */
export const ENABLED = WANTED && !PUBLIC;

/**
 * The same answer, recomputed from the environment on every call.
 *
 * ENABLED is a constant, and a constant can be shadowed, stubbed or imported
 * from a stale module instance. This cannot: every function that touches the
 * store calls it, so there is no path to the disk that does not re-ask the
 * question at the moment of the write.
 */
function publicNow() {
  return !OFF_VALUES.has(String(process.env.WIKI_PUBLIC ?? '').trim().toLowerCase());
}

export const FILES_DIR = path.join(PAGES_DIR, '.files');

// A floor under the per-file cap, so a typo cannot configure the feature into
// accepting nothing at all and reporting it as a size error on every upload.
const MIN_FILE_BYTES = 64 * 1024;
export const MAX_FILE_BYTES = Math.max(
  MIN_FILE_BYTES,
  Number(process.env.WIKI_MAX_FILE_BYTES) || 10 * 1024 * 1024
);
export const MAX_TOTAL_BYTES = Number(process.env.WIKI_MAX_FILES_BYTES) || 512 * 1024 * 1024;

/**
 * Disk to leave free, whatever the quota says.
 *
 * The quota is a policy about how much the wiki should hold. This is a fact
 * about the disk it holds it on, and the two disagree the moment anyone raises
 * the first without measuring the second — which is the normal way to raise it.
 *
 * Worth a separate check because filling the volume does not fail politely: the
 * derived SQLite index lives on the same disk, and a write that runs out of
 * space part-way can leave it corrupt. Losing an upload is an error message.
 * Losing the index is an outage.
 */
export const MIN_FREE_BYTES = Number(process.env.WIKI_MIN_FREE_BYTES) || 512 * 1024 * 1024;

async function freeBytes() {
  try {
    const s = await fs.statfs(FILES_DIR).catch(() => fs.statfs(PAGES_DIR));
    return s.bavail * s.bsize;
  } catch {
    // A filesystem that will not report itself is not a reason to refuse a
    // write. The quota still applies; this guard simply stands down.
    return Infinity;
  }
}

/**
 * What may be stored, and how it is served.
 *
 * An allow-list, because the alternative is deciding what is dangerous, and the
 * list of dangerous things grows without telling you.
 *
 * `inline` says the browser may render it in place. Everything else is served
 * as an attachment: a download, never a document in this origin. That
 * distinction is the whole security model here — see serveHeaders().
 *
 * `magic` is a signature the bytes must actually start with. An extension is a
 * claim by the uploader; this checks it. It catches the honest mistake and the
 * polyglot alike, and it is skipped only for formats that genuinely have no
 * signature (plain text and its relatives).
 */
export const TYPES = {
  png: { mime: 'image/png', inline: true, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  jpg: { mime: 'image/jpeg', inline: true, magic: [0xff, 0xd8, 0xff] },
  jpeg: { mime: 'image/jpeg', inline: true, magic: [0xff, 0xd8, 0xff] },
  gif: { mime: 'image/gif', inline: true, magic: [0x47, 0x49, 0x46, 0x38] },
  webp: { mime: 'image/webp', inline: true, magic: [0x52, 0x49, 0x46, 0x46], magicAt8: 'WEBP' },
  avif: { mime: 'image/avif', inline: true, magicAt4: 'ftyp' },
  // SVG is the exception that shapes the rest of this file. It is not an image;
  // it is a document that can carry script. Rendered as a top-level page from
  // this origin it is stored XSS with the operator's session — on a wiki whose
  // pages are written by agents, and in the one format an agent can author as
  // plain text. It is still allowed, because a diagram is worth having, but it
  // is never `inline`: navigating to it downloads it. Embedding it with
  // <img src> stays safe and stays working, because script in an SVG does not
  // run when the SVG is a subresource.
  svg: { mime: 'image/svg+xml', inline: false, kind: 'image', sandbox: true },
  pdf: { mime: 'application/pdf', inline: false, magic: [0x25, 0x50, 0x44, 0x46, 0x2d] },
  txt: { mime: 'text/plain', inline: false },
  md: { mime: 'text/markdown', inline: false },
  csv: { mime: 'text/csv', inline: false },
  json: { mime: 'application/json', inline: false },
  yaml: { mime: 'application/yaml', inline: false },
  yml: { mime: 'application/yaml', inline: false },
  log: { mime: 'text/plain', inline: false },
  zip: { mime: 'application/zip', inline: false, magic: [0x50, 0x4b, 0x03, 0x04] },
  gz: { mime: 'application/gzip', inline: false, magic: [0x1f, 0x8b] },
  // Video and audio render in place, which is safe for the same reason the
  // image formats are: a decoder is not an interpreter. The browser has no way
  // to reach the page from inside a media container, so `inline` here buys a
  // player and grants nothing.
  mp4: { mime: 'video/mp4', inline: true, kind: 'video', magicAt4: 'ftyp' },
  m4v: { mime: 'video/mp4', inline: true, kind: 'video', magicAt4: 'ftyp' },
  mov: { mime: 'video/quicktime', inline: true, kind: 'video', magicAt4: 'ftyp' },
  webm: { mime: 'video/webm', inline: true, kind: 'video', magic: [0x1a, 0x45, 0xdf, 0xa3] },
  mp3: { mime: 'audio/mpeg', inline: true, kind: 'audio' },
  m4a: { mime: 'audio/mp4', inline: true, kind: 'audio', magicAt4: 'ftyp' },
  ogg: { mime: 'audio/ogg', inline: true, kind: 'audio', magic: [0x4f, 0x67, 0x67, 0x53] },
  wav: { mime: 'audio/wav', inline: true, kind: 'audio', magic: [0x52, 0x49, 0x46, 0x46], magicAt8: 'WAVE' },
};

/** What an extension is for, as far as rendering is concerned. */
export const kindOf = (ext) => TYPES[ext]?.kind || (TYPES[ext]?.inline ? 'image' : 'doc');

export const EXTENSIONS = Object.keys(TYPES).sort();

/**
 * Attachments are NOT versioned, and the store says so itself.
 *
 * The pages directory is a git repository that a timer commits hourly, which is
 * right for markdown and wrong for binaries. A 9 MB clip costs 9 MB in the
 * working tree and 9 MB in the object store, replacing it keeps both copies
 * forever, and nothing ever gives that space back short of rewriting history.
 * Ten videos took one instance from 3 MB to 73 MB in an hour.
 *
 * Binaries in git want git-lfs or an object store, not a .git directory that
 * only grows. Until there is one, the honest answer is not to track them.
 *
 * The cost is real and is not hidden: `git revert` no longer undoes a bad
 * upload, because there is nothing to revert to. Deleting a file deletes it.
 *
 * This lives here rather than in the installer so it holds for every instance,
 * including one whose pages directory became a git repo after the fact.
 */
const GITIGNORE = `# Attachments are deliberately not versioned.
#
# This directory holds binaries. Committing them to the pages repo costs their
# size twice over and keeps every superseded copy forever, on a repo a timer
# commits hourly. Use git-lfs or an object store if you need their history.
#
# Consequence: deleting a file here is permanent. There is no revert.
*
!.gitignore
`;

async function ensureFilesDir() {
  await fs.mkdir(FILES_DIR, { recursive: true });
  const marker = path.join(FILES_DIR, '.gitignore');
  try {
    await fs.access(marker);
  } catch {
    await fs.writeFile(marker, GITIGNORE);
  }
}

function requireEnabled() {
  // Checked in this order on purpose. The public test is not a branch of the
  // enabled test, it is a separate gate that comes first, so that no future
  // edit to how ENABLED is computed can produce a path where a public instance
  // reaches the disk.
  if (publicNow()) {
    throw new WikiError('Attachments are not available on a public instance.', 'files_disabled');
  }
  if (ENABLED) return;
  throw new WikiError('Attachments are off. Set WIKI_FILES=1 to enable them.', 'files_disabled');
}

/**
 * Turn a caller-supplied name into a path inside the attachment directory.
 *
 * Deliberately a sibling of pathForSlug rather than a widening of it. That
 * function is the only thing standing between user input and the filesystem for
 * every page in the wiki, and it guarantees a `.md` file; teaching it about
 * arbitrary extensions to save twenty lines here would put attachments and
 * pages behind one blast radius.
 */
export function pathForFile(name) {
  const raw = String(name ?? '').trim();
  if (
    /^[/\\]/.test(raw) ||
    /^[a-zA-Z]:[/\\]/.test(raw) ||
    raw.split(/[/\\]/).some((seg) => seg === '..' || seg === '.') ||
    raw.includes('\0')
  ) {
    throw new WikiError(
      `Refusing file name ${JSON.stringify(name)}: it must be a relative name, not a filesystem path.`,
      'invalid_file'
    );
  }

  const dot = raw.lastIndexOf('.');
  const ext = dot === -1 ? '' : raw.slice(dot + 1).toLowerCase();
  if (!Object.hasOwn(TYPES, ext)) {
    throw new WikiError(
      `Unsupported file type ${JSON.stringify(ext || '(none)')}. Allowed: ${EXTENSIONS.join(', ')}.`,
      'invalid_file'
    );
  }

  // The stem goes through the same slug rules a page name does, so an
  // attachment is as quotable and as typo-proof as the pages around it.
  const stem = slugify(raw.slice(0, dot));
  if (!stem) {
    throw new WikiError(
      `Invalid file name: ${JSON.stringify(name)}. Use lowercase letters, digits and dashes, optionally in folders.`,
      'invalid_file'
    );
  }

  const clean = `${stem}.${ext}`;
  const abs = path.resolve(FILES_DIR, clean);
  const root = FILES_DIR.endsWith(path.sep) ? FILES_DIR : FILES_DIR + path.sep;
  if (!abs.startsWith(root)) {
    throw new WikiError(`File name escapes the attachment directory: ${name}`, 'invalid_file');
  }
  return { name: clean, ext, abs, type: TYPES[ext] };
}

function checkMagic(buf, ext, type) {
  if (type.magic && !type.magic.every((b, i) => buf[i] === b)) return false;
  if (type.magicAt4 && buf.slice(4, 8).toString('latin1') !== type.magicAt4) return false;
  if (type.magicAt8 && buf.slice(8, 12).toString('latin1') !== type.magicAt8) return false;
  // SVG has no byte signature, but it does have a required root element, and
  // requiring it is what stops `.svg` from being a way to store arbitrary bytes
  // under an image content-type.
  if (ext === 'svg' && !/<svg[\s>]/i.test(buf.slice(0, 4096).toString('utf8'))) return false;
  // MP3 is the one format here with no single signature: a file may open with an
  // ID3 tag or straight into a frame, and the frame header is a bit pattern
  // rather than a constant. Both are accepted; anything else is not an MP3.
  if (ext === 'mp3') {
    const id3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
    const frame = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0;
    if (!id3 && !frame) return false;
  }
  return true;
}

/** Bytes currently held, and how many files. */
export async function usage() {
  const files = await listFiles();
  return { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/** Store one file. Overwrites by name, which is what re-uploading means. */
export async function putFile(name, data, { agent = '' } = {}) {
  requireEnabled();
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const { name: clean, ext, abs, type } = pathForFile(name);

  if (!buf.length) throw new WikiError('Refusing to store an empty file.', 'empty_file');
  if (buf.length > MAX_FILE_BYTES) {
    throw new WikiError(
      `File is ${buf.length} bytes; the limit is ${MAX_FILE_BYTES}. Raise WIKI_MAX_FILE_BYTES if that is wrong.`,
      'too_large'
    );
  }
  if (!checkMagic(buf, ext, type)) {
    throw new WikiError(
      `That does not look like a ${ext} file. The extension has to match the bytes.`,
      'wrong_type'
    );
  }

  // The total cap is checked against what this write would leave behind, and a
  // replacement of an existing file is measured as a delta rather than as a
  // fresh addition — otherwise a wiki sitting near the cap could no longer fix
  // the very file that filled it.
  const free = await freeBytes();
  if (free - buf.length < MIN_FREE_BYTES) {
    throw new WikiError(
      `Not enough disk: ${free} bytes free, and this wiki keeps ${MIN_FREE_BYTES} in reserve. Delete something or grow the volume.`,
      'no_space'
    );
  }

  const existing = await statFile(clean);
  const { bytes } = await usage();
  const after = bytes - (existing?.size || 0) + buf.length;
  if (after > MAX_TOTAL_BYTES) {
    throw new WikiError(
      `Attachments would total ${after} bytes; the limit is ${MAX_TOTAL_BYTES}. Delete something or raise WIKI_MAX_FILES_BYTES.`,
      'quota'
    );
  }

  await ensureFilesDir();
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Written to a temp name and renamed, so a reader never sees a half-written
  // image and a failed upload never replaces a good file with a truncated one.
  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmp, buf);
  await fs.rename(tmp, abs);

  return {
    name: clean,
    url: `/files/${clean}`,
    size: buf.length,
    mime: type.mime,
    kind: kindOf(ext),
    sha256: createHash('sha256').update(buf).digest('hex'),
    replaced: Boolean(existing),
    agent: agent || undefined,
    markdown: type.inline ? `![${stemOf(clean)}](/files/${clean})` : `[${stemOf(clean)}](/files/${clean})`,
  };
}

const stemOf = (name) => name.replace(/\.[^.]+$/, '').split('/').pop();

/**
 * Store a file from a stream, without ever holding it whole in memory.
 *
 * Same rules as putFile — this is not a relaxed path, it is the same path for
 * things too big to buffer, which is every video worth having a player for.
 *
 * The order matters. Bytes go to a temp file as they arrive, the signature is
 * checked from the head as soon as there is enough of it, and the size cap is
 * enforced while writing rather than after: a caller that lies about
 * content-length must be stopped mid-upload, not discovered afterwards having
 * already been allowed to write the disk full.
 */
export async function putStream(name, readable, { agent = '', expect = 0 } = {}) {
  requireEnabled();
  const { name: clean, ext, abs, type } = pathForFile(name);

  // Checked before a byte is written, not after: by the time a stream has been
  // spooled to disk the space is already gone, which is precisely the thing
  // this is meant to prevent. `expect` is the declared content-length when the
  // caller has one, so an upload that cannot possibly fit is refused up front
  // rather than after several minutes of transfer.
  const free = await freeBytes();
  if (free - (Number(expect) || 0) < MIN_FREE_BYTES) {
    throw new WikiError(
      `Not enough disk: ${free} bytes free, and this wiki keeps ${MIN_FREE_BYTES} in reserve. Delete something or grow the volume.`,
      'no_space'
    );
  }

  await ensureFilesDir();
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const tmp = `${abs}.tmp.${process.pid}.${Date.now()}`;
  const hash = createHash('sha256');
  const head = [];
  let headLen = 0;
  let size = 0;
  let failure = null;

  const out = createWriteStream(tmp);
  try {
    await new Promise((resolve, reject) => {
      readable.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      readable.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) {
          failure = new WikiError(
            `File exceeds the ${MAX_FILE_BYTES} byte limit. Raise WIKI_MAX_FILE_BYTES if that is wrong.`,
            'too_large'
          );
          readable.destroy();
          out.end();
          return;
        }
        if (headLen < 4096) {
          head.push(chunk.subarray(0, 4096 - headLen));
          headLen += Math.min(chunk.length, 4096 - headLen);
        }
        hash.update(chunk);
        if (!out.write(chunk)) {
          readable.pause();
          out.once('drain', () => readable.resume());
        }
      });
      readable.on('end', () => out.end());
    });

    if (failure) throw failure;
    if (!size) throw new WikiError('Refusing to store an empty file.', 'empty_file');
    if (!checkMagic(Buffer.concat(head), ext, type)) {
      throw new WikiError(`That does not look like a ${ext} file. The extension has to match the bytes.`, 'wrong_type');
    }

    const existing = await statFile(clean);
    const { bytes } = await usage();
    // listFiles skips temp names, so `bytes` does not include what was just
    // written and this is the total the rename would leave behind. Replacing a
    // file counts as the difference, not as a fresh addition.
    const after = bytes - (existing?.size || 0) + size;
    if (after > MAX_TOTAL_BYTES) {
      throw new WikiError(
        `Attachments would total ${after} bytes; the limit is ${MAX_TOTAL_BYTES}. Delete something or raise WIKI_MAX_FILES_BYTES.`,
        'quota'
      );
    }

    await fs.rename(tmp, abs);
    return {
      name: clean,
      url: `/files/${clean}`,
      size,
      mime: type.mime,
      kind: kindOf(ext),
      sha256: hash.digest('hex'),
      replaced: Boolean(existing),
      agent: agent || undefined,
      markdown: type.inline ? `![${stemOf(clean)}](/files/${clean})` : `[${stemOf(clean)}](/files/${clean})`,
    };
  } catch (err) {
    // A rejected upload must leave nothing behind, including when it was
    // rejected for being too big — which is exactly the case where leaving the
    // partial file behind would matter most.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Metadata for one file, or null if it is not there. */
export async function statFile(name) {
  if (!ENABLED || publicNow()) return null;
  let resolved;
  try {
    resolved = pathForFile(name);
  } catch {
    return null;
  }
  try {
    const st = await fs.stat(resolved.abs);
    if (!st.isFile()) return null;
    return {
      name: resolved.name,
      url: `/files/${resolved.name}`,
      ext: resolved.ext,
      mime: resolved.type.mime,
      kind: kindOf(resolved.ext),
      inline: Boolean(resolved.type.inline),
      sandbox: Boolean(resolved.type.sandbox),
      size: st.size,
      modified: st.mtime.toISOString(),
      abs: resolved.abs,
    };
  } catch {
    return null;
  }
}

/** The bytes, or null. Whole-file, so not for anything large — see openFile. */
export async function readFile(name) {
  requireEnabled();
  const st = await statFile(name);
  if (!st) return null;
  return { ...st, data: await fs.readFile(st.abs) };
}

/**
 * A readable stream over part or all of a file.
 *
 * This is what makes a video playable rather than merely stored. A browser
 * seeking in a video asks for a byte range, and it decides whether it is even
 * allowed to ask by looking for `accept-ranges` on the first response. Answer
 * every request with the whole file and the player still works, in the sense
 * that it plays from the start once the entire file has arrived — the scrub bar
 * does nothing and a 300 MB clip is a 300 MB download before the first frame.
 *
 * Streaming also keeps the file out of this process's memory. Reading a video
 * into a Buffer to write it straight back out costs its full size in RSS per
 * concurrent viewer, which is the kind of thing that works in testing with one
 * viewer and a small file.
 */
export async function openFile(name, { start, end } = {}) {
  requireEnabled();
  const st = await statFile(name);
  if (!st) return null;
  const from = Number.isInteger(start) ? start : 0;
  const to = Number.isInteger(end) ? end : st.size - 1;
  return { ...st, start: from, end: to, length: to - from + 1, stream: createReadStream(st.abs, { start: from, end: to }) };
}

/**
 * Parse a Range header against a known file size.
 *
 * Returns null for "no range asked for", `{ unsatisfiable: true }` for a range
 * that cannot be served — which is a 416 and not a 200, because answering a
 * request for bytes that do not exist with the whole file is how a player ends
 * up decoding the beginning of a file as if it were the middle.
 *
 * Only the single-range form is handled. Multi-range replies are multipart, no
 * player asks for them, and a half-implemented one is worse than none.
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return { unsatisfiable: true };

  let start;
  let end;
  if (rawStart === '') {
    // "bytes=-500" means the last 500 bytes, not the first 500. Getting this
    // backwards serves plausible-looking wrong data rather than failing.
    const tail = Number(rawEnd);
    if (!tail) return { unsatisfiable: true };
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start > end || start >= size) {
    return { unsatisfiable: true };
  }
  return { start, end };
}

export async function listFiles() {
  if (!ENABLED || publicNow()) return [];
  const out = [];
  const walk = async (dir, prefix) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(dir, e.name), rel);
      } else if (e.isFile() && !e.name.includes('.tmp.')) {
        const st = await statFile(rel);
        if (st) out.push(st);
      }
    }
  };
  await walk(FILES_DIR, '');
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function deleteFile(name) {
  requireEnabled();
  const { abs, name: clean } = pathForFile(name);
  try {
    await fs.unlink(abs);
  } catch (err) {
    if (err.code === 'ENOENT') return { deleted: false, name: clean };
    throw err;
  }
  return { deleted: true, name: clean };
}

/**
 * Every attachment a page body points at.
 *
 * Matches the markdown and HTML forms alike, because a page may reference a
 * file without embedding it, and a link is a reference for the purpose of
 * "is anything still using this".
 */
export function fileRefs(body) {
  const out = new Set();
  for (const m of String(body || '').matchAll(/\/files\/([a-z0-9][a-z0-9._/-]*)/gi)) {
    out.add(m[1].toLowerCase());
  }
  return out;
}

if (WANTED && PUBLIC) {
  console.warn(
    '[files] WIKI_FILES is set but this is a public instance (WIKI_PUBLIC). ' +
      'Attachments stay OFF: uploads cannot be moderated by reading them.'
  );
}
