/**
 * 轻量级 Markdown ⇄ HTML 双向转换器（零依赖，浏览器端）
 *
 * - mdToHtml(md)  ：Markdown → HTML（自写解析，覆盖博客常见语法；允许内嵌 HTML）
 * - htmlToMd(html)：HTML → Markdown（基于浏览器原生 DOMParser 遍历 DOM）
 *
 * 设计取舍：Markdown 表达能力 < HTML，往返不保证无损。无法用 Markdown 表达的
 * 标签（video / iframe / svg 等）在 HTML→MD 时原样保留，mdToHtml 不转义尖括号，
 * 因此这类原始 HTML 能正确往返。
 *
 * 挂载到 window.MDHTML。
 */
(function (global) {
  "use strict";

  // 行内代码占位符（私用区字符，正常文本不会出现，避免冲突）
  const CODE_OPEN = "";
  const CODE_CLOSE = "";

  // ===== Markdown → HTML =====
  function escapeCode(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function inlineMd(text) {
    // 先用占位符保护行内代码，避免其内部被其它规则处理
    const codes = [];
    text = text.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return CODE_OPEN + (codes.length - 1) + CODE_CLOSE;
    });

    // 图片：![alt](url "title")
    text = text.replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (m, alt, url, title) =>
        `<img src="${url}" alt="${alt}"${title ? ` title="${title}"` : ""} style="max-width:100%;border-radius:8px;" />`
    );
    // 链接：[text](url "title")
    text = text.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (m, t, url, title) =>
        `<a href="${url}"${title ? ` title="${title}"` : ""} target="_blank" rel="noopener">${t}</a>`
    );
    // 粗体
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // 斜体（避免吃掉粗体残留的单星）
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    // 删除线
    text = text.replace(/~~([^~]+)~~/g, "<s>$1</s>");

    // 还原行内代码
    text = text.replace(
      new RegExp(CODE_OPEN + "(\\d+)" + CODE_CLOSE, "g"),
      (m, n) => `<code>${escapeCode(codes[n])}</code>`
    );
    return text;
  }

  const RE_BLOCK_START = /^(#{1,6}\s|```|~~~|\s*>|\s*[-*+]\s|\s*\d+\.\s|\s*<)/;
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;

  function mdToHtml(md) {
    md = String(md || "").replace(/\r\n?/g, "\n");
    const lines = md.split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 空行
      if (!line.trim()) {
        i++;
        continue;
      }

      // 围栏代码块
      const fence = line.match(/^(```|~~~)(.*)$/);
      if (fence) {
        const lang = (fence[2] || "").trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^(```|~~~)\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        i++; // 跳过结束围栏
        out.push(
          `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeCode(buf.join("\n"))}</code></pre>`
        );
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const lv = h[1].length;
        out.push(`<h${lv}>${inlineMd(h[2].trim())}</h${lv}>`);
        i++;
        continue;
      }

      // 分割线
      if (RE_HR.test(line)) {
        out.push("<hr />");
        i++;
        continue;
      }

      // 引用（合并连续 > 行后递归处理内部）
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          buf.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        out.push(`<blockquote>${mdToHtml(buf.join("\n"))}</blockquote>`);
        continue;
      }

      // 表格：当前行含 |，下一行是分隔行 |---|---|
      if (
        line.includes("|") &&
        i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
        lines[i + 1].includes("-")
      ) {
        const parseRow = (r) =>
          r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
        const headers = parseRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(parseRow(lines[i]));
          i++;
        }
        let t =
          "<table><thead><tr>" +
          headers.map((c) => `<th>${inlineMd(c)}</th>`).join("") +
          "</tr></thead><tbody>";
        rows.forEach((r) => {
          t += "<tr>" + r.map((c) => `<td>${inlineMd(c)}</td>`).join("") + "</tr>";
        });
        t += "</tbody></table>";
        out.push(t);
        continue;
      }

      // 无序列表
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i++;
        }
        out.push("<ul>" + items.map((it) => `<li>${inlineMd(it)}</li>`).join("") + "</ul>");
        continue;
      }

      // 有序列表
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
          i++;
        }
        out.push("<ol>" + items.map((it) => `<li>${inlineMd(it)}</li>`).join("") + "</ol>");
        continue;
      }

      // 原始 HTML 块（以 < 开头），原样收集到空行
      if (/^\s*</.test(line)) {
        const buf = [];
        while (i < lines.length && lines[i].trim()) {
          buf.push(lines[i]);
          i++;
        }
        out.push(buf.join("\n"));
        continue;
      }

      // 普通段落：收集到空行或下一个块级起始
      const buf = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !RE_BLOCK_START.test(lines[i]) &&
        !RE_HR.test(lines[i])
      ) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) {
        out.push("<p>" + inlineMd(buf.join("\n")).replace(/\n/g, "<br>\n") + "</p>");
      } else {
        i++; // 安全网，防止死循环
      }
    }

    return out.join("\n");
  }

  // ===== HTML → Markdown =====
  function collapseWs(t) {
    if (!/\S/.test(t)) return /\n/.test(t) ? "" : " ";
    return t.replace(/\s+/g, " ");
  }

  function serializeChildren(node) {
    let out = "";
    node.childNodes.forEach((child) => {
      out += serializeNode(child);
    });
    return out;
  }

  function inlineText(node) {
    return serializeChildren(node).replace(/\s*\n\s*/g, " ").trim();
  }

  function serializeTable(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";
    const cellText = (cell) => inlineText(cell).replace(/\|/g, "\\|") || " ";
    const header = Array.from(rows[0].querySelectorAll("th,td")).map(cellText);
    if (!header.length) return "";
    let md =
      "\n| " + header.join(" | ") + " |\n| " + header.map(() => "---").join(" | ") + " |\n";
    rows.slice(1).forEach((r) => {
      const cells = Array.from(r.querySelectorAll("th,td")).map(cellText);
      if (cells.length) md += "| " + cells.join(" | ") + " |\n";
    });
    return md + "\n";
  }

  function serializeNode(node) {
    // 文本
    if (node.nodeType === 3) return collapseWs(node.textContent);
    if (node.nodeType !== 1) return "";

    const tag = node.tagName.toLowerCase();

    switch (tag) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6":
        return "\n" + "#".repeat(+tag[1]) + " " + inlineText(node) + "\n\n";
      case "p":
        return inlineText(node) + "\n\n";
      case "br":
        return "  \n";
      case "hr":
        return "\n---\n\n";
      case "strong":
      case "b": {
        const c = inlineText(node);
        return c ? "**" + c + "**" : "";
      }
      case "em":
      case "i": {
        const c = inlineText(node);
        return c ? "*" + c + "*" : "";
      }
      case "s":
      case "del":
      case "strike": {
        const c = inlineText(node);
        return c ? "~~" + c + "~~" : "";
      }
      case "code":
        if (node.closest && node.closest("pre")) return node.textContent;
        return "`" + node.textContent + "`";
      case "pre": {
        const codeEl = node.querySelector("code");
        const text = (codeEl ? codeEl.textContent : node.textContent).replace(/\n+$/, "");
        const m = codeEl ? codeEl.className.match(/language-([\w-]+)/) : null;
        return "\n```" + (m ? m[1] : "") + "\n" + text + "\n```\n\n";
      }
      case "a": {
        const c = inlineText(node) || node.getAttribute("href") || "";
        return "[" + c + "](" + (node.getAttribute("href") || "") + ")";
      }
      case "img":
        return "![" + (node.getAttribute("alt") || "") + "](" + (node.getAttribute("src") || "") + ")";
      case "blockquote": {
        const inner = serializeChildren(node).trim();
        return (
          "\n" +
          inner
            .split("\n")
            .map((l) => "> " + l)
            .join("\n") +
          "\n\n"
        );
      }
      case "ul": {
        let o = "\n";
        Array.from(node.children).forEach((li) => {
          if (li.tagName.toLowerCase() === "li") o += "- " + inlineText(li) + "\n";
        });
        return o + "\n";
      }
      case "ol": {
        let o = "\n";
        let n = 1;
        Array.from(node.children).forEach((li) => {
          if (li.tagName.toLowerCase() === "li") o += n++ + ". " + inlineText(li) + "\n";
        });
        return o + "\n";
      }
      case "li":
        return inlineText(node);
      case "table":
        return serializeTable(node);
      case "thead":
      case "tbody":
      case "tfoot":
      case "tr":
      case "th":
      case "td":
        return serializeChildren(node);
      // 容器：递归子节点
      case "div":
      case "section":
      case "article":
      case "main":
      case "header":
      case "footer":
      case "nav":
      case "span":
      case "font":
      case "small":
      case "label":
        return serializeChildren(node);
      // 无法用 Markdown 表达的：原样保留 HTML
      case "video":
      case "iframe":
      case "audio":
      case "source":
      case "svg":
      case "figure":
      case "figcaption":
      case "details":
      case "summary":
        return "\n" + node.outerHTML + "\n\n";
      default:
        return serializeChildren(node);
    }
  }

  function htmlToMd(html) {
    let doc;
    try {
      doc = new DOMParser().parseFromString("<body>" + String(html || "") + "</body>", "text/html");
    } catch (e) {
      return String(html || "");
    }
    let md = serializeChildren(doc.body);
    md = md.replace(/\n{3,}/g, "\n\n").trim();
    return md;
  }

  global.MDHTML = { mdToHtml: mdToHtml, htmlToMd: htmlToMd };
})(typeof window !== "undefined" ? window : this);
