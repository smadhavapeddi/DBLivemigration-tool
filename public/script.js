// ---------- shared helpers ----------

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    document.getElementById("endpoint-badge").textContent = `${cfg.baseUrl}  ·  text: ${cfg.textModel}`;
  } catch {
    document.getElementById("endpoint-badge").textContent = "Could not load endpoint config.";
  }
}

async function loadTargetEngines() {
  const select = document.getElementById("plan-target-engine");
  try {
    const res = await fetch("/api/target-engines");
    const { engines } = await res.json();
    select.innerHTML = "";
    engines.forEach((engine) => {
      const opt = document.createElement("option");
      opt.value = engine;
      opt.textContent = engine;
      if (engine === "PostgreSQL") opt.selected = true;
      select.appendChild(opt);
    });
  } catch {
    select.innerHTML = '<option value="PostgreSQL">PostgreSQL</option>';
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- Step 1: AI plan ----------

function renderMigrationText(text) {
  const lines = text.split("\n");
  let html = "";
  let inCode = false;
  let codeBuf = [];
  const flushCode = () => {
    if (codeBuf.length) {
      html += `<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`;
      codeBuf = [];
    }
  };
  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCode ? (flushCode(), (inCode = false)) : (inCode = true);
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    if (line.trim().startsWith("## ")) html += `<h2>${escapeHtml(line.trim().slice(3))}</h2>`;
    else if (line.trim()) html += `<p>${escapeHtml(line)}</p>`;
  }
  flushCode();
  return html || escapeHtml(text);
}

const planBtn = document.getElementById("plan-btn");
const planOutput = document.getElementById("plan-output");
const planMeta = document.getElementById("plan-meta");

planBtn.addEventListener("click", async () => {
  const sourceEngine = document.getElementById("plan-source-engine").value;
  const schema = document.getElementById("plan-schema").value.trim();
  const targetEngine = document.getElementById("plan-target-engine").value;
  const clusterName = document.getElementById("cluster-name").value.trim();
  const region = document.getElementById("region").value.trim();
  const nodeSize = document.getElementById("node-size").value.trim();

  if (!schema) {
    planOutput.textContent = "Paste a source schema or data description first.";
    return;
  }
  planBtn.disabled = true;
  planOutput.textContent = "Calling /v1/chat/completions…";
  planMeta.textContent = "";
  try {
    const res = await fetch("/api/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceEngine, schema, targetEngine, clusterName, region, nodeSize }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.text) throw new Error("Server returned an empty response.");
    planOutput.innerHTML = renderMigrationText(data.text);
    planMeta.textContent = `model: ${data.model} · endpoint: ${data.endpoint} · tokens: ${data.usage?.total_tokens ?? "n/a"}`;
  } catch (err) {
    planOutput.textContent = `Error: ${err.message}`;
  } finally {
    planBtn.disabled = false;
  }
});

// ---------- Step 2: live migration ----------

function readConnConfig(prefix) {
  return {
    engine: document.getElementById(`${prefix}-engine`).value,
    host: document.getElementById(`${prefix}-host`).value.trim(),
    port: document.getElementById(`${prefix}-port`).value.trim(),
    ssl: document.getElementById(`${prefix}-ssl`).value === "true",
    user: document.getElementById(`${prefix}-user`).value.trim(),
    password: document.getElementById(`${prefix}-password`).value,
    database: document.getElementById(`${prefix}-database`).value.trim(),
    uri: document.getElementById(`${prefix}-uri`).value.trim() || undefined,
  };
}

const testBtn = document.getElementById("test-btn");
const testOutput = document.getElementById("test-output");
const tablePicker = document.getElementById("table-picker");
const tableList = document.getElementById("table-list");
const runBtn = document.getElementById("run-btn");
const runLog = document.getElementById("run-log");

let lastSourceTables = [];

testBtn.addEventListener("click", async () => {
  const source = readConnConfig("src");
  const destination = readConnConfig("dst");

  if (source.engine !== destination.engine) {
    testOutput.textContent = `Source (${source.engine}) and destination (${destination.engine}) must be the same engine for live migration.`;
    tablePicker.hidden = true;
    return;
  }

  testBtn.disabled = true;
  testOutput.textContent = "Testing both connections…";
  tablePicker.hidden = true;

  try {
    const [srcRes, dstRes] = await Promise.all([
      fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(source),
      }).then((r) => r.json()),
      fetch("/api/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(destination),
      }).then((r) => r.json()),
    ]);

    const lines = [];
    lines.push(srcRes.ok ? `✔ Source connected — found ${srcRes.tables.length} table(s)/collection(s).` : `✘ Source failed: ${srcRes.error}`);
    lines.push(dstRes.ok ? `✔ Destination connected — found ${dstRes.tables.length} table(s)/collection(s).` : `✘ Destination failed: ${dstRes.error}`);
    testOutput.textContent = lines.join("\n");

    if (srcRes.ok && dstRes.ok) {
      lastSourceTables = srcRes.tables;
      renderTablePicker(srcRes.tables);
      tablePicker.hidden = false;
    }
  } catch (err) {
    testOutput.textContent = `Error: ${err.message}`;
  } finally {
    testBtn.disabled = false;
  }
});

function renderTablePicker(tables) {
  tableList.innerHTML = "";
  tables.forEach((t) => {
    const row = document.createElement("div");
    row.className = "table-row";
    row.innerHTML = `
      <input type="checkbox" class="table-check" value="${t.name}" checked />
      <span>${t.name}</span>
      <span class="count">${t.count} row(s)</span>
      <div class="progress-bar" data-table="${t.name}"><div></div></div>
    `;
    tableList.appendChild(row);
  });
}

function appendLog(html) {
  runLog.hidden = false;
  const line = document.createElement("div");
  line.innerHTML = html;
  runLog.appendChild(line);
  runLog.scrollTop = runLog.scrollHeight;
}

function setProgress(table, copied, total) {
  const bar = tableList.querySelector(`.progress-bar[data-table="${CSS.escape(table)}"] > div`);
  if (bar && total > 0) bar.style.width = `${Math.min(100, Math.round((copied / total) * 100))}%`;
}

runBtn.addEventListener("click", async () => {
  const selected = Array.from(document.querySelectorAll(".table-check:checked")).map((el) => el.value);
  if (!selected.length) {
    appendLog(`<span class="log-error">Select at least one table/collection first.</span>`);
    return;
  }

  const source = readConnConfig("src");
  const destination = readConnConfig("dst");

  runLog.innerHTML = "";
  runLog.hidden = false;
  runBtn.disabled = true;
  appendLog("Starting migration…");

  try {
    const res = await fetch("/api/migrate-run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, destination, tables: selected }),
    });

    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Request failed with status ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // keep the last, possibly-incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "log") appendLog(escapeHtml(event.message));
        else if (event.type === "progress") {
          setProgress(event.table, event.copied, event.total);
        } else if (event.type === "error") {
          appendLog(`<span class="log-error">✘ ${escapeHtml(event.table)}: ${escapeHtml(event.message)}</span>`);
        } else if (event.type === "fatal") {
          appendLog(`<span class="log-error">✘ Fatal: ${escapeHtml(event.message)}</span>`);
        } else if (event.type === "done") {
          appendLog(`<span class="log-done">✔ ${escapeHtml(event.message)}</span>`);
        }
      }
    }
  } catch (err) {
    appendLog(`<span class="log-error">Error: ${escapeHtml(err.message)}</span>`);
  } finally {
    runBtn.disabled = false;
  }
});

loadConfig();
loadTargetEngines();
