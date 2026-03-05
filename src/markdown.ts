/**
 * Convert standard markdown (as output by Claude) to Telegram HTML.
 * Handles code blocks, inline code, bold, italic, strikethrough, and links.
 */
export function markdownToTelegramHtml(md: string): string {
  // Placeholders for protected content
  const placeholders: string[] = [];
  function protect(content: string): string {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  }

  let text = md;

  // 1. Extract fenced code blocks (``` ... ```)
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const escaped = escapeHtml(code.replace(/\n$/, ""));
    const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
    return protect(`<pre><code${langAttr}>${escaped}</code></pre>`);
  });

  // 2. Extract inline code (` ... `)
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    return protect(`<code>${escapeHtml(code)}</code>`);
  });

  // 3. Escape HTML in remaining text
  text = text.replace(/[^]*?/gs, (segment) => {
    // Only escape segments that aren't placeholders
    return segment.replace(/[&<>]/g, (ch) => {
      if (ch === "&") return "&amp;";
      if (ch === "<") return "&lt;";
      return "&gt;";
    });
  });

  // 4. Bold: **text**
  text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");

  // 5. Italic: *text* (but not inside bold tags)
  text = text.replace(/(?<!\w)\*(?!\*)(.+?)(?<!\*)\*(?!\w)/g, "<i>$1</i>");

  // 6. Italic: _text_
  text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

  // 7. Strikethrough: ~~text~~
  text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // 8. Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // 9. Headers: # text -> bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Restore placeholders
  text = text.replace(/\x00PH(\d+)\x00/g, (_m, idx) => placeholders[parseInt(idx)]);

  return text;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
