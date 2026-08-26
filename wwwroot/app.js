const listEl = document.getElementById("fixture-list");
const hotListEl = document.getElementById("hot-list");
const tabAll = document.getElementById("tab-all");
const tabHot = document.getElementById("tab-hot");
const dayToday = document.getElementById("day-today");
const dayTomorrow = document.getElementById("day-tomorrow");
const pageTitle = document.getElementById("page-title");
const upcomingOnlyWrap = document.getElementById("upcoming-only-wrap");
const upcomingOnlyCheckbox = document.getElementById("upcoming-only");
const overlay = document.getElementById("overlay");
const modalContent = document.getElementById("modal-content");
let currentHotSource = null;
let dayOffset = 0;

document.getElementById("close-modal").addEventListener("click", closeModal);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });

function closeModal() {
  overlay.classList.add("hidden");
  modalContent.innerHTML = "";
}

function formatDateTime(iso) {
  const d = new Date(iso);
  const date = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  const time = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

function escapeHtml(s) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

tabAll.addEventListener("click", () => switchTab("all"));
tabHot.addEventListener("click", () => switchTab("hot"));
dayToday.addEventListener("click", () => switchDay(0));
dayTomorrow.addEventListener("click", () => switchDay(1));

function switchDay(offset) {
  if (offset === dayOffset) return;
  dayOffset = offset;
  dayToday.classList.toggle("active", offset === 0);
  dayTomorrow.classList.toggle("active", offset === 1);
  pageTitle.textContent = offset === 0 ? "⚽ Lịch thi đấu hôm nay" : "⚽ Lịch thi đấu ngày mai";

  loadFixtures();
  delete hotListEl.dataset.started;
  if (!hotListEl.classList.contains("hidden")) {
    hotListEl.dataset.started = "1";
    startHotScan();
  }
}

function switchTab(tab) {
  const isAll = tab === "all";
  tabAll.classList.toggle("active", isAll);
  tabHot.classList.toggle("active", !isAll);
  listEl.classList.toggle("hidden", !isAll);
  hotListEl.classList.toggle("hidden", isAll);
  upcomingOnlyWrap.classList.toggle("hidden", isAll);
  if (!isAll && !hotListEl.dataset.started) {
    hotListEl.dataset.started = "1";
    startHotScan();
  }
}

upcomingOnlyCheckbox.addEventListener("change", () => startHotScan());

async function loadFixtures() {
  listEl.innerHTML = '<div class="loading">Đang tải danh sách trận đấu...</div>';
  const requestedDay = dayOffset;
  try {
    const res = await fetch(`/api/fixtures/today?dayOffset=${requestedDay}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const fixtures = await res.json();
    if (requestedDay !== dayOffset) return; // người dùng đã đổi ngày trong lúc chờ tải

    if (fixtures.length === 0) {
      listEl.innerHTML = '<div class="empty">Không có trận đấu nào.</div>';
      return;
    }

    listEl.innerHTML = "";
    for (const f of fixtures) {
      const card = document.createElement("div");
      card.className = "match-card";
      const scoreLine = (f.homeGoals ?? null) !== null
        ? `${f.homeGoals} - ${f.awayGoals}`
        : (f.status === "NS" ? "Chưa đá" : escapeHtml(f.status ?? ""));

      card.innerHTML = `
        <div class="league">${escapeHtml(f.league)} · ${formatDateTime(f.date)}</div>
        <div class="teams">
          <div class="team home">${f.homeLogo ? `<img src="${f.homeLogo}" alt="">` : ""}<span>${escapeHtml(f.homeName)}</span></div>
          <div class="score-or-time">${scoreLine}</div>
          <div class="team away"><span>${escapeHtml(f.awayName)}</span>${f.awayLogo ? `<img src="${f.awayLogo}" alt="">` : ""}</div>
        </div>`;
      card.addEventListener("click", () => openMatchup(f.id, f.status));
      listEl.appendChild(card);
    }
  } catch (err) {
    listEl.innerHTML = `<div class="error">Lỗi tải dữ liệu: ${escapeHtml(err.message)}</div>`;
  }
}

function renderHistoryRows(matches) {
  if (!matches || matches.length === 0) {
    return '<div class="empty">Không có dữ liệu trận đấu gần đây.</div>';
  }
  return matches.map(m => {
    let dotClass = "none";
    if (m.homeGoals !== null && m.awayGoals !== null) {
      dotClass = m.over25 ? "red" : "green";
    }
    let htDotClass = "none";
    if (m.homeHtGoals !== null && m.awayHtGoals !== null && m.homeHtGoals !== undefined && m.awayHtGoals !== undefined) {
      htDotClass = m.overHalf05 ? "red" : "green";
    }
    const homeName = m.highlightHome ? `<b>${escapeHtml(m.homeName)}</b>` : escapeHtml(m.homeName);
    const awayName = m.highlightAway ? `<b>${escapeHtml(m.awayName)}</b>` : escapeHtml(m.awayName);
    const score = (m.homeGoals ?? "-") + " - " + (m.awayGoals ?? "-");
    return `
      <div class="history-row">
        <span class="indicator-dot ${dotClass}" title="Cả trận (tài/xỉu 2.5)"></span>
        <span class="indicator-dot half ${htDotClass}" title="Hiệp 1 (tài/xỉu 0.5)"></span>
        <span class="score">${score}</span>
        <span class="names">${homeName} vs ${awayName}</span>
      </div>`;
  }).join("");
}

// Tính lại tổng xanh/đỏ theo một mức tài/xỉu tùy chỉnh (thay cho mốc cố định 2.5 cả trận
// hoặc 0.5 hiệp 1): n = tổng bàn thắng trận cũ (cả trận hoặc hiệp 1) - mức tài/xỉu nhập vào.
// n > 0 (tài): đỏ += 1 nếu n > 0.25, ngược lại đỏ += 0.5.
// n < 0 (xỉu): xanh += 1 nếu n < -0.25, ngược lại xanh += 0.5.
// n = 0: huề (push), không tính bên nào - giống luật tài/xỉu mức nguyên.
function computeWeightedStats(matches, line, period = "full") {
  const homeKey = period === "half" ? "homeHtGoals" : "homeGoals";
  const awayKey = period === "half" ? "awayHtGoals" : "awayGoals";
  let green = 0;
  let red = 0;
  for (const m of matches) {
    const homeGoals = m[homeKey];
    const awayGoals = m[awayKey];
    if (homeGoals === null || homeGoals === undefined || awayGoals === null || awayGoals === undefined) continue;
    const n = (homeGoals + awayGoals) - line;
    if (n > 0) {
      red += n <= 0.25 ? 0.5 : 1;
    } else if (n < 0) {
      green += n >= -0.25 ? 0.5 : 1;
    }
  }
  return { green, red };
}

async function openMatchup(fixtureId, status) {
  overlay.classList.remove("hidden");
  modalContent.innerHTML = '<div class="loading">Đang tải thống kê...</div>';
  try {
    const res = await fetch(`/api/matchup/${fixtureId}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    const ouTool = status === "NS" ? `
      <div class="ou-tool">
        <label for="ou-line">Tài/xỉu cả trận hiện tại:</label>
        <input type="number" step="0.25" id="ou-line" placeholder="VD: 2.75" />
        <button id="ou-update">Update chênh lệch</button>
      </div>
      <div id="ou-result"></div>
      <div class="ou-tool">
        <label for="ou-line-ht">Tài/xỉu hiệp 1 hiện tại:</label>
        <input type="number" step="0.25" id="ou-line-ht" placeholder="VD: 0.75" />
        <button id="ou-update-ht">Update chênh lệch hiệp 1</button>
      </div>
      <div id="ou-result-ht"></div>` : "";

    modalContent.innerHTML = `
      ${ouTool}
      <div class="section-title">${escapeHtml(data.teamA.name)} - 10 trận gần nhất</div>
      ${renderHistoryRows(data.teamA.matches)}

      <div class="section-title">${escapeHtml(data.teamB.name)} - 10 trận gần nhất</div>
      ${renderHistoryRows(data.teamB.matches)}

      <div class="section-title">Đối đầu ${escapeHtml(data.teamA.name)} vs ${escapeHtml(data.teamB.name)} - 10 trận gần nhất</div>
      ${renderHistoryRows(data.headToHead.matches)}
    `;

    if (status === "NS") {
      const lineInput = document.getElementById("ou-line");
      const resultEl = document.getElementById("ou-result");
      document.getElementById("ou-update").addEventListener("click", () => {
        const line = parseFloat(lineInput.value);
        if (Number.isNaN(line)) {
          resultEl.innerHTML = '<div class="error">Nhập số tài/xỉu hợp lệ (VD: 2.5, 2.75).</div>';
          return;
        }
        const a = computeWeightedStats(data.teamA.matches, line);
        const b = computeWeightedStats(data.teamB.matches, line);
        const h = computeWeightedStats(data.headToHead.matches, line);
        resultEl.innerHTML = `
          <div class="stat-badges">
            ${statBadge(escapeHtml(data.teamA.name), a)}
            ${statBadge(escapeHtml(data.teamB.name), b)}
            ${statBadge("Đối đầu", h)}
          </div>`;
      });

      const lineInputHt = document.getElementById("ou-line-ht");
      const resultElHt = document.getElementById("ou-result-ht");
      document.getElementById("ou-update-ht").addEventListener("click", () => {
        const line = parseFloat(lineInputHt.value);
        if (Number.isNaN(line)) {
          resultElHt.innerHTML = '<div class="error">Nhập số tài/xỉu hợp lệ (VD: 0.5, 0.75).</div>';
          return;
        }
        const a = computeWeightedStats(data.teamA.matches, line, "half");
        const b = computeWeightedStats(data.teamB.matches, line, "half");
        const h = computeWeightedStats(data.headToHead.matches, line, "half");
        resultElHt.innerHTML = `
          <div class="stat-badges">
            ${statBadge(escapeHtml(data.teamA.name), a)}
            ${statBadge(escapeHtml(data.teamB.name), b)}
            ${statBadge("Đối đầu", h)}
          </div>`;
      });
    }
  } catch (err) {
    modalContent.innerHTML = `<div class="error">Lỗi tải dữ liệu: ${escapeHtml(err.message)}</div>`;
  }
}

function statBadge(label, stats) {
  const diff = Math.abs(stats.green - stats.red);
  const hot = diff >= 3 ? " hot" : "";
  return `<span class="stat-badge${hot}">${label}: <span class="dot green"></span>${stats.green} <span class="dot red"></span>${stats.red} (chênh ${diff})</span>`;
}

function startHotScan() {
  if (currentHotSource) currentHotSource.close();

  hotListEl.innerHTML = '<div class="progress-box"><div class="progress-text">Đang quét các giải đấu lớn...</div><div class="progress-bar"><div class="progress-fill" style="width:0%"></div></div></div><div id="hot-results"></div>';
  const progressText = hotListEl.querySelector(".progress-text");
  const progressFill = hotListEl.querySelector(".progress-fill");
  const resultsEl = document.getElementById("hot-results");
  let foundCount = 0;
  let errorCount = 0;

  const upcomingOnly = upcomingOnlyCheckbox.checked;
  const source = new EventSource(`/api/hot-matches/stream?upcomingOnly=${upcomingOnly}&dayOffset=${dayOffset}`);
  currentHotSource = source;

  source.addEventListener("start", (e) => {
    const { total } = JSON.parse(e.data);
    progressText.textContent = `Đang quét 0/${total} trận...`;
    if (total === 0) {
      progressText.textContent = "Không có trận nào thuộc các giải đấu lớn.";
    }
  });

  source.addEventListener("progress", (e) => {
    const { processed, total } = JSON.parse(e.data);
    progressFill.style.width = total > 0 ? `${(processed / total) * 100}%` : "0%";
    progressText.textContent = `Đang quét ${processed}/${total} trận... (tìm thấy ${foundCount})`;
  });

  source.addEventListener("match", (e) => {
    const m = JSON.parse(e.data);
    foundCount++;
    const card = document.createElement("div");
    card.className = "match-card hot-card";
    card.innerHTML = `
      <div class="league">${escapeHtml(m.league)} · ${formatDateTime(m.date)}</div>
      <div class="teams">
        <div class="team home">${m.homeLogo ? `<img src="${m.homeLogo}" alt="">` : ""}<span>${escapeHtml(m.homeName)}</span></div>
        <div class="score-or-time">vs</div>
        <div class="team away"><span>${escapeHtml(m.awayName)}</span>${m.awayLogo ? `<img src="${m.awayLogo}" alt="">` : ""}</div>
      </div>
      <div class="card-bottom-row">
        <div class="stat-badges stat-badges-full">
          ${statBadge(escapeHtml(m.homeName), m.homeStats)}
          ${statBadge(escapeHtml(m.awayName), m.awayStats)}
          ${statBadge("Đối đầu", m.h2hStats)}
        </div>
        ${m.status === "NS" ? `
        <div class="ou-tool card-ou-tool">
          <input type="number" step="0.25" class="ou-line" placeholder="Tài/xỉu" />
          <button type="button" class="ou-update">Update</button>
        </div>` : ""}
      </div>
      <div class="card-bottom-row half-stats-row">
        <span class="half-label">Hiệp 1 (0.5):</span>
        <div class="stat-badges stat-badges-half">
          ${statBadge(escapeHtml(m.homeName), m.homeHtStats)}
          ${statBadge(escapeHtml(m.awayName), m.awayHtStats)}
          ${statBadge("Đối đầu", m.h2hHtStats)}
        </div>
        ${m.status === "NS" ? `
        <div class="ou-tool card-ou-tool">
          <input type="number" step="0.25" class="ou-line-ht" placeholder="Tài/xỉu H1" />
          <button type="button" class="ou-update-ht">Update</button>
        </div>` : ""}
      </div>`;
    card.addEventListener("click", () => openMatchup(m.id, m.status));

    if (m.status === "NS") {
      let matchupCache = null;
      const stopClickBubble = (ev) => ev.stopPropagation();

      async function ensureMatchupCache(targetEl) {
        if (matchupCache) return matchupCache;
        targetEl.innerHTML = '<span class="loading">Đang tính lại...</span>';
        const res = await fetch(`/api/matchup/${m.id}`);
        if (!res.ok) throw new Error("HTTP " + res.status);
        matchupCache = await res.json();
        return matchupCache;
      }

      const badgesEl = card.querySelector(".stat-badges-full");
      const lineInput = card.querySelector(".ou-line");
      const updateBtn = card.querySelector(".ou-update");
      lineInput.addEventListener("click", stopClickBubble);
      updateBtn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const line = parseFloat(lineInput.value);
        if (Number.isNaN(line)) {
          badgesEl.innerHTML = '<span class="error">Nhập số tài/xỉu hợp lệ (VD: 2.5, 2.75).</span>';
          return;
        }
        try {
          updateBtn.disabled = true;
          const data = await ensureMatchupCache(badgesEl);
          const a = computeWeightedStats(data.teamA.matches, line);
          const b = computeWeightedStats(data.teamB.matches, line);
          const h = computeWeightedStats(data.headToHead.matches, line);
          badgesEl.innerHTML = `
            ${statBadge(escapeHtml(m.homeName), a)}
            ${statBadge(escapeHtml(m.awayName), b)}
            ${statBadge("Đối đầu", h)}`;
        } catch (err) {
          badgesEl.innerHTML = `<span class="error">Lỗi tải dữ liệu: ${escapeHtml(err.message)}</span>`;
        } finally {
          updateBtn.disabled = false;
        }
      });

      const htBadgesEl = card.querySelector(".stat-badges-half");
      const lineInputHt = card.querySelector(".ou-line-ht");
      const updateBtnHt = card.querySelector(".ou-update-ht");
      lineInputHt.addEventListener("click", stopClickBubble);
      updateBtnHt.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const line = parseFloat(lineInputHt.value);
        if (Number.isNaN(line)) {
          htBadgesEl.innerHTML = '<span class="error">Nhập số tài/xỉu hợp lệ (VD: 0.5, 0.75).</span>';
          return;
        }
        try {
          updateBtnHt.disabled = true;
          const data = await ensureMatchupCache(htBadgesEl);
          const a = computeWeightedStats(data.teamA.matches, line, "half");
          const b = computeWeightedStats(data.teamB.matches, line, "half");
          const h = computeWeightedStats(data.headToHead.matches, line, "half");
          htBadgesEl.innerHTML = `
            ${statBadge(escapeHtml(m.homeName), a)}
            ${statBadge(escapeHtml(m.awayName), b)}
            ${statBadge("Đối đầu", h)}`;
        } catch (err) {
          htBadgesEl.innerHTML = `<span class="error">Lỗi tải dữ liệu: ${escapeHtml(err.message)}</span>`;
        } finally {
          updateBtnHt.disabled = false;
        }
      });
    }

    resultsEl.appendChild(card);
  });

  source.addEventListener("item-error", () => {
    errorCount++;
  });

  source.addEventListener("done", () => {
    progressFill.style.width = "100%";
    const base = foundCount > 0
      ? `Hoàn tất. Tìm thấy ${foundCount} trận đáng chú ý.`
      : "Hoàn tất. Không có trận nào thỏa điều kiện chênh lệch ≥ 3.";
    progressText.textContent = errorCount > 0
      ? `${base} (⚠️ ${errorCount} trận bị lỗi khi quét, có thể do giới hạn tần suất API - thử tải lại tab để quét lại các trận đó.)`
      : base;
    source.close();
  });

  source.onerror = () => {
    progressText.textContent = "Mất kết nối khi quét, thử tải lại tab.";
    source.close();
  };
}

loadFixtures();
