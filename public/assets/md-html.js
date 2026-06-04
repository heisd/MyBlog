/**
 * 轻量级 Markdown ⇄ HTML 双向转换器（零依赖，浏览器端）
 *
 * - mdToHtml(md)  ：Markdown → HTML
 * - htmlToMd(html)：HTML → Markdown（基于浏览器原生 DOMParser）
 *
 * 支持的语法：
 *   标题、段落、粗体/斜体/删除线、行内代码、围栏代码块、链接、图片、
 *   有序/无序列表、引用、分割线、表格（含 :--- 对齐）、内嵌 HTML，
 *   以及特殊语法：
 *     - 任务列表  - [ ] / - [x]
 *     - 脚注      [^id] ... [^id]: 定义
 *     - 数学公式  $行内$ 与 $$块级$$（保留分隔符，交由 KaTeX 渲染）
 *     - 高亮      ==文字==
 *     - 上标/下标 ^上标^ / ~下标~
 *     - 自动链接  <https://...> / <mailto:...>
 *     - 反斜杠转义 \* \_ \$ 等
 *
 * 数学公式只保留 $...$ 文本，真正渲染需页面加载 KaTeX auto-render。
 * 挂载到 window.MDHTML。
 */
(function (global) {
  "use strict";

  // 私用区占位符（正常文本不会出现，避免与内容冲突）
  const PH = (n) => String.fromCharCode(0xe000 + n);
  const CODE_O = PH(0), CODE_C = PH(1);
  const MATH_O = PH(2), MATH_C = PH(3);
  const ESC_O = PH(4), ESC_C = PH(5);
  const reHolder = (open, close) => new RegExp(open + "(\\d+)" + close, "g");

  function escapeCode(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function escapeChar(ch) {
    return ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : ch;
  }
  function cssId(id) {
    return String(id).replace(/[^\w-]/g, "_");
  }

  // ===== Markdown → HTML =====
  function inlineMd(text, ctx) {
    ctx = ctx || { defs: {}, order: [] };

    // 1) 反斜杠转义保护
    const escs = [];
    text = text.replace(/\\([\\`*_{}\[\]()#+\-.!~^=<>|$])/g, (m, ch) => {
      escs.push(ch);
      return ESC_O + (escs.length - 1) + ESC_C;
    });

    // 2) 行内代码保护
    const codes = [];
    text = text.replace(/`([^`]+)`/g, (m, c) => {
      codes.push(c);
      return CODE_O + (codes.length - 1) + CODE_C;
    });

    // 3) 数学公式保护（$$ 优先于 $）
    const maths = [];
    text = text.replace(/\$\$([^\n]+?)\$\$/g, (m, c) => {
      maths.push({ d: true, c: c });
      return MATH_O + (maths.length - 1) + MATH_C;
    });
    text = text.replace(/\$(\S(?:[^$\n]*\S)?)\$/g, (m, c) => {
      maths.push({ d: false, c: c });
      return MATH_O + (maths.length - 1) + MATH_C;
    });

    // 4) 尖括号自动链接
    text = text.replace(
      /<((?:https?:\/\/|mailto:)[^>\s]+)>/g,
      (m, u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^mailto:/, "")}</a>`
    );

    // 5) 图片
    text = text.replace(
      /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (m, alt, url, title) =>
        `<img src="${url}" alt="${alt}"${title ? ` title="${title}"` : ""} style="max-width:100%;border-radius:8px;" />`
    );
    // 6) 链接
    text = text.replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g,
      (m, t, url, title) =>
        `<a href="${url}"${title ? ` title="${title}"` : ""} target="_blank" rel="noopener">${t}</a>`
    );

    // 7) 脚注引用 [^id]
    text = text.replace(/\[\^([^\]\s]+)\]/g, (m, id) => {
      if (!(id in ctx.defs)) return m;
      let idx = ctx.order.indexOf(id);
      if (idx < 0) { ctx.order.push(id); idx = ctx.order.length - 1; }
      return `<sup class="footnote-ref"><a id="fnref-${cssId(id)}" href="#fn-${cssId(id)}">[${idx + 1}]</a></sup>`;
    });

    // 8) 粗体
    text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    // 9) 高亮
    text = text.replace(/==([^=\n]+)==/g, "<mark>$1</mark>");
    // 10) 斜体
    text = text.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    text = text.replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
    // 11) 删除线
    text = text.replace(/~~([^~]+)~~/g, "<s>$1</s>");
    // 12) 下标 / 上标
    text = text.replace(/~([^~\s][^~\n]*?)~/g, "<sub>$1</sub>");
    text = text.replace(/\^([^\s^][^^\n]*?)\^/g, "<sup>$1</sup>");

    // 还原公式（保留 $ 分隔符，内部转义，交给 KaTeX）
    text = text.replace(reHolder(MATH_O, MATH_C), (m, n) => {
      const o = maths[n];
      const d = o.d ? "$$" : "$";
      return d + escapeCode(o.c) + d;
    });
    // 还原行内代码
    text = text.replace(reHolder(CODE_O, CODE_C), (m, n) => `<code>${escapeCode(codes[n])}</code>`);
    // 还原转义字符
    text = text.replace(reHolder(ESC_O, ESC_C), (m, n) => escapeChar(escs[n]));
    return text;
  }

  function renderFootnotes(ctx) {
    if (!ctx.order.length) return "";
    let s = '\n<section class="footnotes"><hr />\n<ol>';
    ctx.order.forEach((id) => {
      const text = ctx.defs[id] || "";
      s += `<li id="fn-${cssId(id)}">${inlineMd(text, ctx)} <a href="#fnref-${cssId(id)}" class="footnote-backref">↩</a></li>`;
    });
    s += "</ol></section>";
    return s;
  }

  const RE_BLOCK_START = /^(#{1,6}\s|```|~~~|\s*>|\s*[-*+]\s|\s*\d+\.\s|\s*<|\s*\$\$)/;
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const RE_TASK = /^\[([ xX])\]\s+([\s\S]*)$/;

  function parseBlocks(md, ctx) {
    const lines = String(md).split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }

      // 数学公式块 $$
      if (/^\s*\$\$/.test(line)) {
        const head = line.replace(/^\s*\$\$/, "");
        if (/\$\$\s*$/.test(head) && head.replace(/\$\$\s*$/, "").trim()) {
          out.push(`<p class="math-block">$$${escapeCode(head.replace(/\$\$\s*$/, ""))}$$</p>`);
          i++;
          continue;
        }
        const buf = [];
        if (head.trim()) buf.push(head);
        i++;
        while (i < lines.length && !/\$\$/.test(lines[i])) { buf.push(lines[i]); i++; }
        if (i < lines.length) {
          const tail = lines[i].replace(/\$\$.*$/, "");
          if (tail.trim()) buf.push(tail);
          i++;
        }
        out.push(`<p class="math-block">$$\n${escapeCode(buf.join("\n"))}\n$$</p>`);
        continue;
      }

      // 围栏代码块
      const fence = line.match(/^(```|~~~)(.*)$/);
      if (fence) {
        const lang = (fence[2] || "").trim();
        const buf = [];
        i++;
        while (i < lines.length && !/^(```|~~~)\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
        i++;
        out.push(`<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeCode(buf.join("\n"))}</code></pre>`);
        continue;
      }

      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        out.push(`<h${h[1].length}>${inlineMd(h[2].trim(), ctx)}</h${h[1].length}>`);
        i++;
        continue;
      }

      // 分割线
      if (RE_HR.test(line)) { out.push("<hr />"); i++; continue; }

      // 引用
      if (/^\s*>/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push(`<blockquote>${parseBlocks(buf.join("\n"), ctx)}</blockquote>`);
        continue;
      }

      // 表格
      if (
        line.includes("|") &&
        i + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) &&
        lines[i + 1].includes("-")
      ) {
        const parseRow = (r) => r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
        const headers = parseRow(line);
        const aligns = parseRow(lines[i + 1]).map((c) => {
          const l = c.startsWith(":"), r = c.endsWith(":");
          return l && r ? "center" : r ? "right" : l ? "left" : "";
        });
        const sty = (j) => (aligns[j] ? ` style="text-align:${aligns[j]}"` : "");
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(parseRow(lines[i])); i++; }
        let t = "<table><thead><tr>" +
          headers.map((c, j) => `<th${sty(j)}>${inlineMd(c, ctx)}</th>`).join("") +
          "</tr></thead><tbody>";
        rows.forEach((r) => {
          t += "<tr>" + r.map((c, j) => `<td${sty(j)}>${inlineMd(c, ctx)}</td>`).join("") + "</tr>";
        });
        out.push(t + "</tbody></table>");
        continue;
      }

      // 无序列表（含任务列表）
      if (/^\s*[-*+]\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*[-*+]\s+/, "")); i++; }
        const hasTask = items.some((it) => RE_TASK.test(it));
        out.push(
          `<ul${hasTask ? ' class="task-list"' : ""}>` +
          items.map((it) => {
            const t = it.match(RE_TASK);
            if (t) {
              return `<li class="task-list-item"><input type="checkbox" disabled${/x/i.test(t[1]) ? " checked" : ""}> ${inlineMd(t[2], ctx)}</li>`;
            }
            return `<li>${inlineMd(it, ctx)}</li>`;
          }).join("") +
          "</ul>"
        );
        continue;
      }

      // 有序列表
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
        out.push("<ol>" + items.map((it) => `<li>${inlineMd(it, ctx)}</li>`).join("") + "</ol>");
        continue;
      }

      // 原始 HTML 块
      if (/^\s*</.test(line)) {
        const buf = [];
        while (i < lines.length && lines[i].trim()) { buf.push(lines[i]); i++; }
        out.push(buf.join("\n"));
        continue;
      }

      // 普通段落
      const buf = [];
      while (i < lines.length && lines[i].trim() && !RE_BLOCK_START.test(lines[i]) && !RE_HR.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      if (buf.length) out.push("<p>" + inlineMd(buf.join("\n"), ctx).replace(/\n/g, "<br>\n") + "</p>");
      else i++;
    }

    return out.join("\n");
  }

  function mdToHtml(md) {
    const ctx = { defs: {}, order: [] };
    let text = String(md || "").replace(/\r\n?/g, "\n");
    // 抽取脚注定义
    text = text.replace(/^\[\^([^\]\s]+)\]:[ \t]*(.+)$/gm, (m, id, val) => {
      ctx.defs[id] = val;
      return "";
    });
    return parseBlocks(text, ctx) + renderFootnotes(ctx);
  }

  // ===== HTML → Markdown =====
  function collapseWs(t) {
    if (!/\S/.test(t)) return /\n/.test(t) ? "" : " ";
    return t.replace(/\s+/g, " ");
  }
  function serializeChildren(node) {
    let out = "";
    node.childNodes.forEach((child) => { out += serializeNode(child); });
    return out;
  }
  function inlineText(node) {
    return serializeChildren(node).replace(/\s*\n\s*/g, " ").trim();
  }
  function serializeTable(table) {
    const rows = Array.from(table.querySelectorAll("tr"));
    if (!rows.length) return "";
    const align = (cell) => {
      const a = (cell.getAttribute("style") || "").match(/text-align:\s*(left|right|center)/);
      return a ? a[1] : "";
    };
    const cellText = (cell) => inlineText(cell).replace(/\|/g, "\\|") || " ";
    const headCells = Array.from(rows[0].querySelectorAll("th,td"));
    if (!headCells.length) return "";
    const header = headCells.map(cellText);
    const seps = headCells.map((c) => {
      const a = align(c);
      return a === "center" ? ":---:" : a === "right" ? "---:" : a === "left" ? ":---" : "---";
    });
    let md = "\n| " + header.join(" | ") + " |\n| " + seps.join(" | ") + " |\n";
    rows.slice(1).forEach((r) => {
      const cells = Array.from(r.querySelectorAll("th,td")).map(cellText);
      if (cells.length) md += "| " + cells.join(" | ") + " |\n";
    });
    return md + "\n";
  }
  function serializeList(node, ordered) {
    let o = "\n";
    let n = 1;
    Array.from(node.children).forEach((li) => {
      if (li.tagName.toLowerCase() !== "li") return;
      const cb = li.querySelector(':scope > input[type="checkbox"]');
      const prefix = ordered ? n++ + ". " : "- ";
      if (cb) {
        const mark = cb.checked || cb.hasAttribute("checked") ? "x" : " ";
        o += prefix + "[" + mark + "] " + inlineText(li) + "\n";
      } else {
        o += prefix + inlineText(li) + "\n";
      }
    });
    return o + "\n";
  }

  function serializeNode(node) {
    if (node.nodeType === 3) return collapseWs(node.textContent);
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();

    switch (tag) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        return "\n" + "#".repeat(+tag[1]) + " " + inlineText(node) + "\n\n";
      case "p":
        if (node.classList && node.classList.contains("math-block")) {
          const tex = node.textContent.replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "").trim();
          return "\n$$\n" + tex + "\n$$\n\n";
        }
        return inlineText(node) + "\n\n";
      case "br": return "  \n";
      case "hr": return "\n---\n\n";
      case "strong": case "b": { const c = inlineText(node); return c ? "**" + c + "**" : ""; }
      case "em": case "i": { const c = inlineText(node); return c ? "*" + c + "*" : ""; }
      case "s": case "del": case "strike": { const c = inlineText(node); return c ? "~~" + c + "~~" : ""; }
      case "mark": { const c = inlineText(node); return c ? "==" + c + "==" : ""; }
      case "sub": { const c = inlineText(node); return c ? "~" + c + "~" : ""; }
      case "sup": {
        if (node.classList && node.classList.contains("footnote-ref")) {
          const a = node.querySelector("a");
          const href = a ? a.getAttribute("href") || "" : "";
          const id = href.replace(/^#fn-/, "");
          return id ? "[^" + id + "]" : "";
        }
        const c = inlineText(node);
        return c ? "^" + c + "^" : "";
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
        return "\n" + inner.split("\n").map((l) => "> " + l).join("\n") + "\n\n";
      }
      case "ul": return serializeList(node, false);
      case "ol": return serializeList(node, true);
      case "li": return inlineText(node);
      case "table": return serializeTable(node);
      case "thead": case "tbody": case "tfoot": case "tr": case "th": case "td":
        return serializeChildren(node);
      case "section":
        // 脚注区：转回定义
        if (node.classList && node.classList.contains("footnotes")) {
          let s = "\n";
          node.querySelectorAll("li").forEach((li) => {
            const id = (li.id || "").replace(/^fn-/, "");
            const clone = li.cloneNode(true);
            const back = clone.querySelector(".footnote-backref");
            if (back) back.remove();
            s += "[^" + id + "]: " + inlineText(clone) + "\n";
          });
          return s + "\n";
        }
        return serializeChildren(node);
      case "div": case "article": case "main": case "header": case "footer": case "nav":
      case "span": case "font": case "small": case "label": case "input":
        return tag === "input" ? "" : serializeChildren(node);
      case "video": case "iframe": case "audio": case "source": case "svg":
      case "figure": case "figcaption": case "details": case "summary":
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
    return md.replace(/\n{3,}/g, "\n\n").trim();
  }

  global.MDHTML = { mdToHtml: mdToHtml, htmlToMd: htmlToMd };
})(typeof window !== "undefined" ? window : this);
