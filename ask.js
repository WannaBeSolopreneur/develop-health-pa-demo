function normalize(text) {
  let lowered = String(text || "").toLowerCase().replaceAll("’", "'");
  lowered = lowered.replaceAll("-", " ").replaceAll("–", " ").replaceAll("—", " ").replaceAll("/", " ");
  let cleaned = "";
  for (const char of lowered) {
    cleaned += /[a-z0-9\s]/.test(char) ? char : " ";
  }
  let collapsed = cleaned.split(/\s+/).filter(Boolean).join(" ");
  // Whole tokens only. A raw replace would turn "coverage path" into "coveragepath".
  const padded = " " + collapsed + " ";
  return padded.replaceAll(" glp 1 ", " glp1 ").replaceAll(" e pa ", " epa ").trim();
}

function findPhrase(visible, phrase) {
  if (!phrase) return null;
  let start = 0;
  while (true) {
    const index = visible.indexOf(phrase, start);
    if (index < 0) return null;
    const end = index + phrase.length;
    const beforeOk = index === 0 || visible[index - 1] === " ";
    const afterOk = end === visible.length || visible[end] === " ";
    if (beforeOk && afterOk) return index;
    start = index + 1;
  }
}

function SpanMask(text) {
  this.text = text;
  this.hidden = new Array(text.length).fill(false);
}

SpanMask.prototype.visible = function visible() {
  let out = "";
  for (let index = 0; index < this.text.length; index += 1) {
    out += this.hidden[index] ? " " : this.text[index];
  }
  return out;
};

SpanMask.prototype.cover = function cover(start, end) {
  for (let index = start; index < end; index += 1) this.hidden[index] = true;
};

SpanMask.prototype.findPhrase = function phrase(value) {
  return findPhrase(this.visible(), value);
};

function choiceMessage(noun, choices) {
  return "That " + noun + " matches more than one value. Ask for one of these: " + choices.join(", ") + ".";
}

function overlaps(start, end, spans) {
  return spans.some(function (span) {
    return !(end <= span[0] || start >= span[1]);
  });
}

function parseQuestion(question) {
  const lex = window.DEMO.lexicon;
  const text = normalize(question);
  if (!text) {
    return { status: "refuse", code: "undefined", signature: null, message: lex.undefined_message };
  }
  for (const block of lex.blocked) {
    for (const phrase of block.phrases) {
      if (findPhrase(text, phrase) !== null) {
        return { status: "refuse", code: "blocked", signature: null, message: block.message };
      }
    }
  }
  for (const phrase of lex.compare_phrases) {
    if (text.includes(phrase)) {
      return {
        status: "refuse",
        code: "compare",
        signature: null,
        message: "I will not compare two slices in one answer. Ask for each slice on its own.",
      };
    }
  }
  const mask = new SpanMask(text);
  const mentioned = [];
  const mentionedIds = new Set();
  for (const clinic of lex.clinic_aliases) {
    const start = mask.findPhrase(clinic.alias);
    if (start === null) continue;
    mask.cover(start, start + clinic.alias.length);
    if (!mentionedIds.has(clinic.clinic_id)) {
      mentioned.push(clinic);
      mentionedIds.add(clinic.clinic_id);
    }
  }
  const allClinics = lex.all_clinic_phrases.some(function (phrase) {
    return text.includes(phrase);
  });
  const other = mentioned.filter(function (clinic) {
    return !clinic.featured;
  });
  if (allClinics || other.length) {
    const detail = other.length
      ? other[0].name + " is outside that tenant."
      : "A question about every clinic is outside that tenant.";
    return {
      status: "refuse",
      code: "tenant",
      signature: null,
      message:
        "This view is " +
        lex.featured_clinic_name +
        " only. " +
        detail +
        " The clinic agent will not read it. In Snowflake a row access policy enforces the same boundary.",
    };
  }
  const metricHits = [];
  for (const item of lex.metric_aliases) {
    const start = mask.findPhrase(item.alias);
    if (start === null) continue;
    metricHits.push(item.metric_id);
    mask.cover(start, start + item.alias.length);
  }
  const metricIds = metricHits.filter(function (id, index) {
    return metricHits.indexOf(id) === index;
  });
  if (!metricIds.length) {
    return { status: "refuse", code: "undefined", signature: null, message: lex.undefined_message };
  }
  if (metricIds.length > 1) {
    return {
      status: "refuse",
      code: "ambiguous_metric",
      signature: null,
      message: "That question names more than one metric. Ask for one metric.",
    };
  }
  const metricId = metricIds[0];
  const metric = lex.metrics[metricId];
  let groupBy = null;
  const groupHits = [];
  for (const item of lex.group_phrases) {
    const probe = "by " + item.phrase;
    const start = mask.findPhrase(probe);
    if (start === null) continue;
    groupHits.push(item.dimension);
    mask.cover(start, start + probe.length);
  }
  const groupDims = groupHits.filter(function (id, index) {
    return groupHits.indexOf(id) === index;
  });
  if (groupDims.length > 1) {
    return { status: "refuse", code: "ambiguous_group", signature: null, message: "Ask for one breakdown at a time." };
  }
  if (groupDims.length) groupBy = groupDims[0];
  if (metricId === "cases_stuck" && !groupBy && (text.includes("where") || text.includes("stall"))) {
    groupBy = "stuck_stage";
  }
  if (groupBy && !metric.group_by.includes(groupBy)) {
    return {
      status: "refuse",
      code: "group",
      signature: null,
      message: metric.name + " cannot be broken down by that dimension. I will not invent the split.",
    };
  }
  const valueHits = [];
  const seen = [];
  for (const item of lex.value_aliases) {
    const start = mask.findPhrase(item.alias);
    if (start === null) continue;
    const end = start + item.alias.length;
    if (overlaps(start, end, seen)) continue;
    seen.push([start, end]);
    mask.cover(start, end);
    valueHits.push([item.dimension, item.value]);
  }
  for (const ambiguous of lex.ambiguous) {
    if (mask.findPhrase(ambiguous.phrase) !== null) {
      return {
        status: "refuse",
        code: "ambiguous_value",
        signature: null,
        message: choiceMessage(ambiguous.noun, ambiguous.choices),
      };
    }
  }
  const filters = [];
  for (const pair of valueHits) {
    const dimension = pair[0];
    const value = pair[1];
    if (filters.some(function (existing) { return existing[0] === dimension; })) {
      return {
        status: "refuse",
        code: "multi_filter",
        signature: null,
        message: "I can use one " + dimension.replaceAll("_", " ") + " filter at a time. I will not blend them.",
      };
    }
    if (!metric.group_by.includes(dimension) && dimension !== "stuck_stage") {
      return {
        status: "refuse",
        code: "filter",
        signature: null,
        message: metric.name + " cannot be filtered by that dimension. I will not invent the slice.",
      };
    }
    if (dimension === "stuck_stage" && !metric.group_by.includes(dimension)) {
      return {
        status: "refuse",
        code: "filter",
        signature: null,
        message: metric.name + " cannot be filtered by stage. Cases stuck can.",
      };
    }
    filters.push([dimension, value]);
  }
  filters.sort(function (a, b) {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  if (groupBy && filters.some(function (pair) { return pair[0] === groupBy; })) {
    return {
      status: "refuse",
      code: "group_filter",
      signature: null,
      message: "Ask for that value, or ask for the breakdown. I will not do both on the same dimension.",
    };
  }
  const stop = new Set(lex.stopwords);
  const leftovers = mask
    .visible()
    .split(/\s+/)
    .filter(function (token) { return token && !stop.has(token); });
  if (leftovers.length) {
    return {
      status: "refuse",
      code: "unknown",
      signature: null,
      message:
        "I do not have a defined filter for " +
        leftovers.slice(0, 6).join(" ") +
        ". I will not ignore it and answer a broader question.",
    };
  }
  const signature = metricId + "|" + (groupBy || "") + "|" + filters.map(function (pair) {
    return pair[0] + "=" + pair[1];
  }).join(",");
  return { status: "ok", code: null, signature: signature, message: null };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function bar(widthPct) {
  const track = el("div", "track");
  const fill = el("span", "fill");
  fill.style.width = widthPct + "%";
  track.append(fill);
  return track;
}

function renderHourBars(target, rows) {
  target.replaceChildren();
  rows.forEach(function (row) {
    const line = el("div", "hbar");
    const name = el("span", "hbar-name", row.short || row.name);
    if (row.name && row.short && row.name !== row.short) name.title = row.name;
    line.append(
      name,
      el("span", "hbar-meta", row.rate + " · " + row.decided + " decided"),
      bar(row.width_pct),
      el("b", null, row.hours)
    );
    target.append(line);
  });
}

function renderCountBars(target, rows) {
  target.replaceChildren();
  rows.forEach(function (row) {
    const line = el("div", "hbar hbar-count");
    line.append(el("span", "hbar-name", row.label), bar(row.width_pct), el("b", null, row.count_label));
    target.append(line);
  });
}

function showAnswer(entry) {
  const box = document.getElementById("ask-result");
  box.hidden = false;
  box.replaceChildren();
  box.append(el("p", "answer", entry.message));
  if (entry.table && entry.table.rows.length) {
    const table = document.createElement("table");
    const head = document.createElement("tr");
    entry.table.headers.forEach(function (header) {
      head.append(el("th", null, header));
    });
    const thead = document.createElement("thead");
    thead.append(head);
    const body = document.createElement("tbody");
    entry.table.rows.forEach(function (row) {
      const tr = document.createElement("tr");
      row.forEach(function (cell) {
        tr.append(el("td", null, cell));
      });
      body.append(tr);
    });
    table.append(thead, body);
    box.append(table);
  }
  if (entry.definition) {
    box.append(el("p", "def-label", "Definition"), el("p", null, entry.definition));
  }
  if (entry.sql) {
    box.append(el("p", "def-label", "SQL"), el("pre", "sql", entry.sql));
  }
}

function showRefusal(message) {
  const box = document.getElementById("ask-result");
  box.hidden = false;
  box.replaceChildren(el("p", "answer", message));
}

function runAsk(question) {
  const parsed = parseQuestion(question);
  if (parsed.status === "refuse") {
    showRefusal(parsed.message);
    return;
  }
  const entry = window.DEMO.answers[parsed.signature];
  if (!entry) {
    showRefusal(window.DEMO.page.missing_message);
    return;
  }
  showAnswer(entry);
}

function boot() {
  const page = window.DEMO.page;
  document.getElementById("demo-intro").textContent = page.intro;
  document.getElementById("stuck-note").textContent = page.stuck_note;
  const cards = document.getElementById("headlines");
  page.headlines.forEach(function (card) {
    const node = el("article", "card");
    node.append(el("span", null, card.label), el("strong", null, card.value), el("em", null, card.note));
    cards.append(node);
  });
  document.getElementById("payer-caption").textContent = page.payer_caption;
  const funnel = document.getElementById("funnel");
  page.funnel.forEach(function (stage) {
    const row = el("div", "stage" + (stage.label === "Approved" ? " approved" : ""));
    row.append(el("span", "stage-name", stage.label), bar(stage.width_pct), el("b", null, stage.count_label));
    funnel.append(row);
  });
  renderHourBars(document.getElementById("payer-chart"), page.payer_hours);
  renderCountBars(document.getElementById("exits"), page.exits);
  renderCountBars(document.getElementById("stuck"), page.stuck);
  renderHourBars(document.getElementById("by-payer"), page.breakdowns.payer);
  renderHourBars(document.getElementById("by-drug"), page.breakdowns.drug);
  renderHourBars(document.getElementById("by-channel"), page.breakdowns.channel);
  const chips = document.getElementById("chips");
  page.chips.forEach(function (question) {
    const button = el("button", null, question);
    button.type = "button";
    button.addEventListener("click", function () {
      document.getElementById("ask-input").value = question;
      runAsk(question);
    });
    chips.append(button);
  });
  const defs = document.getElementById("definitions");
  page.definitions.forEach(function (item) {
    const block = el("div", "definition-block");
    block.append(el("p", "metric-name", item.name), el("p", null, item.text));
    defs.append(block);
  });
  document.getElementById("ask-form").addEventListener("submit", function (event) {
    event.preventDefault();
    runAsk(document.getElementById("ask-input").value);
  });
}

window.parseQuestion = parseQuestion;
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", boot);
}
