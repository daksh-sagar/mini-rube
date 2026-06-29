import React from "react";

/**
 * A tiny, dependency-free Markdown renderer for assistant messages.
 *
 * It covers the subset the agent actually produces — headings, bullet/ordered
 * lists, bold/italic, inline code, fenced code blocks, blockquotes, and links
 * (both `[text](url)` and bare URLs). Everything is rendered into React
 * elements (never `dangerouslySetInnerHTML`), so text is escaped by React and
 * links are real, clickable anchors.
 */

type InlinePattern = {
  regex: RegExp;
  render: (match: RegExpExecArray, key: string) => React.ReactNode;
  recurse: boolean;
};

const INLINE_PATTERNS: InlinePattern[] = [
  {
    regex: /`([^`]+)`/,
    render: (m, key) => <code key={key}>{m[1]}</code>,
    recurse: false,
  },
  {
    regex: /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/,
    render: (m, key) => (
      <a key={key} href={m[2]} target="_blank" rel="noreferrer">
        {m[1]}
      </a>
    ),
    recurse: false,
  },
  {
    regex: /\*\*([^*]+)\*\*|__([^_]+)__/,
    render: (m, key) => <strong key={key}>{renderInline(m[1] ?? m[2] ?? "")}</strong>,
    recurse: true,
  },
  {
    regex: /\*([^*\n]+)\*|(?<![\w_])_([^_\n]+)_(?![\w_])/,
    render: (m, key) => <em key={key}>{renderInline(m[1] ?? m[2] ?? "")}</em>,
    recurse: true,
  },
  {
    regex: /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/,
    render: (m, key) => (
      <a key={key} href={m[1]} target="_blank" rel="noreferrer">
        {m[1]}
      </a>
    ),
    recurse: false,
  },
];

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let counter = 0;

  while (remaining.length > 0) {
    let earliest: { pattern: InlinePattern; match: RegExpExecArray } | null = null;
    for (const pattern of INLINE_PATTERNS) {
      const match = pattern.regex.exec(remaining);
      if (match && (earliest === null || match.index < earliest.match.index)) {
        earliest = { pattern, match };
      }
    }

    if (!earliest) {
      nodes.push(remaining);
      break;
    }

    const { match, pattern } = earliest;
    if (match.index > 0) {
      nodes.push(remaining.slice(0, match.index));
    }
    nodes.push(pattern.render(match, `i${counter++}`));
    remaining = remaining.slice(match.index + match[0].length);
  }

  return nodes;
}

type Block =
  | { type: "code"; content: string }
  | { type: "heading"; level: number; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "p"; text: string };

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((cell) => cell.trim());
}

// A GFM table is a row of `|`-separated cells immediately followed by a
// separator line made only of dashes/colons/pipes/spaces (with at least one -).
function isTableSeparator(line: string) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes("-");
}

function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ type: "p", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^```/.test(line.trim())) {
      flushParagraph();
      const content: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) {
        content.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", content: content.join("\n") });
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      continue;
    }

    if (/^\s*([-*+])\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+])\s+/, ""));
        i++;
      }
      i--;
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      i--;
      blocks.push({ type: "ol", items });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      blocks.push({ type: "quote", text: line.replace(/^\s*>\s?/, "") });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushParagraph();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      i += 2; // consume header + separator
      while (i < lines.length && lines[i].includes("|") && lines[i].trim() !== "") {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--;
      blocks.push({ type: "table", header, rows });
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  return blocks;
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);

  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "code":
            return (
              <pre key={index}>
                <code>{block.content}</code>
              </pre>
            );
          case "heading": {
            const level = Math.min(block.level + 2, 6);
            return React.createElement(`h${level}`, { key: index }, renderInline(block.text));
          }
          case "ul":
            return (
              <ul key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          case "table":
            return (
              <div className="md-table-wrap" key={index}>
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex}>{renderInline(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex}>{renderInline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return <blockquote key={index}>{renderInline(block.text)}</blockquote>;
          default:
            return <p key={index}>{renderInline(block.text)}</p>;
        }
      })}
    </div>
  );
}
