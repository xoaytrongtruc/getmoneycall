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
      card.addEventListener("click", () => openMatchup(f.id, f.homeName, f.awayName));
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
    const homeName = m.highlightHome ? `<b>${escapeHtml(m.homeName)}</b>` : escapeHtml(m.homeName);
    const awayName = m.highlightAway ? `<b>${escapeHtml(m.awayName)}</b>` : escapeHtml(m.awayName);
    const score = (m.homeGoals ?? "-") + " - " + (m.awayGoals ?? "-");
    return `
      <div class="history-row">
        <span class="indicator-dot ${dotClass}"></span>
        <span class="score">${score}</span>
        <span class="names">${homeName} vs ${awayName}</span>
      </div>`;
  }).join("");
}

async function openMatchup(fixtureId) {
  overlay.classList.remove("hidden");
  modalContent.innerHTML = '<div class="loading">Đang tải thống kê...</div>';
  try {
    const res = await fetch(`/api/matchup/${fixtureId}`);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    modalContent.innerHTML = `
      <div class="section-title">${escapeHtml(data.teamA.name)} - 10 trận gần nhất</div>
      ${renderHistoryRows(data.teamA.matches)}

      <div class="section-title">${escapeHtml(data.teamB.name)} - 10 trận gần nhất</div>
      ${renderHistoryRows(data.teamB.matches)}

      <div class="section-title">Đối đầu ${escapeHtml(data.teamA.name)} vs ${escapeHtml(data.teamB.name)} - 10 trận gần nhất</div>
      ${renderHistoryRows(data.headToHead.matches)}
    `;
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
      <div class="stat-badges">
        ${statBadge(escapeHtml(m.homeName), m.homeStats)}
        ${statBadge(escapeHtml(m.awayName), m.awayStats)}
        ${statBadge("Đối đầu", m.h2hStats)}
      </div>`;
    card.addEventListener("click", () => openMatchup(m.id));
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
