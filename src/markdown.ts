/**
 * Convert standard markdown (as output by Claude) to Telegram HTML.
 *
 * Telegram's "HTML" parse_mode supports a small tag set:
 *   <b> <i> <u> <s> <code> <pre> <a> <tg-spoiler> <blockquote> <blockquote expandable>
 * It is NOT real HTML — only those tags are allowed and the text content must
 * have &, <, > escaped. Anything else (raw "<", stray tags) makes Telegram
 * reject the whole message, so we escape aggressively and only emit known tags.
 *
 * Handles: fenced code blocks, inline code, tables, blockquotes (incl. the
 * expandable variant for long quotes), headers, horizontal rules, list bullets,
 * bold, italic, strikethrough, and links.
 */

// A blockquote longer than this (lines or chars) is rendered collapsed.
const EXPANDABLE_BQ_LINES = 5;
const EXPANDABLE_BQ_CHARS = 300;

export function markdownToTelegramHtml(md: string): string {
  // Placeholders hold already-finished HTML that must survive escaping and
  // inline-formatting untouched. \x00 markers can't appear in real text.
  const placeholders: string[] = [];
  function protect(html: string): string {
    const idx = placeholders.length;
    placeholders.push(html);
    return `\x00PH${idx}\x00`;
  }

  let text = md;

  // 1. Fenced code blocks: ```lang\n...```
  text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return protect(`<pre><code${langAttr}>${escaped}</code></pre>`);
  });

  // 2. Markdown tables -> monospace <pre> so columns line up on mobile.
  //    (Telegram has no table markup; raw pipes are unreadable.)
  text = protectTables(text, protect);

  // 3. Inline code: `...`
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => protect(`<code>${escapeHtml(code)}</code>`));

  // 4. Escape &, <, > in everything that's left (real prose). Placeholders are
  //    \x00 markers and contain none of these, so they're unaffected. This is
  //    the step the old converter silently skipped, which broke any message
  //    containing a bare "<", ">" or "&".
  text = escapeHtml(text);

  // 5. Block-level structure, line based. Note ">" is now "&gt;".
  text = renderBlockquotes(text, protect);
  text = text
    // Horizontal rules: ---, ***, ___ (escaping left these intact).
    .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "──────────")
    // Headers: # .. ###### -> bold.
    .replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, "<b>$1</b>")
    // List bullets: -, *, + -> • (keep indentation).
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ");

  // 6. Inline formatting on escaped prose.
  text = applyInline(text);

  // 7. Restore protected HTML.
  text = text.replace(/\x00PH(\d+)\x00/g, (_m, idx) => placeholders[parseInt(idx)]);

  return text;
}

function applyInline(text: string): string {
  return text
    // Bold: **text** or __text__
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/__(.+?)__/g, "<b>$1</b>")
    // Italic: *text*
    .replace(/(?<!\w)\*(?!\*)(.+?)(?<!\*)\*(?!\w)/g, "<i>$1</i>")
    // Italic: _text_
    .replace(/(?<!\w)_(?!_)(.+?)(?<!_)_(?!\w)/g, "<i>$1</i>")
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    // Links: [text](url)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Group runs of consecutive "> " lines into <blockquote>. Long quotes use the
 * expandable (collapsed) variant. Runs after HTML escaping, so the marker is
 * "&gt;" rather than ">".
 */
function renderBlockquotes(text: string, protect: (html: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (/^[ \t]*&gt;[ \t]?/.test(lines[i])) {
      const quoted: string[] = [];
      while (i < lines.length && /^[ \t]*&gt;[ \t]?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^[ \t]*&gt;[ \t]?/, ""));
        i++;
      }
      const inner = quoted.join("\n");
      const expandable =
        quoted.length >= EXPANDABLE_BQ_LINES || inner.length >= EXPANDABLE_BQ_CHARS;
      const tag = expandable ? "<blockquote expandable>" : "<blockquote>";
      // Inline-format the inner content now, then protect the wrapped result so
      // step 6 doesn't double-process the tags.
      out.push(protect(`${tag}${applyInline(inner)}</blockquote>`));
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/**
 * Detect GitHub-style markdown tables and wrap each in a <pre> block so the
 * monospace font aligns the columns. Claude pads its table source, so a verbatim
 * monospace render reads cleanly. Returns text with tables replaced by
 * placeholders.
 */
function protectTables(text: string, protect: (html: string) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const isRow = (l: string) => /^[ \t]*\|.*\|[ \t]*$/.test(l);
    const isSep = (l: string) => /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/.test(l);
    if (isRow(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      const block: string[] = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && isRow(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      out.push(protect(`<pre>${escapeHtml(block.join("\n"))}</pre>`));
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
