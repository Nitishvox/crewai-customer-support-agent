/* markdown.js: safe Markdown renderer for AI replies.
 * Builds DOM nodes only (createElement and textContent). It never uses
 * innerHTML, so model output cannot run scripts or inject markup.
 * Exposes window.renderMarkdown(text) -> HTMLElement
 */
(() => {
  "use strict";

  // Inline patterns, in priority order. Groups:
  // 1 code | 2 link text | 3 link url | 4 bold-italic | 5 bold | 6 bold (__)
  // 7 italic (*) | 8 italic (_)
  const INLINE_PATTERN =
    /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\*\*\*([^*\n]+?)\*\*\*|\*\*([^*\n]+?)\*\*|__([^_\n]+?)__|\*([^*\s][^*\n]*?)\*|(?<!\w)_([^_\s][^_\n]*?)_(?!\w)/;

  const HR = /^([-*_])(\s*\1){2,}$/;
  const HEADING = /^(#{1,4})\s+(.+)$/;
  const BULLET = /^[-*+]\s+(.+)$/;
  const ORDERED = /^\d+[.)]\s+(.+)$/;
  const FENCE = /^```/;
  const QUOTE = /^>\s?(.*)$/;
  const TABLE_SEPARATOR = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;

  function appendWrapped(tagName, content, parent) {
    const element = document.createElement(tagName);
    renderInline(content, element);
    parent.appendChild(element);
  }

  function renderInline(text, parent) {
    const pattern = new RegExp(INLINE_PATTERN.source, "g");
    let last = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) {
        parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      }

      const [, code, linkText, url, boldItalic, bold, boldAlt, italic, italicAlt] = match;

      if (code !== undefined) {
        const element = document.createElement("code");
        element.textContent = code;
        parent.appendChild(element);
      } else if (linkText !== undefined) {
        const link = document.createElement("a");
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        renderInline(linkText, link);
        parent.appendChild(link);
      } else if (boldItalic !== undefined) {
        const strong = document.createElement("strong");
        const em = document.createElement("em");
        em.textContent = boldItalic;
        strong.appendChild(em);
        parent.appendChild(strong);
      } else if (bold !== undefined || boldAlt !== undefined) {
        appendWrapped("strong", bold ?? boldAlt, parent);
      } else {
        appendWrapped("em", italic ?? italicAlt, parent);
      }

      last = pattern.lastIndex;
    }

    if (last < text.length) {
      parent.appendChild(document.createTextNode(text.slice(last)));
    }
  }

  function splitRow(row) {
    return row
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  function buildTable(headers, rows) {
    const wrapper = document.createElement("div");
    wrapper.className = "table-wrap";

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");

    headers.forEach((text) => {
      const th = document.createElement("th");
      renderInline(text, th);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);

    const tbody = document.createElement("tbody");
    rows.forEach((cells) => {
      const tr = document.createElement("tr");
      headers.forEach((_, index) => {
        const td = document.createElement("td");
        renderInline(cells[index] ?? "", td);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    table.append(thead, tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  function isBlockStart(line) {
    return (
      HR.test(line) ||
      HEADING.test(line) ||
      BULLET.test(line) ||
      ORDERED.test(line) ||
      FENCE.test(line) ||
      QUOTE.test(line)
    );
  }

  function renderMarkdown(source) {
    const root = document.createElement("div");
    root.className = "md";

    const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();

      if (!line) {
        i += 1;
        continue;
      }

      // Fenced code block
      if (FENCE.test(line)) {
        const code = [];
        i += 1;
        while (i < lines.length && !FENCE.test(lines[i].trim())) {
          code.push(lines[i]);
          i += 1;
        }
        i += 1; // skip closing fence

        const pre = document.createElement("pre");
        const codeEl = document.createElement("code");
        codeEl.textContent = code.join("\n");
        pre.appendChild(codeEl);
        root.appendChild(pre);
        continue;
      }

      // Horizontal rule
      if (HR.test(line)) {
        root.appendChild(document.createElement("hr"));
        i += 1;
        continue;
      }

      // Heading (# becomes h3, ## h4, ### and deeper become h5)
      const heading = HEADING.exec(line);
      if (heading) {
        const level = Math.min(heading[1].length + 2, 5);
        const element = document.createElement(`h${level}`);
        renderInline(heading[2], element);
        root.appendChild(element);
        i += 1;
        continue;
      }

      // Blockquote
      if (QUOTE.test(line)) {
        const quote = document.createElement("blockquote");
        const parts = [];
        while (i < lines.length && QUOTE.test(lines[i].trim())) {
          parts.push(QUOTE.exec(lines[i].trim())[1]);
          i += 1;
        }
        renderInline(parts.join(" "), quote);
        root.appendChild(quote);
        continue;
      }

      // Table: a header row followed by a separator row such as |---|---|
      if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1].trim())) {
        const headers = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          rows.push(splitRow(lines[i].trim()));
          i += 1;
        }
        root.appendChild(buildTable(headers, rows));
        continue;
      }

      // Bullet or numbered list
      if (BULLET.test(line) || ORDERED.test(line)) {
        const ordered = ORDERED.test(line);
        const itemPattern = ordered ? ORDERED : BULLET;
        const list = document.createElement(ordered ? "ol" : "ul");

        while (i < lines.length) {
          const match = itemPattern.exec(lines[i].trim());
          if (!match) break;
          const item = document.createElement("li");
          renderInline(match[1], item);
          list.appendChild(item);
          i += 1;
        }
        root.appendChild(list);
        continue;
      }

      // Paragraph: keep line breaks inside it
      const paragraph = document.createElement("p");
      const start = i;
      while (i < lines.length) {
        const current = lines[i].trim();
        if (!current || isBlockStart(current)) break;
        if (i > start) paragraph.appendChild(document.createElement("br"));
        renderInline(current, paragraph);
        i += 1;
      }
      if (i === start) {
        // Safety net so the loop always moves forward
        renderInline(line, paragraph);
        i += 1;
      }
      root.appendChild(paragraph);
    }

    return root;
  }

  window.renderMarkdown = renderMarkdown;
})();
