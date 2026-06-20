import { el, state } from "./state.js";
import {
  assistantParts,
  contentToText,
  countImages,
  escapeAttribute,
  escapeHtml,
  formatTimestamp,
  toDetailString,
  stripTerminalControlSequences,
} from "./formatters.js";
import { renderMarkdownLite } from "./markdown.js";
import { renderRichToolContent } from "./tool-rendering.js";
import { scrollMessagesToBottom, showToast, updateJumpToLatestButton } from "./ui.js";

const INLINE_USER_CUSTOM_TYPES = new Set(["phone-inline-user-message"]);

function userContentDisplayText(content) {
  const imageCount = countImages(content);
  if (!Array.isArray(content)) return contentToText(content);

  const text = content
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("")
    .trim();

  if (text) return text;
  if (imageCount === 1) return "[1 image attached]";
  if (imageCount > 1) return `[${imageCount} images attached]`;
  return contentToText(content);
}

function imageSource(part) {
  if (!part || part.type !== "image") return "";
  if (typeof part.previewUrl === "string" && part.previewUrl) return part.previewUrl;
  if (typeof part.url === "string" && part.url) return part.url;
  if (typeof part.data === "string" && part.data && typeof part.mimeType === "string" && part.mimeType) {
    return `data:${escapeAttribute(part.mimeType)};base64,${escapeAttribute(part.data)}`;
  }
  return "";
}

function renderUserContent(content, fallbackText = "") {
  if (!Array.isArray(content)) {
    return {
      html: renderMarkdownLite(typeof content === "string" ? content : fallbackText),
      renderedImages: 0,
    };
  }

  const blocks = [];
  let imageIndex = 0;

  for (const part of content) {
    if (part?.type === "text") {
      const text = String(part.text || "");
      if (text.trim()) {
        blocks.push(`<div class="user-message-text-block">${renderMarkdownLite(text)}</div>`);
      }
      continue;
    }

    if (part?.type !== "image") continue;
    const src = imageSource(part);
    if (!src) continue;
    imageIndex += 1;
    const alt = part.name || `Attached image ${imageIndex}`;
    blocks.push(`
      <div class="user-message-image-wrap">
        <img class="user-message-image" src="${src}" alt="${escapeAttribute(alt)}" loading="lazy" />
      </div>
    `);
  }

  if (!blocks.length) {
    return {
      html: renderMarkdownLite(fallbackText),
      renderedImages: 0,
    };
  }

  return {
    html: `<div class="user-message-inline-content">${blocks.join("")}</div>`,
    renderedImages: imageIndex,
  };
}

export function transformMessage(message, index) {
  if (!message || typeof message !== "object") return [];

  if (message.role === "user") {
    return [{
      id: `user-${message.timestamp || index}`,
      kind: "user",
      meta: formatTimestamp(message.timestamp),
      text: userContentDisplayText(message.content),
      rawContent: message.content,
      imageCount: countImages(message.content),
    }];
  }

  if (message.role === "assistant") {
    const parts = assistantParts(message.content);
    return [{
      id: `assistant-${message.timestamp || index}`,
      kind: "assistant",
      meta: [message.model, formatTimestamp(message.timestamp)].filter(Boolean).join(" · "),
      text: parts.text,
      thinking: parts.thinking,
      toolCalls: parts.toolCalls,
      details: message.usage || message.stopReason ? {
        usage: message.usage,
        stopReason: message.stopReason,
      } : undefined,
    }];
  }

  if (message.role === "toolResult") {
    return [{
      id: `tool-${message.toolCallId || message.timestamp || index}`,
      kind: "tool",
      toolCallId: message.toolCallId,
      toolName: message.toolName || "tool",
      title: message.toolName || "tool",
      status: message.isError ? "error" : "done",
      text: contentToText(message.content),
      rawContent: message.content,
      meta: formatTimestamp(message.timestamp),
      details: message.details,
    }];
  }

  if (message.role === "bashExecution") {
    return [{
      id: `bash-${message.timestamp || index}`,
      kind: "tool",
      toolName: "bash",
      title: `bash · ${message.command || ""}`,
      command: message.command || "",
      args: { command: message.command || "" },
      status: message.cancelled ? "cancelled" : "done",
      text: message.output || "",
      meta: formatTimestamp(message.timestamp),
      details: {
        exitCode: message.exitCode,
        truncated: message.truncated,
        fullOutputPath: message.fullOutputPath,
      },
    }];
  }

  if (message.role === "custom") {
    if (message.display === false) return [];

    if (INLINE_USER_CUSTOM_TYPES.has(message.customType || "")) {
      return [{
        id: `custom-user-${message.timestamp || index}`,
        kind: "user",
        meta: formatTimestamp(message.timestamp),
        text: userContentDisplayText(message.content),
        rawContent: message.content,
        imageCount: countImages(message.content),
      }];
    }

    return [{
      id: `custom-${message.timestamp || index}`,
      kind: "custom",
      title: message.customType || "extension",
      text: contentToText(message.content),
      meta: formatTimestamp(message.timestamp),
      details: message.details,
      imageCount: countImages(message.content),
    }];
  }

  if (message.role === "branchSummary") {
    return [{
      id: `branch-summary-${message.timestamp || index}`,
      kind: "summary",
      title: "Branch summary",
      text: message.summary || "",
      meta: formatTimestamp(message.timestamp),
      details: { fromId: message.fromId },
    }];
  }

  if (message.role === "compactionSummary") {
    return [{
      id: `compaction-summary-${message.timestamp || index}`,
      kind: "summary",
      title: `Compaction summary${message.tokensBefore ? ` · ${message.tokensBefore.toLocaleString()} tokens` : ""}`,
      text: message.summary || "",
      meta: formatTimestamp(message.timestamp),
    }];
  }

  return [];
}

function renderMessageMeta(item, options = {}) {
  const pills = [];
  if (item.imageCount && !options.suppressImageCount) {
    pills.push(`<span class="inline-pill">${item.imageCount} image${item.imageCount === 1 ? "" : "s"}</span>`);
  }
  if (item.status) pills.push(`<span class="inline-pill">${escapeHtml(item.status)}</span>`);
  return pills.join("");
}

function renderDetailSection(title, value, options = {}) {
  if (!value) return "";

  const body = options.markdown
    ? `<div class="detail-content detail-markdown">${renderMarkdownLite(value)}</div>`
    : `<pre class="detail-pre">${escapeHtml(value)}</pre>`;

  return `
    <details>
      <summary>${escapeHtml(title)}</summary>
      ${body}
    </details>
  `;
}

function renderAssistantDetails(item) {
  const sections = [];
  if (item.thinking) sections.push(renderDetailSection("Thinking", item.thinking, { markdown: true }));

  if (item.toolCalls?.length) {
    sections.push(renderDetailSection("Tool calls", JSON.stringify(item.toolCalls, null, 2)));
  }

  if (item.details) {
    sections.push(renderDetailSection("Details", toDetailString(item.details)));
  }

  return sections.join("");
}

function toolDetailsForSecondarySection(item) {
  if (!item.details) return null;

  if (String(item.toolName || item.title || "").trim().split(" · ")[0].toLowerCase() !== "edit") {
    return item.details;
  }

  const details = item.details && typeof item.details === "object" && !Array.isArray(item.details) ? item.details : null;
  if (!details) return item.details;

  const { diff, firstChangedLine, ...rest } = details;
  return Object.keys(rest).length ? rest : null;
}

function renderMessageBody(item) {
  const richTool = item.kind === "tool" ? renderRichToolContent(item) : "";

  const renderedUser = item.kind === "user"
    ? renderUserContent(item.rawContent, item.text || "")
    : { html: "", renderedImages: 0 };

  const bodyMain = richTool || (item.kind === "tool"
    ? `<pre>${escapeHtml(item.text || "")}</pre>`
    : item.kind === "user"
      ? renderedUser.html
      : renderMarkdownLite(item.text || ""));

  const detailValue = item.kind === "tool" ? toolDetailsForSecondarySection(item) : item.details;
  const extraDetails = item.kind === "assistant"
    ? renderAssistantDetails(item)
    : detailValue
      ? renderDetailSection("Details", toDetailString(detailValue))
      : "";

  return `
        ${bodyMain}
        ${richTool ? "" : renderMessageMeta(item, { suppressImageCount: renderedUser.renderedImages > 0 })}
        ${extraDetails}
      `;
}

function renderMessage(item) {
  const richTool = item.kind === "tool" ? renderRichToolContent(item) : "";
  const roleLabel = {
    assistant: "Pi",
    custom: item.title || "Extension",
    summary: item.title || "Summary",
    system: "System",
    tool: richTool ? "Tool" : item.title || "Tool",
    user: "You",
  }[item.kind] || "Message";

  const liveAttrs = item.live ? ' id="message-live" data-live="true"' : "";

  return `
    <article class="message ${item.kind}"${liveAttrs}>
      <div class="message-header">
        <div class="role-badge">${escapeHtml(roleLabel)}${item.live ? " · live" : ""}</div>
        <div class="meta">${escapeHtml(item.meta || "")}</div>
      </div>
      <div class="message-body">
        ${renderMessageBody(item)}
      </div>
    </article>
  `;
}

function enrichToolItems(items) {
  const toolCalls = new Map();

  for (const item of items) {
    if (item.kind !== "assistant" || !Array.isArray(item.toolCalls)) continue;
    for (const toolCall of item.toolCalls) {
      if (!toolCall?.id) continue;
      toolCalls.set(toolCall.id, toolCall);
    }
  }

  return items.map((item) => {
    if (item.kind !== "tool" || item.args || !item.toolCallId) return item;
    const linked = toolCalls.get(item.toolCallId);
    if (!linked) return item;
    return { ...item, args: linked.arguments || {} };
  });
}

function currentItems() {
  const items = [...state.messages];
  for (const tool of state.liveTools.values()) items.push(tool);
  if (state.liveAssistant) items.push(state.liveAssistant);
  return enrichToolItems(items);
}

function hasLiveItems() {
  if (state.liveAssistant?.live) return true;
  for (const tool of state.liveTools.values()) {
    if (tool?.live) return true;
  }
  return false;
}

export function clearTransientState() {
  state.liveAssistant = null;
  state.liveTools.clear();
  if (state.sentinelObserver) {
    state.sentinelObserver.disconnect();
    state.sentinelObserver = null;
  }
}

export function clearSnapshotView() {
  state.snapshotState = null;
  state.snapshotWorkerId = null;
  state.messages = [];
  state.lastMessageCount = 0;
  state.renderedStart = 0;
  state.allMessages = [];
  clearTransientState();
}

export function handleAssistantEvent(event) {
  if (!event) return;
  if (!state.liveAssistant) {
    state.liveAssistant = {
      id: "assistant-live",
      kind: "assistant",
      live: true,
      text: "",
      thinking: "",
      toolCalls: [],
      meta: "Streaming…",
    };
  }

  if (event.type === "text_delta") state.liveAssistant.text += stripTerminalControlSequences(event.delta || "");
  if (event.type === "thinking_delta") state.liveAssistant.thinking += stripTerminalControlSequences(event.delta || "");
  if (event.type === "toolcall_end" && event.toolCall) {
    state.liveAssistant.toolCalls.push({ id: event.toolCall.id || "", name: event.toolCall.name || "tool", arguments: event.toolCall.arguments || {} });
  }
  if (event.type === "error") showToast(event.message || "Agent error", "error");
  renderMessages();
}

export function upsertLiveTool(toolId, value) {
  state.liveTools.set(toolId, value);
  renderMessages();
}

const VIRTUAL_BATCH = 40;

function renderFullMessages(items, { forceScroll, streaming } = {}) {
  state.lastMessageCount = items.length;
  state.renderedStart = items.length;
  state.allMessages = items;

  if (items.length <= VIRTUAL_BATCH) {
    el.messages.innerHTML = items.map(renderMessage).join("");
    updateJumpToLatestButton();
    scrollMessagesToBottom({ force: forceScroll, streaming, behavior: "smooth" });
    return;
  }

  // Lazy-load: render only last batch, add sentinel for older messages
  const start = items.length - VIRTUAL_BATCH;
  state.renderedStart = start;
  const html = `<div id="messages-sentinel" style="height:1px;pointer-events:none" aria-hidden="true"></div>`
    + items.slice(start).map(renderMessage).join("");
  el.messages.innerHTML = html;
  setupSentinel();
  updateJumpToLatestButton();
  scrollMessagesToBottom({ force: forceScroll, streaming, behavior: "smooth" });
}

function setupSentinel() {
  if (state.sentinelObserver) {
    state.sentinelObserver.disconnect();
    state.sentinelObserver = null;
  }

  const sentinel = document.getElementById("messages-sentinel");
  if (!sentinel || state.renderedStart <= 0) return;

  state.sentinelObserver = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting) {
      loadOlderBatch();
    }
  }, { rootMargin: "300px" });
  state.sentinelObserver.observe(sentinel);
}

function loadOlderBatch() {
  if (state.sentinelObserver) {
    state.sentinelObserver.disconnect();
    state.sentinelObserver = null;
  }

  const oldSentinel = document.getElementById("messages-sentinel");
  if (oldSentinel) oldSentinel.remove();

  const end = state.renderedStart;
  const start = Math.max(0, end - VIRTUAL_BATCH);
  state.renderedStart = start;

  const olderHtml = state.allMessages.slice(start, end).map(renderMessage).join("");
  el.messages.insertAdjacentHTML("afterbegin", olderHtml);

  if (start > 0) {
    el.messages.insertAdjacentHTML("afterbegin",
      '<div id="messages-sentinel" style="height:1px;pointer-events:none" aria-hidden="true"></div>');
    setupSentinel();
  }
}

export function renderMessages({ forceScroll = false, streaming = hasLiveItems() } = {}) {
  const items = currentItems();
  if (!items.length) {
    state.lastMessageCount = 0;
    state.renderedStart = 0;
    state.allMessages = [];
    if (state.sentinelObserver) {
      state.sentinelObserver.disconnect();
      state.sentinelObserver = null;
    }
    el.messages.innerHTML = `
      <article class="message system">
        <div class="message-header"><div class="role-badge">Ready</div></div>
        <div class="message-body">
          <p>This phone UI now exposes much more of Pi: commands, models, thinking, sessions, tree history, custom extension messages, and image upload.</p>
        </div>
      </article>
    `;
    updateJumpToLatestButton();
    return;
  }

  // Streaming patch mode: only update the live message body, avoiding full DOM rebuild
  if (streaming && state.lastMessageCount === items.length) {
    const liveEl = document.getElementById("message-live");
    if (liveEl) {
      const bodyEl = liveEl.querySelector(".message-body");
      const liveItem = items.find((i) => i.live);
      if (bodyEl && liveItem) {
        bodyEl.innerHTML = renderMessageBody(liveItem);
      }
      scrollMessagesToBottom({ force: forceScroll, streaming: true, behavior: "auto" });
      updateJumpToLatestButton();
      return;
    }
  }

  // Full render
  renderFullMessages(items, { forceScroll, streaming });
}

export function renderWidgets() {
  const widgets = [...state.widgets.entries()];
  if (!widgets.length && !state.footerStatus) {
    el.widgetStack.classList.add("hidden");
    el.widgetStack.innerHTML = "";
    return;
  }

  const cards = widgets.map(([key, lines]) => `
    <article class="widget-card">
      <h3>${escapeHtml(key)}</h3>
      <ul>${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul>
    </article>
  `);

  if (state.footerStatus) {
    cards.unshift(`
      <article class="widget-card">
        <h3>Extension status</h3>
        <div>${escapeHtml(state.footerStatus)}</div>
      </article>
    `);
  }

  el.widgetStack.innerHTML = cards.join("");
  el.widgetStack.classList.remove("hidden");
}
