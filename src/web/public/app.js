const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");

let chatId = localStorage.getItem("financeChatId");

if (chatId) {
  loginWith(chatId);
}

$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#chat-id-input").value.trim();
  if (!id) return;
  await loginWith(id);
});

async function loginWith(id) {
  const errEl = $("#login-error");
  errEl.textContent = "";
  try {
    const res = await fetch(`/api/user/${encodeURIComponent(id)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errEl.textContent = data.error || `Login failed (${res.status})`;
      localStorage.removeItem("financeChatId");
      return;
    }
    const user = await res.json();
    chatId = user.chat_id;
    localStorage.setItem("financeChatId", chatId);
    $("#login-screen").classList.add("hidden");
    $("#app-screen").classList.remove("hidden");
    $("#user-label").textContent = `Chat ID: ${chatId}`;
    renderBanks(user.bankAccounts || []);
  } catch (err) {
    errEl.textContent = `Cannot reach server: ${err.message}`;
  }
}

$("#btn-logout").addEventListener("click", () => {
  localStorage.removeItem("financeChatId");
  location.reload();
});

document.querySelectorAll("button.action").forEach((btn) => {
  btn.addEventListener("click", () => handleAction(btn.dataset.action));
});

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const question = input.value.trim();
  if (!question) return;
  input.value = "";
  await sendMessage(question);
});

async function handleAction(action) {
  if (action === "balance") {
    addMessage("user", "Show balances");
    const data = await callApi("GET", `/api/balance/${chatId}`);
    if (data) addMessage("assistant", renderBalance(data.accounts));
  } else if (action === "transactions") {
    addMessage("user", "Show recent transactions");
    const data = await callApi("GET", `/api/transactions/${chatId}?count=20`);
    if (data) addMessage("assistant", renderTransactions(data.transactions));
  } else if (action === "spending") {
    const month = prompt("Month (YYYY-MM, leave empty for current month):", "") || "";
    addMessage("user", `Show spending${month ? ` for ${month}` : ""}`);
    const url = month
      ? `/api/spending/${chatId}?month=${encodeURIComponent(month)}`
      : `/api/spending/${chatId}`;
    const data = await callApi("GET", url);
    if (data) addMessage("assistant", renderSpending(data));
  } else if (action === "sync") {
    addMessage("user", "Sync banks");
    const placeholder = addLoading("Syncing transactions from your banks...");
    const data = await callApi("POST", `/api/sync/${chatId}`);
    placeholder.remove();
    if (data) addMessage("assistant", renderSync(data));
  } else if (action === "clear") {
    await callApi("POST", `/api/chat/${chatId}/clear`);
    messagesEl.innerHTML = "";
    addMessage("system", "<p>AI conversation history cleared.</p>");
  }
}

async function sendMessage(question) {
  addMessage("user", escapeHtml(question));
  const placeholder = addLoading("Thinking...");
  try {
    const res = await fetch(`/api/chat/${chatId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    placeholder.remove();
    const data = await res.json();
    if (!res.ok) {
      addMessage("error", `<p>${escapeHtml(data.error || "Failed to get response")}</p>`);
      return;
    }
    addMessage("assistant", telegramHtmlToWeb(data.answer));
  } catch (err) {
    placeholder.remove();
    addMessage("error", `<p>${escapeHtml(err.message)}</p>`);
  }
}

async function callApi(method, url, body) {
  try {
    const opts = { method, headers: {} };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      addMessage("error", `<p>${escapeHtml(data.error || `Request failed (${res.status})`)}</p>`);
      return null;
    }
    return data;
  } catch (err) {
    addMessage("error", `<p>${escapeHtml(err.message)}</p>`);
    return null;
  }
}

// --- Rendering ---

function renderBanks(banks) {
  const list = $("#banks-list");
  if (!banks.length) {
    list.innerHTML = `<p class="muted small">No banks connected. Run <code>/connectbank</code> in Telegram.</p>`;
    return;
  }
  list.innerHTML = banks.map((b) => `
    <div class="bank-item">
      <div class="bank-name">${escapeHtml(b.bank_display_name || b.bank_name)}</div>
      <div class="bank-meta">Last sync: ${escapeHtml(b.last_sync_date || "never")}</div>
      <div class="bank-actions">
        <button class="ghost" data-bank="${escapeHtml(b.bank_name)}">Disconnect</button>
      </div>
    </div>
  `).join("");
  list.querySelectorAll("button[data-bank]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm(`Disconnect ${btn.dataset.bank}?`)) return;
      const data = await callApi("DELETE", `/api/banks/${chatId}/${encodeURIComponent(btn.dataset.bank)}`);
      if (data) {
        addMessage("system", `<p>Disconnected ${escapeHtml(btn.dataset.bank)}.</p>`);
        const user = await fetch(`/api/user/${chatId}`).then((r) => r.json());
        renderBanks(user.bankAccounts || []);
      }
    });
  });
}

function renderBalance(accounts) {
  if (!accounts.length) return "<p>No accounts found.</p>";
  let onBudgetTotal = 0;
  let html = "<p><b>Account Balances</b></p><table><tbody>";
  for (const acc of accounts) {
    const amt = formatAmount(acc.balance);
    const cls = acc.balance < 0 ? "negative" : "positive";
    html += `<tr><td>${escapeHtml(acc.name)}</td><td class="amount ${cls}">${escapeHtml(amt)}</td></tr>`;
    if (acc.onBudget) onBudgetTotal += acc.balance;
  }
  html += `<tr><td><b>On-budget total</b></td><td class="amount"><b>${escapeHtml(formatAmount(onBudgetTotal))}</b></td></tr>`;
  html += "</tbody></table>";
  return html;
}

function renderTransactions(transactions) {
  if (!transactions.length) return "<p>No transactions found.</p>";
  let html = `<p><b>Last ${transactions.length} Transactions</b></p>`;
  html += "<table><thead><tr><th>Date</th><th>Payee</th><th>Category</th><th>Account</th><th style='text-align:right'>Amount</th></tr></thead><tbody>";
  for (const tx of transactions) {
    const cls = tx.amount < 0 ? "negative" : "positive";
    html += `<tr>
      <td>${escapeHtml(formatDate(tx.date))}</td>
      <td>${escapeHtml(tx.payee)}</td>
      <td>${escapeHtml(tx.category)}</td>
      <td>${escapeHtml(tx.account)}</td>
      <td class="amount ${cls}">${escapeHtml(formatAmount(tx.amount))}</td>
    </tr>`;
  }
  html += "</tbody></table>";
  return html;
}

function renderSpending(data) {
  let html = `<p><b>Spending for ${escapeHtml(data.month)}</b></p>`;
  html += `<p>Income: <b>${escapeHtml(formatAmount(data.income))}</b><br/>`;
  html += `Spent: <b>${escapeHtml(formatAmount(data.spent))}</b></p>`;
  for (const group of data.groups) {
    html += `<p><b>${escapeHtml(group.name)}</b></p><table><tbody>`;
    for (const cat of group.categories) {
      const cls = cat.spent < 0 ? "negative" : "positive";
      html += `<tr><td>${escapeHtml(cat.name)}</td><td class="amount ${cls}">${escapeHtml(formatAmount(cat.spent))}</td></tr>`;
    }
    html += "</tbody></table>";
  }
  return html;
}

function renderSync(data) {
  let html = "<p><b>Sync Complete</b></p>";
  for (const b of data.banks) {
    html += `<p><b>${escapeHtml(b.displayName)}</b><br/>`;
    if (b.error) {
      html += `Error: ${escapeHtml(b.error)}</p>`;
      continue;
    }
    html += `Fetched: ${b.fetched} · Imported: ${b.imported} · Updated: ${b.updated} · Skipped: ${b.skipped} · Errors: ${b.errors}</p>`;
  }
  html += `<p class="muted small">Total duration: ${data.totalDuration}s</p>`;
  return html;
}

// --- Helpers ---

function addMessage(type, html) {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.innerHTML = html;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addLoading(text) {
  return addMessage("assistant", `<p><span class="spinner"></span>${escapeHtml(text)}</p>`);
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAmount(cents) {
  const euros = cents / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR" }).format(euros);
}

function formatDate(dateStr) {
  if (!dateStr || dateStr.length < 10) return dateStr || "";
  const [y, m, d] = dateStr.split("-");
  return `${d}/${m}/${y}`;
}

// Claude returns Telegram HTML (uses <b>, <i>, \n for newlines).
// Convert newlines to <br/> so it renders in the browser; tags are already HTML.
function telegramHtmlToWeb(text) {
  return String(text || "").replace(/\n/g, "<br/>");
}

// --- Connect Bank modal ---

const modal = $("#connect-modal");
const modalErr = $("#connect-error");

$("#btn-connect-bank").addEventListener("click", openConnectModal);
$("#connect-close").addEventListener("click", closeConnectModal);
$(".modal-backdrop").addEventListener("click", closeConnectModal);
$("#connect-back-1").addEventListener("click", () => showStep(1));
$("#connect-back-3").addEventListener("click", () => showStep(3));
$("#connect-submit-code").addEventListener("click", submitRedirectUrl);
$("#connect-finish").addEventListener("click", finishConnect);

let connectState = { selectedAccountUid: null };

function showStep(n) {
  for (let i = 1; i <= 4; i++) {
    $(`#connect-step-${i}`).classList.toggle("hidden", i !== n);
  }
  modalErr.textContent = "";
}

async function openConnectModal() {
  modal.classList.remove("hidden");
  showStep(1);
  modalErr.textContent = "";
  connectState = { selectedAccountUid: null };

  const list = $("#connect-bank-list");
  list.innerHTML = `<p class="muted">Loading...</p>`;
  try {
    const res = await fetch("/api/connect/banks");
    const data = await res.json();
    list.innerHTML = "";
    for (const b of data.banks) {
      const btn = document.createElement("button");
      btn.textContent = b.displayName;
      btn.addEventListener("click", () => startConnect(b.key));
      list.appendChild(btn);
    }
  } catch (err) {
    list.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

async function closeConnectModal() {
  modal.classList.add("hidden");
  try {
    await fetch(`/api/connect/${chatId}/cancel`, { method: "POST" });
  } catch (_) {}
}

async function startConnect(bankKey) {
  modalErr.textContent = "Starting authorization...";
  try {
    const res = await fetch(`/api/connect/${chatId}/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankKey }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    $("#connect-bank-name").textContent = data.bankDisplayName;
    const link = $("#connect-auth-link");
    link.textContent = data.authUrl;
    link.href = data.authUrl;
    showStep(2);
  } catch (err) {
    modalErr.textContent = err.message;
  }
}

async function submitRedirectUrl() {
  const text = $("#connect-redirect-input").value.trim();
  if (!text) {
    modalErr.textContent = "Paste the redirect URL or just the code.";
    return;
  }
  modalErr.textContent = "Processing authorization...";
  try {
    const res = await fetch(`/api/connect/${chatId}/code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirectUrl: text }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    if (data.accounts.length === 1) {
      connectState.selectedAccountUid = data.accounts[0].uid;
      showStep(4);
    } else {
      const list = $("#connect-account-list");
      list.innerHTML = "";
      for (const acc of data.accounts) {
        const btn = document.createElement("button");
        btn.textContent = acc.label;
        btn.addEventListener("click", () => {
          connectState.selectedAccountUid = acc.uid;
          showStep(4);
        });
        list.appendChild(btn);
      }
      showStep(3);
    }
    modalErr.textContent = "";
  } catch (err) {
    modalErr.textContent = err.message;
  }
}

async function finishConnect() {
  const actualAccountId = $("#connect-actual-id").value.trim();
  if (!actualAccountId) {
    modalErr.textContent = "Enter the Actual Budget Account ID.";
    return;
  }
  if (!connectState.selectedAccountUid) {
    modalErr.textContent = "No bank account selected.";
    return;
  }

  modalErr.textContent = "Validating and saving...";
  try {
    const res = await fetch(`/api/connect/${chatId}/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bankAccountUid: connectState.selectedAccountUid,
        actualAccountId,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    modal.classList.add("hidden");
    addMessage("system", `<p>${escapeHtml(data.displayName)} connected. Run a sync to import transactions.</p>`);

    const user = await fetch(`/api/user/${chatId}`).then((r) => r.json());
    renderBanks(user.bankAccounts || []);
  } catch (err) {
    modalErr.textContent = err.message;
  }
}
