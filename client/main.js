/**
 * SmartCut — Panel Logic (v9)
 *
 * v9 SCOPE-AWARE:
 *  - New Scope picker (Smart / Entire / Selected / In-Out).
 *  - Host resolves scope → analysis plan (time bounds + audio source + clips).
 *  - Panel iterates over every clip in the plan, decodes its audio, detects
 *    silence + bad takes, and merges regions in SEQUENCE time. This finally
 *    makes the extension work on multi-clip timelines and arbitrary tracks.
 *  - Audio source dropdown (collapsed in Advanced) lets power users override
 *    "Auto" with a specific track (V1, A1, A2, …).
 *  - Crossfade control removed (was never plumbed through to the host).
 *  - Padding/Threshold/Min-silence moved into Advanced.
 */

// ─── Globals ────────────────────────────────────────────────────────────────

var cs = (typeof CSInterface !== "undefined") ? new CSInterface() : null;
var analysisResult = null;
var isProcessing   = false;
var selectedRegions = {};
var activePreset   = "shortform";
var _sliderChangeLocked = false;
var _autoThresholdResult = null;
var _thresholdManual = false; // true = user dragged the threshold slider (locks manual value)

// Snapshot state (one-level undo for Apply Cuts).
// Populated by createSnapshot() in the host right before razoring.
// Cleared on new analysis, on restore, and on clearResults().
var _snapshot = null; // { backupSequenceID, backupName, originalSequenceID }

var LICENSE_KEY     = "smartcut_license";
var SETTINGS_KEY    = "smartcut_settings";
var TRIAL_EDITS_KEY = "smartcut_trial_edits";
var MAX_TRIAL_EDITS = 10;
var TRIAL_DAYS      = 7;

// ─── Preset Definitions (tuned per PRD §5.P1) ──────────────────────────────

// Presets: sensitivity is pinned at 3 (neutral) because it was mathematically
// identical to nudging the threshold slider. Preset differences now live in
// threshold / minDuration / padding / crossfade.
// The two presets target meaningfully different editorial styles:
//
//   SHORT FORM  - Reels/TikTok/ads. Aggressive: cut any pause >= 200ms,
//                 minimal padding, fast crossfade. Goal: maximum density,
//                 zero dead air, snappy feel.
//
//   PODCAST     - Interviews/long-form. Gentle: only cut pauses >= 500ms,
//                 larger padding, beefier crossfade. Goal: preserve
//                 natural breathing rhythm, smooth audio on headphones.
//
// Note: threshold is only used when the user disables auto-threshold in
// Custom mode; both auto presets compute their own threshold at runtime
// from the clip's noise floor.
var PRESETS = {
  shortform: {
    label:          "Short Form",
    sensitivity:     3,
    threshold:      -35,
    minDuration:    200,
    padding:         55,
    crossfade:        8,
    detectSilence:  true,
    autoThreshold:  true
  },
  podcast: {
    label:          "Podcast",
    sensitivity:     3,
    threshold:      -45,
    minDuration:    500,
    padding:        110,
    crossfade:       25,
    detectSilence:  true,
    autoThreshold:  true
  },
  custom: {
    label:          "Custom",
    sensitivity:     3,
    threshold:      null,
    minDuration:    null,
    padding:        null,
    crossfade:      null,
    detectSilence:  true,
    autoThreshold:  true
  }
};

// ─── Safe JSON ──────────────────────────────────────────────────────────────

function safeParseJSON(raw) {
  if (raw === undefined || raw === null) return null;
  var s = String(raw).trim();
  if (s === "" || s === "undefined" || s === "null") return null;
  try { return JSON.parse(s); }
  catch (e) { console.warn("[SmartCut] JSON parse failed:", s.substring(0, 200), e.message); return null; }
}

// ─── Init ───────────────────────────────────────────────────────────────────

// Bump this string whenever you need to verify the panel is actually running
// the latest code. It prints once on load and also shows in the title bar of
// the About dialog.
var SMARTCUT_PANEL_BUILD = "v9.19-hero-unit-label-2026-04-19";

document.addEventListener("DOMContentLoaded", function () {
  console.log("[SmartCut] panel build:", SMARTCUT_PANEL_BUILD);
  console.log("[SmartCut] ffmpeg loader present:",
              typeof AudioAnalyzer !== "undefined" && typeof AudioAnalyzer.loadSourceForAnalysis === "function");
  loadSettings();
  initCustomSelects();
  checkLicense();
  refreshScope();
  checkForUpdates();

  // Premiere doesn't emit a "selection changed" event to CEP, so the next
  // best signal is the panel regaining focus after the user selected a
  // clip in the timeline. Re-poll then so the Scope card stays in sync
  // with what the user actually has highlighted.
  window.addEventListener("focus", function () {
    var main = document.getElementById("mainPanel");
    if (main && main.style.display !== "none") refreshScope();
  });
});

// ─── License (Gumroad-backed, see lib/License.js) ───────────────────────────

function checkLicense() {
  if (!window.License) {
    console.error("[SmartCut] License module missing");
    showLicense("License module failed to load.");
    return;
  }
  var result = License.check();
  if (result.ok) {
    showMain();
    if (result.kind === "full") {
      badge("Active", "#00d4aa");
    } else {
      badge("Active Trial", "#f5a623");
    }
    return;
  }
  if (result.reason === "needs_online") {
    // Offline-grace expired: gently ask for a revalidation.
    showLicense(result.message + " (Retrying…)");
    License.revalidate().then(function (rv) {
      if (rv.ok) { checkLicense(); }
      else       { showLicense(rv.message + ". Please connect and reopen."); }
    });
    return;
  }
  showLicense(result.message);
}

function activateLicense() {
  var input = document.getElementById("licenseKeyInput");
  var errEl = document.getElementById("licenseError");
  errEl.style.display = "none";

  var btn = document.querySelector("#licensePanel .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Verifying\u2026"; }

  License.activate(input.value).then(function (res) {
    if (btn) { btn.disabled = false; btn.textContent = "Activate License"; }
    if (!res.ok) {
      errEl.textContent = res.message;
      errEl.style.display = "block";
      return;
    }
    showMain();
    badge("Active", "#00d4aa");
    status("License activated" + (res.email ? " \u00b7 " + res.email : ""));
  });
}

function startTrial() {
  var res = License.startTrial();
  if (!res.ok) {
    var err = document.getElementById("licenseError");
    err.textContent = res.message;
    err.style.display = "block";
    return;
  }
  showMain();
  var info = License.check();
  if (info.ok && info.kind === "trial") {
    badge("Active Trial", "#f5a623");
  }
  status("Trial started");
}

function useTrial() {
  License.recordTrialEdit();
  var info = License.check();
  if (!info.ok) { showLicense(info.message); return; }
  if (info.kind === "trial") {
    badge("Active Trial", "#f5a623");
  }
}

function showLicense(msg) {
  document.getElementById("licensePanel").style.display = "block";
  document.getElementById("mainPanel").style.display    = "none";
  if (typeof stopScopePolling === "function") stopScopePolling();
  if (msg) {
    var e = document.getElementById("licenseError");
    e.textContent = msg; e.style.display = "block";
  }
}
function showMain() {
  document.getElementById("licensePanel").style.display = "none";
  document.getElementById("mainPanel").style.display    = "block";
  if (typeof startScopePolling === "function") startScopePolling();
}
function badge(t, c) {
  var b = document.getElementById("licenseBadge");
  b.textContent = t; b.style.color = c; b.style.background = c + "22";
  b.style.cursor = "pointer";
  b.title = "Click for license details";
  b.onclick = showAboutPanel;
}

function openPurchasePage() {
  if (window.License && window.Updater) {
    Updater.openReleasePage(License.BUY_URL);
  }
}

function openManagePage() {
  if (window.License && window.Updater) {
    var url = License.MANAGE_URL || License.BUY_URL;
    Updater.openReleasePage(url);
  }
}

function copyMachineIdToClipboard() {
  if (!window.License) return;
  var id = License.info().machineId || "";
  try {
    var ta = document.createElement("textarea");
    ta.value = id;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    status("Machine ID copied to clipboard");
  } catch (e) {
    status("Could not copy machine ID");
  }
}

function deactivateLicense() {
  if (!window.License) return;
  var confirmed = window.confirm("Deactivate this license on this machine? You'll need to re-enter your key to re-activate.");
  if (!confirmed) return;
  License.deactivate();
  hideAboutPanel();
  status("License deactivated");
  checkLicense();
}

// ─── About panel ───────────────────────────────────────────────────────────
//
// Context-aware "My Account" dialog. Top summary banner tells the user the
// one thing they came here to check (trial days left / next renewal / not
// activated), and the dl below fills in the administrative details. Action
// buttons below the dialog swap between Buy, Manage Subscription, and
// Deactivate depending on state.
function showAboutPanel() {
  if (!window.License) return;
  var info = License.info();
  var ver  = (window.Updater && Updater.currentVersion) ? Updater.currentVersion() : "?";
  var body = document.getElementById("aboutBody");
  if (!body) return;

  var kind = info.kind || "none";
  var summary = "";
  var rows    = [["Version", ver]];

  if (kind === "full") {
    rows.push(["License",     "Active"]);
    rows.push(["Email",       info.email || "-"]);
    rows.push(["Activated",   info.activatedAt ? new Date(info.activatedAt).toLocaleDateString() : "-"]);
    if (info.expiresAt) {
      var exp    = new Date(info.expiresAt);
      var daysTo = Math.max(0, Math.ceil((exp.getTime() - Date.now()) / 86400000));
      summary    = "Subscription renews " + exp.toLocaleDateString() +
                   " (" + daysTo + " day" + (daysTo === 1 ? "" : "s") + " left)";
      rows.push(["Renews", exp.toLocaleDateString()]);
    } else {
      summary = "Lifetime license, activated on this Mac";
    }
  } else if (kind === "trial") {
    var trialStart = info.trialStart ? new Date(info.trialStart) : new Date();
    var trialEnd   = new Date(trialStart.getTime() + License.TRIAL_DAYS * 86400000);
    var daysLeft   = Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / 86400000));
    var editsLeft  = Math.max(0, License.TRIAL_MAX_EDITS - (info.trialEdits || 0));
    summary = daysLeft + " day" + (daysLeft === 1 ? "" : "s") + " left in trial, " +
              editsLeft + " of " + License.TRIAL_MAX_EDITS + " edits remaining";
    rows.push(["License", "Active Trial"]);
    rows.push(["Started", trialStart.toLocaleDateString()]);
    rows.push(["Ends",    trialEnd.toLocaleDateString()]);
  } else {
    summary = "Not activated. Enter a license key to unlock.";
    rows.push(["License", "Not activated"]);
  }

  rows.push(["Machine ID", info.machineId]);

  var html = "";
  if (summary) {
    html += '<div class="about-summary' +
            (kind === "none" ? " about-summary-warn" : "") + '">' +
            escapeHtml(summary) + '</div>';
  }
  html += '<dl class="about-dl">';
  rows.forEach(function (row) {
    var val = escapeHtml(String(row[1]));
    if (row[0] === "Machine ID") {
      val = '<span class="about-machine-id">' + val + '</span>' +
            '<button class="btn-link about-copy-btn" onclick="copyMachineIdToClipboard()">Copy</button>';
    }
    html += '<dt>' + escapeHtml(row[0]) + '</dt><dd>' + val + '</dd>';
  });
  html += '</dl>';
  body.innerHTML = html;

  // Swap action buttons based on license state.
  var actions = document.querySelector("#aboutPanel .about-actions");
  if (actions) {
    var buttons = "";
    if (kind === "full") {
      buttons += '<button class="btn-ghost" onclick="openManagePage()">Manage Subscription</button>';
      buttons += '<button class="btn-ghost btn-danger" onclick="deactivateLicense()">Deactivate on this Mac</button>';
    } else if (kind === "trial") {
      buttons += '<button class="btn-primary" onclick="openPurchasePage()">Buy SmartCut</button>';
      buttons += '<button class="btn-ghost" onclick="showActivationFromAbout()">Enter License Key</button>';
    } else {
      buttons += '<button class="btn-primary" onclick="openPurchasePage()">Buy SmartCut</button>';
      buttons += '<button class="btn-ghost" onclick="showActivationFromAbout()">Enter License Key</button>';
    }
    actions.innerHTML = buttons;
  }

  document.getElementById("aboutPanel").style.display = "flex";
}

// Called from About dialog when user clicks "Enter License Key". Hides the
// About modal and flips the main panel to the activation screen.
function showActivationFromAbout() {
  hideAboutPanel();
  var main = document.getElementById("mainPanel");
  var lic  = document.getElementById("licensePanel");
  if (main) main.style.display = "none";
  if (lic)  lic.style.display  = "block";
}
function hideAboutPanel() {
  var p = document.getElementById("aboutPanel");
  if (p) p.style.display = "none";
}

// ─── Update check ──────────────────────────────────────────────────────────
function checkForUpdates() {
  if (!window.Updater) return;
  Updater.check(false).then(function (res) {
    if (res.updateAvailable) {
      var banner = document.getElementById("updateBanner");
      var txt    = document.getElementById("updateBannerText");
      if (banner && txt) {
        txt.innerHTML = "Update available: <strong>v" + res.latest + "</strong> (you have v" + res.current + ")";
        banner.style.display = "flex";
      }
    }
  });
}
function dismissUpdateBanner() {
  var b = document.getElementById("updateBanner");
  if (b) b.style.display = "none";
}

// Requests a signed, short-lived download URL from the license server.
// If the caller is on trial / no license, show the buy page instead.
function openUpdatePage() {
  if (!window.Updater) return;
  status("Requesting download link\u2026");
  Updater.downloadLatest().then(function (res) {
    if (res.ok) {
      status("Download started in your browser \u00b7 " + (res.version || ""));
      return;
    }
    status(res.message || "Could not fetch update link");
    var upgrade = window.confirm(
      (res.message || "A valid license is required to download updates.") +
      "\n\nOpen the purchase page?"
    );
    if (upgrade) openPurchasePage();
  });
}

// ─── Scope card (selection-aware) ───────────────────────────────────────────
//
// refreshScope() asks the host for { sequence, selection, inOut }, then
// renderScopeCard() combines that with the Scope-mode dropdown to describe
// what the Analyze button is about to act on:
//
//   - Single clip selected  →  "copy_AAD3F14E…"  ·  Clip  ·  0:12
//   - Multiple clips        →  "3 clips selected" · Across 2 tracks · 0:42
//   - No selection          →  "My Reel v3"       · Sequence         · 4:27
//   - In/Out override       →  "In/Out range"     · 0:05 → 0:20      · 0:15
//
// The name is editable whenever the target is a single clip or the sequence,
// so users can rename raw clip names (`copy_AAD3F14E-…`) right from the panel.

var _scopeState       = null; // last host-returned { sequence, selection, inOut }
var _scopeFingerprint = null; // last rendered target — used to skip no-op redraws
var _scopePollTimer   = null;
var _lastAudioTrackCounts = null; // "{v}:{a}" — so we only rebuild the audio dropdown on track-count change
var _renameInFlight   = false; // guard: true while a rename round-trip is pending

// Build a short string that changes whenever the resolved scope target does.
// Used by the poller to skip re-renders (and thus avoid clobbering the
// rename input mid-keystroke) when nothing meaningful has changed.
function scopeFingerprint(tgt) {
  if (!tgt) return "none";
  var parts = [
    tgt.kind,
    tgt.name || "",
    Math.round((tgt.duration || 0) * 1000),
    tgt.warn ? "w" : "",
    tgt.subLine || ""
  ];
  if (tgt.singleClip) parts.push(tgt.singleClip.trackIndex + ":" + tgt.singleClip.clipIndex);
  return parts.join("|");
}

// Apply a fresh getScopeInfo() payload: update state, keep the audio-source
// dropdown in sync, then re-render the card ONLY if the resolved target
// actually changed (or the caller forces it). Guarded against clobbering a
// rename-in-progress.
function applyScopeInfo(info, opts) {
  opts = opts || {};
  var el = document.getElementById("sequenceInfo");
  if (!el) return;

  if (!info || info.error) {
    _scopeState = null;
    _scopeFingerprint = "none";
    el.classList.remove("scope-card");
    el.innerHTML = '<p class="muted">' +
      escapeHtml((info && info.error) ? info.error : "Open a sequence in Premiere Pro") +
      '</p>';
    return;
  }

  _scopeState = info;

  // Only rebuild the audio-source dropdown when track counts change, so the
  // poller doesn't churn the DOM every tick.
  if (info.sequence) {
    var sig = (info.sequence.videoTrackCount || 0) + ":" + (info.sequence.audioTrackCount || 0);
    if (sig !== _lastAudioTrackCounts) {
      _lastAudioTrackCounts = sig;
      populateAudioSourceOptions(info.sequence.videoTrackCount || 0, info.sequence.audioTrackCount || 0);
    }
  }

  var tgt = resolveScopeTarget();
  var fp  = scopeFingerprint(tgt);
  if (!opts.forceRender && fp === _scopeFingerprint) return;

  // Don't blow away the input mid-edit — the user is typing a new name and
  // the innerHTML reset would steal focus / lose characters.
  var active = document.activeElement;
  if (active && active.id === "seqNameInput" && !opts.forceRender) return;

  _scopeFingerprint = fp;
  renderScopeCard();

  // v9.17: auto-clear stale results when the user clicks a different clip.
  // The old behavior left clip A's regions on screen even after the user
  // had moved on to clip B, which made it look like SmartCut was about to
  // apply A's cuts to B. Clear the results panel + analysis state and
  // give a one-line hint so the user knows to re-run Analyze.
  if (analysisResult) {
    var analyzedFp = analysisResult.analyzedClipFingerprint || null;
    var currentFp  = computeScopeFingerprintForAnalysis();
    if (analyzedFp && currentFp && analyzedFp !== currentFp) {
      console.log("[SmartCut] selection changed — clearing stale results",
                  "analyzed=", analyzedFp, "current=", currentFp);
      var resSec = document.getElementById("resultsSection");
      if (resSec) resSec.style.display = "none";
      analysisResult = null;
      selectedRegions = {};
      clearSnapshot();
      hideDiagPanel();
      status("New clip selected. Click Analyze to scan it.");
    }
  }
}

// Explicit refresh — user clicked the 🔄 button, finished Apply, etc.
// Forces a re-render even if the fingerprint matches.
function refreshScope() {
  if (!cs) { status("CEP host bridge unavailable"); return; }
  cs.evalScript("getScopeInfo()", function (r) {
    applyScopeInfo(safeParseJSON(r), { forceRender: true });
  });
}

// Legacy alias — kept so older callers / the refresh button in index.html
// keep routing through the new code path without needing changes.
function refreshSequence() { refreshScope(); }

// ─── Scope polling ──────────────────────────────────────────────────────────
//
// Premiere doesn't emit "selection changed" / "active-sequence changed"
// events to CEP, so the only way to keep the card live is to poll. This is
// cheap (getScopeInfo walks tracks in-process, no file I/O) and we bail out
// early when nothing has changed, so there's no DOM thrash.

var _scopeLastLog = null; // dedup console noise to one line per distinct state
var _fileLogPath  = "/tmp/smartcut-debug.log"; // mirror of console output so the
                                               // dev can tail it without DevTools
var _fileLogFs    = null;                      // cached require('fs'), if available
function fileLog(line) {
  try {
    if (_fileLogFs === null) {
      _fileLogFs = (typeof require === "function") ? require("fs") : false;
    }
    if (!_fileLogFs) return;
    var stamp = new Date().toISOString();
    _fileLogFs.appendFileSync(_fileLogPath, stamp + " " + line + "\n");
  } catch (e) {}
}
function pollScope() {
  var main = document.getElementById("mainPanel");
  if (!main || main.style.display === "none") return;
  if (isProcessing) return;        // avoid DOM churn mid-analyze / mid-apply
  if (_renameInFlight) return;     // a rename round-trip hasn't resolved yet
  var active = document.activeElement;
  if (active && active.id === "seqNameInput") return; // user is typing
  if (!cs) return;
  cs.evalScript("getScopeInfo()", function (r) {
    var info = safeParseJSON(r);
    var selCount = (info && info.selection && info.selection.clips) ? info.selection.clips.length : 0;
    var seqName  = (info && info.sequence) ? info.sequence.name : "(no seq)";
    var strategy = (info && info.selection && info.selection.strategy) || "n/a";
    var clipList = info && info.selection && info.selection.clips && info.selection.clips.length
      ? info.selection.clips.map(function (c) { return "T" + c.trackIndex + "/C" + c.clipIndex + ":" + c.name; }).join(", ")
      : "";
    var logKey = selCount + "|" + seqName + "|" + strategy + "|" + clipList;
    if (logKey !== _scopeLastLog) {
      _scopeLastLog = logKey;
      var msg = "[SmartCut/pollScope] selection=" + selCount + " strategy=" + strategy +
                " seq=\"" + seqName + "\" " +
                (clipList ? "clips: " + clipList : "(no clips selected)");
      console.log(msg);
      fileLog(msg);
    }
    applyScopeInfo(info);
  });
}

function startScopePolling() {
  if (_scopePollTimer) return;
  _scopePollTimer = setInterval(pollScope, 700);
  var bootMsg = "[SmartCut] scope polling started (700ms interval) @ " + new Date().toISOString();
  console.log(bootMsg);
  try { if (typeof require === "function") { require("fs").writeFileSync(_fileLogPath, bootMsg + "\n"); } } catch (e) {}
  pollScope(); // fire one immediately so the card populates on first paint
}

function stopScopePolling() {
  if (_scopePollTimer) { clearInterval(_scopePollTimer); _scopePollTimer = null; }
}

// Figure out what the Scope card should actually describe based on the
// current selection + Scope-mode dropdown. Returns null if we have no
// sequence info yet.
function resolveScopeTarget() {
  if (!_scopeState || !_scopeState.sequence) return null;
  var seq  = _scopeState.sequence;
  var sel  = (_scopeState.selection && _scopeState.selection.clips) || [];

  // v9.7: single-clip mode. SmartCut now operates on exactly one selected
  // clip at a time — this keeps the analysis and the pauses list focused,
  // and avoids the "43 pauses × 3 stacked copies" mess in the UI.
  //
  // Valid state (kind:"clip") only when sel.length === 1. Any other state
  // is flagged with tgt.invalid so the Analyze button can be disabled.

  var tgt = {
    kind:       "empty",
    name:       "Select one clip in the timeline",
    duration:   0,
    editable:   false,
    subLine:    "Click a clip in Premiere to start",
    singleClip: null,
    warn:       true,
    invalid:    true
  };

  if (sel.length === 1) {
    var c = sel[0];
    tgt.kind       = "clip";
    tgt.name       = c.name;
    tgt.duration   = c.duration;
    tgt.editable   = true;
    tgt.subLine    = "Selected clip";
    tgt.singleClip = { trackIndex: c.trackIndex, clipIndex: c.clipIndex };
    tgt.warn       = false;
    tgt.invalid    = false;
    return tgt;
  }

  if (sel.length > 1) {
    tgt.kind    = "empty";
    tgt.name    = "Select only one clip";
    tgt.subLine = sel.length + " clips selected. Pick just one to analyze";
    tgt.warn    = true;
    tgt.invalid = true;
    return tgt;
  }

  return tgt;
}

// v9.12: Produces a stable string identifying *which clip* the user had
// selected at analysis time. Apply-time compares this to the current
// selection fingerprint and refuses to proceed if they've diverged —
// prevents "analyzed V3 at 119s but applying to V2" footguns.
//
// Returns null if no valid single-clip selection exists. The scope state
// comes from the last host poll so it's always current.
function computeScopeFingerprintForAnalysis() {
  if (!_scopeState || !_scopeState.selection || !_scopeState.selection.clips) return null;
  var clips = _scopeState.selection.clips;
  if (clips.length !== 1) return null;
  var c = clips[0];
  return ("T" + c.trackIndex + ":C" + c.clipIndex +
          ":s" + Number(c.start || 0).toFixed(3) +
          ":e" + Number(c.end   || 0).toFixed(3) +
          ":n" + String(c.name || ""));
}

function renderScopeCard() {
  var el = document.getElementById("sequenceInfo");
  if (!el) return;
  el.classList.add("scope-card");

  var tgt = resolveScopeTarget();
  if (!tgt) {
    el.innerHTML = '<p class="muted">Open a sequence in Premiere Pro</p>';
    return;
  }

  var icon;
  switch (tgt.kind) {
    case "clip":  icon = _iconClip();    break;
    case "empty": icon = _iconPointer(); break;
    default:      icon = _iconSequence();
  }

  var durText = mmss(tgt.duration || 0);

  var nameHtml;
  if (tgt.editable) {
    var hint = tgt.kind === "clip" ? "Click to rename this clip" : "Click to rename this sequence";
    nameHtml =
      '<input type="text" class="seq-name-input" id="seqNameInput" ' +
           'spellcheck="false" autocomplete="off" ' +
           'value="' + escapeHtml(tgt.name) + '" ' +
           'data-original="' + escapeHtml(tgt.name) + '" ' +
           'title="' + hint + '" ' +
           'onkeydown="if(event.key===\'Enter\'){event.preventDefault();this.blur();}else if(event.key===\'Escape\'){this.value=this.dataset.original;this.blur();}" ' +
           'onblur="renameScopeInput(this)">';
  } else {
    nameHtml = '<span class="seq-name-readonly" title="' + escapeHtml(tgt.name) + '">' +
               escapeHtml(tgt.name) + '</span>';
  }

  // In the invalid "empty" state we hide the duration ("0:00") because it's
  // noise, and add a scope-empty modifier so the card can render dimmer.
  var durHtml = tgt.kind === "empty"
    ? ''
    : '<span class="scope-duration">' + durText + '</span>';

  el.classList.toggle("scope-empty", tgt.kind === "empty");

  el.innerHTML =
    '<div class="scope-row">' +
      '<span class="scope-icon">' + icon + '</span>' +
      nameHtml +
      durHtml +
    '</div>' +
    '<div class="scope-sub' + (tgt.warn ? ' scope-warn' : '') + '">' +
      escapeHtml(tgt.subLine) +
    '</div>';

  syncAnalyzeButtonState();
}

// Persist a rename back to Premiere — routes to clip-rename or
// sequence-rename depending on what the card is currently describing.
function renameScopeInput(inputEl) {
  if (!inputEl || !cs) return;
  var newName  = String(inputEl.value || "").trim();
  var original = String(inputEl.dataset.original || "");
  if (!newName) { inputEl.value = original; return; }
  if (newName === original) return;

  var tgt = resolveScopeTarget();
  if (!tgt || !tgt.editable) { inputEl.value = original; return; }

  var payload;
  if (tgt.kind === "clip" && tgt.singleClip) {
    payload = JSON.stringify({
      target: "clip",
      trackIndex: tgt.singleClip.trackIndex,
      clipIndex:  tgt.singleClip.clipIndex,
      name: newName
    });
  } else {
    payload = JSON.stringify({ target: "sequence", name: newName });
  }
  var escaped = payload.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  _renameInFlight = true;
  cs.evalScript("renameScopeTarget('" + escaped + "')", function (r) {
    _renameInFlight = false;
    var res = safeParseJSON(r);
    if (!res || !res.success) {
      inputEl.value = original;
      status("Rename failed: " + ((res && res.error) || "unknown error"));
      return;
    }
    var applied = res.name || newName;
    inputEl.dataset.original = applied;
    inputEl.value = applied;

    // Sync _scopeState in place so the next render (and the sub-line) stays
    // correct without needing a full host round-trip.
    if (_scopeState) {
      if (res.target === "clip" && tgt.singleClip && _scopeState.selection && _scopeState.selection.clips) {
        var clips = _scopeState.selection.clips;
        for (var i = 0; i < clips.length; i++) {
          if (clips[i].trackIndex === tgt.singleClip.trackIndex &&
              clips[i].clipIndex  === tgt.singleClip.clipIndex) {
            clips[i].name = applied;
            break;
          }
        }
      } else if (res.target === "sequence" && _scopeState.sequence) {
        _scopeState.sequence.name = applied;
      }
    }
    // Sync the fingerprint so the next poll doesn't needlessly re-render
    // the card (the input already shows the correct applied name).
    _scopeFingerprint = scopeFingerprint(resolveScopeTarget());
    status("Renamed to \u201C" + applied + "\u201D");
  });
}

// Legacy alias — previously bound to sequence-only rename.
function renameSequence(el) { renameScopeInput(el); }

// ─── Scope card icons (inline SVG, stroke uses currentColor) ───────────────

function _iconSequence() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">' +
           '<rect x="3"  y="9" width="5" height="6" rx="1"/>' +
           '<rect x="9"  y="9" width="4" height="6" rx="1"/>' +
           '<rect x="14" y="9" width="7" height="6" rx="1"/>' +
         '</svg>';
}
function _iconClip() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">' +
           '<rect x="3" y="6" width="18" height="12" rx="1.5"/>' +
           '<path d="M7 6v12M11 6v12M15 6v12"/>' +
         '</svg>';
}
function _iconPointer() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
           '<path d="M5 4l6 14 2.2-5.8L19 10 5 4z"/>' +
         '</svg>';
}

// ─── Scope + audio source UI ───────────────────────────────────────────────
//
// Scope is fully automatic and driven by what's selected on the timeline:
//   - Nothing selected     → whole sequence
//   - One clip selected    → just that clip
//   - Multiple selected    → just those clips (across whatever tracks)
// There is no manual toggle or dropdown.

function getScopeMode() {
  return "smart";
}

function getAudioSourceMode() {
  var el = document.getElementById("audioSourceSelect");
  return (el && el.value) || "auto";
}

function onScopeChange() {
  if (_scopeState) {
    _scopeFingerprint = null;
    renderScopeCard();
    _scopeFingerprint = scopeFingerprint(resolveScopeTarget());
  }
  saveSettings();
}

// Kept as a no-op so any stale callers (other versions of main.js, settings
// restore, etc.) don't blow up. The I/O toggle UI was removed in v9.5.
function updateIOToggleVisibility() { /* no-op since I/O toggle was removed */ }

function populateAudioSourceOptions(videoCount, audioCount) {
  var sel = document.getElementById("audioSourceSelect");
  if (!sel) return;
  var prev = sel.value || "auto";
  sel.innerHTML = "";

  var addOpt = function (value, label) {
    var o = document.createElement("option");
    o.value = value; o.textContent = label;
    sel.appendChild(o);
  };

  addOpt("auto", "Auto (best track in scope)");
  for (var v = 0; v < videoCount; v++) {
    addOpt("v" + v, "V" + (v + 1) + " (embedded audio)");
  }
  for (var a = 0; a < audioCount; a++) {
    addOpt("a" + a, "A" + (a + 1));
  }

  if (prev) {
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === prev) { sel.value = prev; break; }
    }
  }

  // Rebuild the custom dropdown overlay (if it's already been mounted)
  // so the menu reflects the new option list.
  refreshCustomSelect(sel);
}

// ─── Custom select overlay ─────────────────────────────────────────────────
//
// macOS native <select> popups render as OS chrome and look jarring next to
// the rest of this panel. We keep the real <select> in the DOM (so every
// `.value` read / write and `onchange` handler in the codebase keeps
// working) but hide it visually and render a styled trigger + menu on top.
//
// Call upgradeNativeSelect(sel) once per <select>. Call refreshCustomSelect
// after programmatically changing the option list. Outside-click / Escape
// close the menu. Up/Down arrows + Enter work when the menu is open.

function upgradeNativeSelect(sel) {
  if (!sel || sel._csUpgraded) return;
  sel._csUpgraded = true;

  var wrapper = document.createElement("div");
  wrapper.className = "cs-wrapper";
  sel.parentNode.insertBefore(wrapper, sel);
  wrapper.appendChild(sel);

  var trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "cs-trigger";
  trigger.setAttribute("aria-haspopup", "listbox");
  trigger.setAttribute("aria-expanded", "false");
  trigger.innerHTML =
    '<span class="cs-label"></span>' +
    '<svg class="cs-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

  var menu = document.createElement("div");
  menu.className = "cs-menu";
  menu.setAttribute("role", "listbox");
  menu.style.display = "none";

  wrapper.appendChild(trigger);
  wrapper.appendChild(menu);

  sel.classList.add("cs-native-hidden");

  function renderMenu() {
    menu.innerHTML = "";
    for (var i = 0; i < sel.options.length; i++) {
      var opt = sel.options[i];
      var row = document.createElement("div");
      row.className = "cs-option" + (opt.value === sel.value ? " is-selected" : "");
      row.setAttribute("role", "option");
      row.setAttribute("data-value", opt.value);
      row.textContent = opt.textContent;
      row.onclick = (function (value) {
        return function () {
          sel.value = value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          syncLabel();
          closeMenu();
        };
      })(opt.value);
      menu.appendChild(row);
    }
  }

  function syncLabel() {
    var selOpt = sel.options[sel.selectedIndex];
    trigger.querySelector(".cs-label").textContent =
      selOpt ? selOpt.textContent : "";
    // Also sync `.is-selected` highlights in case menu is open.
    var rows = menu.querySelectorAll(".cs-option");
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle("is-selected",
        rows[i].getAttribute("data-value") === sel.value);
    }
  }

  function openMenu() {
    if (menu.style.display === "block") return;
    renderMenu();
    menu.style.display = "block";
    trigger.setAttribute("aria-expanded", "true");
    wrapper.classList.add("is-open");
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }
  function closeMenu() {
    menu.style.display = "none";
    trigger.setAttribute("aria-expanded", "false");
    wrapper.classList.remove("is-open");
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function onOutside(e) {
    if (!wrapper.contains(e.target)) closeMenu();
  }
  function onKey(e) {
    var rows = menu.querySelectorAll(".cs-option");
    var idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].classList.contains("is-focused")) { idx = i; break; }
    }
    if (e.key === "Escape") { closeMenu(); e.preventDefault(); return; }
    if (e.key === "ArrowDown") {
      if (idx >= 0) rows[idx].classList.remove("is-focused");
      idx = (idx + 1) % rows.length;
      rows[idx].classList.add("is-focused");
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      if (idx >= 0) rows[idx].classList.remove("is-focused");
      idx = (idx <= 0 ? rows.length - 1 : idx - 1);
      rows[idx].classList.add("is-focused");
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (idx >= 0) rows[idx].click();
      e.preventDefault();
    }
  }

  trigger.addEventListener("click", function (e) {
    e.preventDefault();
    if (menu.style.display === "block") closeMenu();
    else                                 openMenu();
  });

  sel.addEventListener("change", syncLabel);
  sel._csRefresh = function () { renderMenu(); syncLabel(); };
  syncLabel();
}

function refreshCustomSelect(sel) {
  if (sel && typeof sel._csRefresh === "function") sel._csRefresh();
}

function initCustomSelects() {
  var nodes = document.querySelectorAll("select.track-select");
  for (var i = 0; i < nodes.length; i++) upgradeNativeSelect(nodes[i]);
}

function toggleAdvanced() {
  var toggle = document.querySelector(".advanced-toggle");
  var panel  = document.getElementById("advancedPanel");
  if (!toggle || !panel) return;
  var open = panel.style.display !== "none";
  panel.style.display = open ? "none" : "block";
  toggle.classList.toggle("open", !open);
}

// ─── Presets ────────────────────────────────────────────────────────────────

function applyPreset(name) {
  if (!PRESETS[name]) return;
  activePreset = name;
  _sliderChangeLocked = true;
  var p = PRESETS[name];

  if (name !== "custom") {
    setSlider("sensitivity", p.sensitivity, function (v) { updateSensitivity(v); });
    setSlider("threshold",   p.threshold,   function (v) {
      document.getElementById("thresholdValue").textContent = "auto";
    });
    setSlider("minDuration", p.minDuration, function (v) {
      document.getElementById("minDurationValue").textContent = (v / 1000).toFixed(1) + "s";
    });
    setSlider("padding",     p.padding,     function (v) {
      document.getElementById("paddingValue").textContent = v + " ms";
    });
    setSlider("crossfade",   p.crossfade,   function (v) {
      document.getElementById("crossfadeValue").textContent = v + " ms";
    });
    document.getElementById("detectSilence").checked = p.detectSilence !== false;
  }
  _sliderChangeLocked = false;

  _thresholdManual = false;
  updateThresholdHint();

  ["shortform", "podcast", "custom"].forEach(function (key) {
    var btn = document.getElementById("preset-" + key);
    if (btn) btn.classList.toggle("active", key === name);
  });

  saveSettings();
  status("Preset: " + p.label);
}

// Wired on the AI checkbox. Just persists the state now — the old "Will
// remove…" summary line was removed because presets + the big hero card
// on Results already convey intent without an extra line of copy.
function onAIToggle() {
  saveSettings();
}

function setSlider(id, value, displayFn) {
  var el = document.getElementById(id);
  if (!el) return;
  el.value = value;
  if (displayFn) displayFn(value);
}

// Called when the user drags any slider EXCEPT threshold.
// Any manual tweak switches to the Custom preset.
function onSliderChange() {
  if (_sliderChangeLocked) return;
  if (activePreset !== "custom") {
    activePreset = "custom";
    ["shortform", "podcast", "custom"].forEach(function (key) {
      var btn = document.getElementById("preset-" + key);
      if (btn) btn.classList.toggle("active", key === "custom");
    });
  }
  saveSettings();
}

// Any non-slider setting change (audio source dropdown, etc.)
function onAnySettingChange() {
  saveSettings();
}

// Dragging the threshold slider locks a fixed value (disables auto).
function onThresholdDrag(val) {
  if (_sliderChangeLocked) return;
  _thresholdManual = true;
  document.getElementById("thresholdValue").textContent = val + " dB (manual)";
  updateThresholdHint();
  onSliderChange();
}

function updateThresholdHint() {
  var hint = document.getElementById("thresholdHint");
  if (!hint) return;
  if (_thresholdManual) {
    hint.innerHTML = "Manual override. <a href=\"#\" onclick=\"resetThresholdAuto();return false;\">Re-enable auto</a>.";
  } else {
    hint.textContent = "Auto-detected per clip on each Analyze. Drag to lock a fixed value.";
  }
}

function resetThresholdAuto() {
  _thresholdManual = false;
  document.getElementById("thresholdValue").textContent = "auto";
  var autoInfo = document.getElementById("autoThresholdInfo");
  if (autoInfo) autoInfo.style.display = "none";
  updateThresholdHint();
  saveSettings();
  status("Auto-threshold re-enabled");
}

function updateSensitivity(val) {
  var labels = { 1: "Very Conservative", 2: "Conservative", 3: "Medium", 4: "Aggressive", 5: "Very Aggressive" };
  var el = document.getElementById("sensitivityLabel");
  if (el) el.textContent = (labels[val] || "Medium") + " (" + val + ")";
}

// Renders the small "noise floor / speech peak / threshold" info line.
function renderAutoThresholdInfo(result) {
  var autoInfo = document.getElementById("autoThresholdInfo");
  if (!autoInfo || !result) return;
  autoInfo.innerHTML =
    '<span class="auto-label">Noise floor:</span> <span class="auto-value">' + result.noiseFloorDb + ' dB</span>' +
    '<span class="auto-sep">\u00b7</span>' +
    '<span class="auto-label">Speech peak:</span> <span class="auto-value">' + result.speechPeakDb + ' dB</span>' +
    '<span class="auto-sep">\u00b7</span>' +
    '<span class="auto-label">Threshold:</span> <span class="auto-value auto-threshold">' + result.threshold + ' dB</span>';
  autoInfo.style.display = "block";
}

// ─── Scope plan resolver (host bridge) ──────────────────────────────────────

function resolveAnalysisPlan() {
  return new Promise(function (resolve) {
    var payload = JSON.stringify({
      scope:       getScopeMode(),
      audioSource: getAudioSourceMode()
    });
    var escaped = payload.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    cs.evalScript("resolveAnalysisPlan('" + escaped + "')", function (r) {
      resolve(safeParseJSON(r));
    });
  });
}

// ─── Settings persistence ───────────────────────────────────────────────────

function getSettings() {
  var useTrEl     = document.getElementById("useTranscription");
  var crossfadeEl = document.getElementById("crossfade");
  return {
    sensitivity:        parseInt(document.getElementById("sensitivity").value)  || 3,
    silenceThresholdDb: parseInt(document.getElementById("threshold").value)    || -35,
    minSilenceDuration: (parseInt(document.getElementById("minDuration").value) || 300) / 1000,
    paddingMs:          parseInt(document.getElementById("padding").value)      || 120,
    crossfadeMs:        crossfadeEl ? (parseInt(crossfadeEl.value) || 0) : 0,
    detectSilence:      document.getElementById("detectSilence").checked,
    useTranscription:   useTrEl ? useTrEl.checked : false,
    // Auto-threshold is ON by default on every Analyze, regardless of preset.
    // It's only off when the user has manually dragged the threshold slider.
    autoThreshold:      !_thresholdManual,
    thresholdManual:    _thresholdManual,
    scope:              getScopeMode(),
    audioSource:        getAudioSourceMode()
  };
}

function saveSettings() {
  var s = getSettings();
  s.preset = activePreset;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function loadSettings() {
  var raw = localStorage.getItem(SETTINGS_KEY);
  if (raw) {
    try {
      var s = JSON.parse(raw);
      if (s.audioSource) { var asEl = document.getElementById("audioSourceSelect"); if (asEl) asEl.value = s.audioSource; }
      if (typeof s.useTranscription === "boolean") {
        var tr = document.getElementById("useTranscription");
        if (tr) tr.checked = s.useTranscription;
      }
      if (s.preset && PRESETS[s.preset]) {
        applyPreset(s.preset);
        if (s.preset === "custom") {
          _sliderChangeLocked = true;
          if (s.sensitivity)        setSlider("sensitivity",  s.sensitivity,        function (v) { updateSensitivity(v); });
          if (s.silenceThresholdDb) setSlider("threshold",    s.silenceThresholdDb, function (v) { document.getElementById("thresholdValue").textContent = v + " dB"; });
          if (s.minSilenceDuration) setSlider("minDuration",  Math.round(s.minSilenceDuration * 1000), function (v) { document.getElementById("minDurationValue").textContent = (v / 1000).toFixed(1) + "s"; });
          if (s.paddingMs)          setSlider("padding",      s.paddingMs,          function (v) { document.getElementById("paddingValue").textContent = v + " ms"; });
          if (typeof s.crossfadeMs === "number") setSlider("crossfade", s.crossfadeMs, function (v) { document.getElementById("crossfadeValue").textContent = v + " ms"; });
          _sliderChangeLocked = false;
        }
        // Restore manual-threshold lock if the user had it on.
        if (s.thresholdManual) {
          _thresholdManual = true;
          document.getElementById("thresholdValue").textContent =
            (parseInt(document.getElementById("threshold").value) || -35) + " dB (manual)";
          updateThresholdHint();
        }
        onScopeChange();
        return;
      }
    } catch (e) {}
  }
  applyPreset("shortform");
  onScopeChange();
}

// ─── Analyze ────────────────────────────────────────────────────────────────

function analyzeSequence() {
  if (isProcessing) return;

  // v9.7: single-clip mode. Refuse to start analysis if the Scope card
  // isn't in a valid state (no clip or multiple clips selected).
  var tgt = resolveScopeTarget();
  if (!tgt || tgt.invalid) {
    if (!tgt) {
      status("Open a sequence in Premiere to start");
    } else if ((_scopeState && _scopeState.selection && _scopeState.selection.clips.length > 1)) {
      status("Select only one clip to analyze. Pick just one in the timeline.");
    } else {
      status("Select one clip in the timeline to analyze.");
    }
    return;
  }

  setProcessing(true);
  hideDiagPanel();

  var settings = getSettings();
  progress(5, "Resolving scope\u2026");

  resolveAnalysisPlan().then(function (plan) {
    if (!plan || !plan.ok) {
      throw new Error((plan && plan.error) || "Could not resolve analysis scope");
    }

    var clips      = plan.clips;
    var scopeDesc  = plan.scope.description + " \u00b7 " + plan.audio.trackLabel;
    var scopeStart = plan.scope.startSec;
    var scopeEnd   = plan.scope.endSec;

    console.log("[SmartCut] scope:", plan.scope, "audio:", plan.audio,
                "clips:", clips.length);
    console.log("[SmartCut] targetTracks:", plan.targetTracks);
    if (plan.targetTracks && plan.targetTracks.trace) {
      console.log("[SmartCut] resolver trace:", plan.targetTracks.trace);
    }
    status("Analyzing " + clips.length + " clip" +
           (clips.length !== 1 ? "s" : "") + " on " + plan.audio.trackLabel +
           " \u00b7 " + plan.scope.description);
    progress(10, "Decoding " + clips.length + " clip" +
                 (clips.length !== 1 ? "s" : "") + "\u2026");

    // ── Step 1: iterate clips, decode + silence-analyze each ─────────────
    var allSilenceRegions = [];   // sequence-time regions from silence detector
    var allTranscripts    = [];   // per-clip transcripts w/ seq offset
    var audioDurationTotal = 0;
    var autoThreshold     = null;

    // How much of the progress bar we dedicate to the clip decode/analyze
    // loop: if transcription is enabled, leave more room for whisper.
    var decodeBudgetStart = 10;
    var decodeBudgetEnd   = settings.useTranscription ? 45 : 80;

    var clipsPromise = clips.reduce(function (chain, clip, i) {
      return chain.then(function () {
        var pct = decodeBudgetStart +
                  Math.round((decodeBudgetEnd - decodeBudgetStart) * (i / clips.length));
        progress(pct, "Decoding \u2018" + clip.clipName + "\u2019 (" +
                      (i + 1) + "/" + clips.length + ")\u2026");

        var analyzer = new AudioAnalyzer({
          sensitivity:        settings.sensitivity,
          silenceThresholdDb: settings.silenceThresholdDb,
          minSilenceDuration: settings.minSilenceDuration,
          paddingMs:          settings.paddingMs,
          detectSilence:      settings.detectSilence,
          autoThreshold:      settings.autoThreshold,
          trimStart:          clip.inPointSec  || null,
          trimEnd:            clip.outPointSec || null
        });

        var _loaded = null; // holds { arrayBuffer, source, cleanup } so we can free the temp WAV after decode

        // Large files need an ffmpeg extraction pass, which can take several
        // seconds on a 4GB ProRes clip. Nudge the progress message so users
        // don't think the panel froze.
        try {
          var fsSize = require("fs").statSync(clip.mediaPath).size;
          if (fsSize > 500 * 1024 * 1024) {
            progress(pct, "Extracting audio from \u2018" + clip.clipName + "\u2019 (" +
                          Math.round(fsSize / (1024 * 1024 * 1024) * 10) / 10 + " GB)\u2026");
          }
        } catch (eSize) {}

        return AudioAnalyzer.loadSourceForAnalysis(clip.mediaPath)
          .then(function (loaded) {
            _loaded = loaded;
            if (loaded.source === "ffmpeg") {
              console.log("[SmartCut] decoded '" + clip.clipName + "' via ffmpeg extraction");
            }
            return analyzer.decode(loaded.arrayBuffer);
          })
          .then(function (audio) {
            if (_loaded && _loaded.cleanup) { try { _loaded.cleanup(); } catch (e) {} }
            return audio;
          }, function (err) {
            if (_loaded && _loaded.cleanup) { try { _loaded.cleanup(); } catch (e) {} }
            throw err;
          })
          .then(function (audio) {
            var silenceResult = analyzer._analyzeSamples(audio);
            if (silenceResult.autoThreshold && !autoThreshold) {
              autoThreshold = silenceResult.autoThreshold;
            }
            audioDurationTotal += (silenceResult.summary && silenceResult.summary.audioDuration) || 0;

            // Per-clip source-time → sequence-time conversion.
            // Analyzer returns silence regions in SOURCE-ABSOLUTE time
            // (it adds trimStart back at the end of _analyzeSamples). So the
            // correct mapping is:
            //   seqTime = sourceTime - clip.inPointSec + clip.seqStartSec
            // If the clip has been trimmed in Premiere (inPoint > 0) the old
            // formula `sourceTime + seqStartSec` placed regions at wrong
            // sequence positions — the host then couldn't find clips at those
            // times, so nothing got cut ("gaps" on the timeline).
            var clipInPoint = clip.inPointSec || 0;
            (silenceResult.silenceRegions || []).forEach(function (r) {
              var ss = r.startSeconds - clipInPoint + clip.seqStartSec;
              var se = r.endSeconds   - clipInPoint + clip.seqStartSec;
              if (se <= scopeStart || ss >= scopeEnd) return;
              if (ss < scopeStart) ss = scopeStart;
              if (se > scopeEnd)   se = scopeEnd;
              allSilenceRegions.push({
                start:      ss,
                end:        se,
                duration:   se - ss,
                type:       r.type || "silence",
                confidence: r.confidence || 0.8
              });
            });

            // Defer transcription to step 2 (we batch-transcribe clips so
            // whisper cold-start amortizes across them).
            if (settings.useTranscription && window.Transcriber) {
              allTranscripts.push({ clip: clip, audio: audio });
            }
          });
      });
    }, Promise.resolve());

    // ── Step 2: optional whisper pass, one clip at a time ────────────────
    var transcribePromise = clipsPromise.then(function () {
      if (!settings.useTranscription || !window.Transcriber || allTranscripts.length === 0) {
        return { silenceRegions: allSilenceRegions, transcripts: [] };
      }
      var os   = require("os");
      var path = require("path");
      var transcriptResults = [];

      var whisperChain = allTranscripts.reduce(function (chain, entry, i) {
        return chain.then(function () {
          var pct = decodeBudgetEnd +
                    Math.round((85 - decodeBudgetEnd) * (i / allTranscripts.length));
          progress(pct, "Transcribing \u2018" + entry.clip.clipName + "\u2019 (" +
                        (i + 1) + "/" + allTranscripts.length + ")\u2026");

          var tmpWav = path.join(os.tmpdir(),
            "smartcut-whisper-" + Date.now() + "-" + i + ".wav");
          var audio = entry.audio;
          var trimStart = entry.clip.inPointSec  || 0;
          var trimEnd   = entry.clip.outPointSec || (audio.samples.length / audio.sampleRate);
          var startIdx  = Math.max(0, Math.floor(trimStart * audio.sampleRate));
          var endIdx    = Math.min(audio.samples.length, Math.ceil(trimEnd * audio.sampleRate));
          var trimmed   = audio.samples.subarray(startIdx, endIdx);
          AudioAnalyzer.writeWav16kMono(trimmed, audio.sampleRate, tmpWav);

          return Transcriber.transcribe(tmpWav, {
            onProgress: function (wpct, msg) {
              var base = pct;
              progress(base + Math.round((2) * (wpct / 100)), msg);
            },
            onLog: function (line) { console.log("[whisper]", line); }
          }).then(function (transcript) {
            try { require("fs").unlinkSync(tmpWav); } catch (e) {}
            transcriptResults.push({ clip: entry.clip, transcript: transcript });
          });
        });
      }, Promise.resolve());

      return whisperChain.then(function () {
        return { silenceRegions: allSilenceRegions, transcripts: transcriptResults };
      });
    });

    // ── Step 3: bad-take detection (semantic is async) ────────────────────
    return transcribePromise.then(function (stage2) {
      progress(88, "Detecting bad takes\u2026");

      var regions = stage2.silenceRegions.slice();
      var badTakeCount = 0;
      var transcripts  = stage2.transcripts || [];

      if (transcripts.length === 0) {
        return finalize(regions, 0, transcripts);
      }

      // Run detection per clip, merge into sequence-time regions.
      var detectChain = transcripts.reduce(function (chain, entry) {
        return chain.then(function () {
          var clip       = entry.clip;
          var transcript = entry.transcript;
          if (!window.BadTakeDetector || !transcript) return;

          var detPromise;
          if (window.Embedder && window.Embedder.isAvailable && window.Embedder.isAvailable()) {
            if (!window.Embedder.isLoaded()) progress(88, "Loading AI semantic model\u2026");
            detPromise = BadTakeDetector.detect(transcript, { useSemantic: true, debug: true });
          } else {
            detPromise = BadTakeDetector.detect(transcript, { useSemantic: false, debug: true });
          }
          return detPromise.then(function (badTakes) {
            (badTakes || []).forEach(function (r) {
              var srcStart = r.startSeconds + (clip.inPointSec || 0);
              var srcEnd   = r.endSeconds   + (clip.inPointSec || 0);
              var ss = srcStart + clip.seqStartSec - (clip.inPointSec || 0);
              var se = srcEnd   + clip.seqStartSec - (clip.inPointSec || 0);
              if (se <= scopeStart || ss >= scopeEnd) return;
              if (ss < scopeStart) ss = scopeStart;
              if (se > scopeEnd)   se = scopeEnd;
              regions.push({
                start:      ss,
                end:        se,
                duration:   se - ss,
                type:       r.type || "bad_take",
                confidence: r.confidence || 0.8,
                reason:     r.reason || ""
              });
              badTakeCount++;
            });
          });
        });
      }, Promise.resolve());

      return detectChain.then(function () {
        return finalize(regions, badTakeCount, transcripts);
      });
    });

    // Shared finalization: sort, merge overlaps, render.
    function finalize(regions, badTakeCount, transcripts) {
      progress(95, "Merging results\u2026");

      regions.sort(function (a, b) { return a.start - b.start; });
      var merged = [];
      regions.forEach(function (r) {
        if (merged.length && r.start < merged[merged.length - 1].end + 0.1) {
          var prev = merged[merged.length - 1];
          if (r.end > prev.end) prev.end = r.end;
          prev.duration = prev.end - prev.start;
          if (r.type === "bad_take" || r.type === "duplicate") prev.type = r.type;
        } else {
          merged.push(r);
        }
      });

      var totalSaved = 0;
      merged.forEach(function (r) { totalSaved += r.duration; });

      // v9.15: primaryVideoTrackIdx drives Phase 3 relink, the log label, and
      // the "audio source" dump. It MUST be the track that hosts the selected
      // video clip. The previous logic defaulted to 0 (V1) whenever audio
      // came from an audio track, which is always — causing cuts to target
      // V1 regardless of what the user clicked. Derive it from targetTracks
      // (which is computed from the actual selection) instead.
      var primaryVTrackIdx = 0;
      if (plan.targetTracks && plan.targetTracks.video && plan.targetTracks.video.length) {
        primaryVTrackIdx = plan.targetTracks.video[0];
      } else if (plan.audio && plan.audio.resolvedKind === "video" &&
                 typeof plan.audio.resolvedTrackIndex === "number") {
        primaryVTrackIdx = plan.audio.resolvedTrackIndex;
      }

      analysisResult = {
        regions:              merged,
        totalSilenceDuration: totalSaved,
        totalDuration:        audioDurationTotal,
        scope:                plan.scope,
        audioSource:          plan.audio,
        primaryVideoTrackIdx: primaryVTrackIdx,
        targetTracks:         plan.targetTracks || null,
        autoThreshold:        autoThreshold,
        transcripts:          transcripts,
        badTakeCount:         badTakeCount,
        silenceCount:         merged.length - badTakeCount,
        // v9.12: capture the analyzed clip's fingerprint so Apply can bail
        // out if the user switched selection between Analyze and Apply.
        // Without this, an analysis baked against (V3, clip[0], 119.319s)
        // silently gets applied even after the user clicks a different
        // clip on V2 — the cuts go to V3's stale, already-compressed state
        // and nothing useful happens on V2.
        analyzedClipFingerprint: computeScopeFingerprintForAnalysis()
      };

      // Surface the auto-detected threshold in the Advanced panel so the user
      // can see what actually got used. We only write it back to the slider
      // when the user hasn't locked a manual value.
      if (autoThreshold && !_thresholdManual) {
        _autoThresholdResult = autoThreshold;
        renderAutoThresholdInfo(autoThreshold);
        _sliderChangeLocked = true;
        setSlider("threshold", autoThreshold.threshold, function (v) {
          document.getElementById("thresholdValue").textContent = "auto \u00b7 " + v + " dB";
        });
        _sliderChangeLocked = false;
      }

      showResults(analysisResult);
      setProcessing(false);

      var msg = "Found " + merged.length + " region" + (merged.length !== 1 ? "s" : "") +
                " \u00b7 " + totalSaved.toFixed(1) + "s savings \u00b7 " + scopeDesc;
      if (badTakeCount) {
        msg += " \u00b7 " + badTakeCount + " bad take" + (badTakeCount !== 1 ? "s" : "");
      }
      status(msg);
    }

  }).catch(function (err) {
    console.error("[SmartCut] Analyze error:", err);
    setProcessing(false);
    status("Analysis error: " + (err.message || err));
    showDiagPanel(
      "ANALYSIS FAILED\n\n" +
      (err.message || String(err)) + "\n\n" +
      "Possible causes:\n" +
      " 1. The source media is in a codec Chromium can't decode (e.g. ProRes).\n" +
      "    Workaround: transcode the source to H.264 MP4 or WAV, then re-link.\n" +
      " 2. The file path contains characters Node's fs can't handle.\n" +
      " 3. The clip's source media was moved or is offline in Premiere."
    );
  });
}

// ─── Results ────────────────────────────────────────────────────────────────

function showResults(data) {
  if (!data || !data.regions || data.regions.length === 0) {
    status("No silence regions found. Try adjusting settings.");
    return;
  }
  var section = document.getElementById("resultsSection");
  section.style.display = "block";

  // A fresh analysis invalidates any snapshot from the previous apply — the
  // backup sequence is still in the bin, but it no longer corresponds to
  // these regions, so don't offer to "restore" it.
  clearSnapshot();

  selectedRegions = {};
  data.regions.forEach(function (r, i) { selectedRegions[i] = true; });

  renderRegionList(data.regions);
  updateSelectionSummary();

  // Auto-scroll into view so the user doesn't have to hunt for the hero
  // card / region list after analyze finishes. Wait a tick so layout has
  // settled (the list was just injected synchronously). We scroll to the
  // top of the section, not center, so the hero + the first few regions
  // are all visible at once.
  setTimeout(function () {
    try { section.scrollIntoView({ behavior: "smooth", block: "start" }); }
    catch (e) { try { section.scrollIntoView(); } catch (e2) {} }
  }, 60);
}

// ─── Honest time-saved hero card ────────────────────────────────────────────
//
// "Honest" = everything here is derived from real, selected regions and the
// sequence duration reported by the host. No marketing multipliers, no
// speed-up ratios, no fictitious "hours saved in editing". Just:
//
//   saved      = Σ selected region durations
//   originalD  = analyzed audio duration
//   newD       = originalD − saved
//   cuts       = count of selected regions
//   pct        = saved / originalD × 100
//
// The card updates live as the user toggles regions, so the Apply button
// and the big number always agree.
function mmss(totalSec) {
  totalSec = Math.max(0, Math.round(Number(totalSec) || 0));
  var h = Math.floor(totalSec / 3600);
  var m = Math.floor((totalSec % 3600) / 60);
  var s = totalSec % 60;
  var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
  if (h > 0) return h + ":" + pad(m) + ":" + pad(s);
  return m + ":" + pad(s);
}

// Pick the natural unit label for the big hero number so the card reads
// "43 / SEC SAVED", "2:43 / MIN SAVED", or "1:23:45 / HR SAVED" depending
// on magnitude. Under 60s we also swap the number to a plain integer so the
// user doesn't see "0:43" when they could just see "43".
function formatHeroSaved(sec) {
  sec = Math.max(0, Math.round(Number(sec) || 0));
  if (sec < 60)    return { num: String(sec), unit: "sec saved" };
  if (sec < 3600)  return { num: mmss(sec),   unit: "min saved" };
  return                  { num: mmss(sec),   unit: "hr saved"  };
}

function renderCutHero(selectedSaved, selectedCount, originalDuration, breakdown) {
  var heroSaved  = document.getElementById("heroSaved");
  if (!heroSaved) return; // hero card not in DOM (shouldn't happen)

  var savedEl    = heroSaved;
  var breakEl    = document.getElementById("heroBreakdown");
  var pctEl      = document.getElementById("heroPct");
  var beforeEl   = document.getElementById("heroBefore");
  var afterEl    = document.getElementById("heroAfter");

  var orig  = Math.max(0, Number(originalDuration) || 0);
  var saved = Math.max(0, Number(selectedSaved) || 0);
  if (saved > orig) saved = orig;
  var after = Math.max(0, orig - saved);
  var pct   = orig > 0 ? (saved / orig) * 100 : 0;

  var savedFmt         = formatHeroSaved(saved);
  savedEl.textContent  = savedFmt.num;
  var unitEl           = document.getElementById("heroSavedUnit");
  if (unitEl) unitEl.textContent = savedFmt.unit;
  beforeEl.textContent = mmss(orig);
  afterEl.textContent  = mmss(after);
  pctEl.textContent    = (pct >= 10 ? Math.round(pct) : pct.toFixed(1)) + "% tighter";

  // Breakdown string: "12 cuts" by default, or "9 silences + 3 retakes"
  // when the AI toggle surfaced bad takes. Honest about the mix.
  var cutsLabel = selectedCount + " cut" + (selectedCount !== 1 ? "s" : "");
  if (breakdown && (breakdown.silences || breakdown.badTakes)) {
    var parts = [];
    if (breakdown.silences)  parts.push(breakdown.silences + " silence" + (breakdown.silences !== 1 ? "s" : ""));
    if (breakdown.badTakes)  parts.push(breakdown.badTakes + " retake" + (breakdown.badTakes !== 1 ? "s" : ""));
    cutsLabel = parts.join(" + ");
  }
  breakEl.textContent = cutsLabel;
}

function isBadTake(r) {
  return r && (r.type === "bad_take" || r.type === "duplicate" || r.type === "fillers");
}

function renderRegionList(regions) {
  // Split regions into two lists: silences (left as rows with tag + duration)
  // and bad takes (rendered as transcript excerpts). Each row still toggles
  // enable/disable on click of the body; but the timecodes on the left are
  // now independent click targets that seek the Premiere playhead.
  var silencesList  = document.getElementById("silencesList");
  var badTakesList  = document.getElementById("badTakesList");
  var silencesSec   = document.getElementById("silencesSection");
  var badTakesSec   = document.getElementById("badTakesSection");
  var legacyList    = document.getElementById("resultsList");

  if (silencesList)  silencesList.innerHTML = "";
  if (badTakesList)  badTakesList.innerHTML = "";
  if (legacyList)    legacyList.innerHTML = "";

  var silCount = 0, badCount = 0;
  regions.forEach(function (r, i) {
    var bad = isBadTake(r);
    var host = bad ? badTakesList : silencesList;
    if (!host) host = legacyList;
    if (!host) return;

    var el = document.createElement("div");
    el.className = "result-item is-selected";
    el.setAttribute("data-index", i);
    el.onclick = function () { toggleRegion(el, i, r.start); };

    // Map internal type + reason → plain-English label and CSS class.
    // Tags are self-explanatory so we don't render a tooltip anymore
    // (used to set title=... which turned the cursor into the "?" help
    // cursor on hover and added visual noise).
    var info      = getTagInfo(r.type, r.reason, r.duration);
    var typeLabel = info.label;
    var tagClass  = info.className;

    // Clickable timecode segments — stopPropagation so they don't toggle
    var timeHtml =
      '<span class="region-time">' +
        '<span class="region-time-start" title="Jump playhead to cut start">' + fmt(r.start) + '</span>' +
        '<span class="region-time-sep">\u2013</span>' +
        '<span class="region-time-end"   title="Jump playhead to cut end">'   + fmt(r.end)   + '</span>' +
      '</span>';

    var body;
    if (bad) {
      var quote = extractQuote(r.reason) || r.reason || "";
      body =
        '<div class="region-body">' +
          timeHtml +
          '<span class="' + tagClass + '">' + typeLabel + '</span>' +
          (quote ? '<span class="region-quote" title="' + escapeHtml(quote) + '">\u201C' + escapeHtml(quote) + '\u201D</span>' : '') +
        '</div>';
      badCount++;
    } else {
      body =
        '<div class="region-body">' +
          timeHtml +
          '<span class="' + tagClass + '">' + typeLabel + '</span>' +
        '</div>';
      silCount++;
    }

    el.innerHTML =
      '<div class="region-check">' + checkSVG() + '</div>' +
      body +
      '<span class="dur">\u2212' + r.duration.toFixed(1) + 's</span>';

    // Wire up the timecode click handlers AFTER innerHTML is set
    var startSpan = el.querySelector(".region-time-start");
    var endSpan   = el.querySelector(".region-time-end");
    if (startSpan) startSpan.addEventListener("click", function (e) {
      e.stopPropagation();
      seekTo(r.start);
    });
    if (endSpan) endSpan.addEventListener("click", function (e) {
      e.stopPropagation();
      seekTo(r.end);
    });

    host.appendChild(el);
  });

  if (silencesSec) silencesSec.style.display = silCount ? "block" : "none";
  if (badTakesSec) badTakesSec.style.display = badCount ? "block" : "none";
  if (legacyList)  legacyList.style.display  = "none";
}

// Pulls the quoted portion out of BadTakeDetector reason strings like:
//   'restart: "sorry let me try that again"'
// Returns the inner text, or empty string if no quote found.
function extractQuote(s) {
  if (!s) return "";
  var m = s.match(/"([^"]+)"/);
  return m ? m[1] : "";
}

/**
 * Plain-English label + tooltip + CSS class for a region.
 *
 * Silences are classified purely by duration (short gap → long dead air).
 * Bad takes have one of five distinct sub-detectors — we inspect the reason
 * string set by BadTakeDetector to figure out which fired, and surface
 * exactly that sub-type to the user instead of the generic "Restart".
 */
function getTagInfo(type, reason, duration) {
  reason = (reason || "").toLowerCase();
  var durLabel = (duration != null) ? " " + duration.toFixed(1) + "s" : "";

  switch (type) {
    case "silence":
      return {
        label:     "Gap",
        tooltip:   "Short silence between words (under 1s).",
        className: "tag tag-gap"
      };
    case "long_pause":
      return {
        label:     "Pause",
        tooltip:   "Pause between sentences (1-2s). Often intentional, review before cutting.",
        className: "tag tag-pause"
      };
    case "dead_air":
      return {
        label:     "Dead Air",
        tooltip:   "Extended silence (2s+). Almost always safe to cut.",
        className: "tag tag-dead-air"
      };
    case "duplicate":
      return {
        label:     "Repeat",
        tooltip:   "Near word-for-word repeat of a later sentence. Earlier version removed, final kept.",
        className: "tag tag-repeat"
      };
    case "fillers":
      return {
        label:     "Filler",
        tooltip:   "Run of \u201cum\u201d/\u201cuh\u201d/\u201clike\u201d/\u201cyou know\u201d with no real speech in between.",
        className: "tag tag-filler"
      };
    case "bad_take": {
      // Dispatch on reason — every bad_take was tagged by exactly one detector
      if (reason.indexOf("paraphrased retake") === 0 || reason.indexOf("semantic retake") === 0) {
        return {
          label:     "Paraphrase",
          tooltip:   "You said the same idea twice in different words. Earlier version removed, final take kept. (Detected by AI meaning-match, not exact words.)",
          className: "tag tag-paraphrase"
        };
      }
      if (reason.indexOf("mid-sentence stop") === 0) {
        return {
          label:     "Cut-off",
          tooltip:   "You stopped mid-sentence and restarted. The aborted attempt is removed, the completed retake is kept.",
          className: "tag tag-cutoff"
        };
      }
      if (reason.indexOf("retake chain") === 0) {
        return {
          label:     "Retake Chain",
          tooltip:   "Multiple attempts at the same sentence in a row. All earlier attempts removed, only the final take is kept.",
          className: "tag tag-retake-chain"
        };
      }
      if (reason.indexOf("retake (opener") === 0) {
        return {
          label:     "Retake",
          tooltip:   "You restated a sentence with the same opening words. First version removed, second kept.",
          className: "tag tag-retake"
        };
      }
      if (reason.indexOf("restart:") === 0 || reason.indexOf("restart ") === 0) {
        return {
          label:     "Restart",
          tooltip:   "Explicit verbal cue detected (\u201csorry let me try again,\u201d \u201ctake two,\u201d etc.). The flubbed take and the apology are both removed.",
          className: "tag tag-restart"
        };
      }
      return {
        label:     "Retake",
        tooltip:   "Detected as a re-attempt of an earlier sentence.",
        className: "tag tag-retake"
      };
    }
    default:
      return {
        label:     "Cut" + durLabel,
        tooltip:   "",
        className: "tag"
      };
  }
}

function seekTo(sec) {
  if (sec == null || isNaN(sec)) return;
  cs.evalScript("setPlayheadPosition(" + parseFloat(sec) + ")", function () {
    status("Jumped to " + fmt(sec));
  });
}

function checkSVG() {
  return '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--cyan)" stroke-width="2">' +
         '<polyline points="3,8 7,12 13,4"/></svg>';
}

function toggleRegion(el, id, startSeconds) {
  selectedRegions[id] = !selectedRegions[id];
  var nowSelected = selectedRegions[id];
  el.className = "result-item " + (nowSelected ? "is-selected" : "is-deselected");
  var checkEl = el.querySelector(".region-check");
  if (checkEl) checkEl.innerHTML = nowSelected ? checkSVG() : "";
  var durEl = el.querySelector(".dur");
  if (durEl) {
    durEl.style.color      = nowSelected ? "var(--cyan)"     : "";
    durEl.style.background = nowSelected ? "var(--cyan-dim)" : "";
  }
  updateSelectionSummary();
  if (nowSelected) preview(startSeconds);
}

function updateSelectionSummary() {
  if (!analysisResult || !analysisResult.regions) return;
  var regions = analysisResult.regions;
  var totalSaved = 0, selectedCount = 0, silences = 0, badTakes = 0;
  regions.forEach(function (r, i) {
    if (selectedRegions[i] === false) return;
    selectedCount++;
    totalSaved += (r.end - r.start);
    if (isBadTake(r)) badTakes++;
    else              silences++;
  });

  renderCutHero(
    totalSaved,
    selectedCount,
    analysisResult.totalDuration || 0,
    { silences: silences, badTakes: badTakes }
  );

  var applyBtn = document.getElementById("applyBtn");
  if (applyBtn) {
    if (selectedCount === 0) {
      applyBtn.textContent = "Nothing Selected";
      applyBtn.disabled = true;
    } else {
      applyBtn.innerHTML = razorSVG() + " Apply " + selectedCount + " Cut" + (selectedCount !== 1 ? "s" : "");
      applyBtn.disabled = false;
    }
  }
}

// ─── Apply cuts ─────────────────────────────────────────────────────────────

function applyCutsToTimeline() {
  if (isProcessing) return;
  if (!analysisResult || !analysisResult.regions) {
    status("No analysis results. Run Analyze first."); return;
  }

  // v9.12: compare the currently selected clip to the one analyzed. If
  // they don't match, the stored regions + targetTracks are stale — the
  // user switched selection after clicking Analyze. Applying anyway
  // produces confusing results (cuts target the old track's state, which
  // may have been compressed by a prior run or not match the user's
  // current intent). Better to stop cold and ask for a re-analysis.
  var currentFp  = computeScopeFingerprintForAnalysis();
  var analyzedFp = analysisResult.analyzedClipFingerprint || null;
  if (analyzedFp && currentFp && analyzedFp !== currentFp) {
    console.warn("[SmartCut] selection changed since analysis:",
                 "analyzed=", analyzedFp, "current=", currentFp);
    status("Selection changed since Analyze. Click Analyze again to refresh.");
    return;
  }
  if (analyzedFp && !currentFp) {
    status("No clip selected. Select the analyzed clip or re-run Analyze.");
    return;
  }

  // v9.16: keep the guards minimal. The resolver auto-falls back to the
  // detected audio source when no formal link exists, so video-only cuts
  // are now rare. We still bail on the obvious mistakes (no clip selected,
  // multi-video selection that we can't disambiguate).
  var tt = analysisResult.targetTracks;
  if (!tt || !tt.video || tt.video.length === 0) {
    status("No video clip selected. Click a clip on the timeline and re-analyze.");
    return;
  }
  if (tt.video.length > 1) {
    status("Multiple video clips selected. Select exactly one clip and re-analyze.");
    return;
  }
  if (!tt.audio || tt.audio.length === 0) {
    // No linked audio AND no auto-detected audio source overlaps the clip.
    // Almost always means the clip is genuinely video-only (b-roll, title,
    // graphic). Let it through with a short notice — no scary modal.
    console.warn("[SmartCut] no audio target — cutting video only");
    status("Cutting video only (no audio detected for this clip)\u2026");
  }

  var trackIndex = (typeof analysisResult.primaryVideoTrackIdx === "number")
    ? analysisResult.primaryVideoTrackIdx : 0;
  var s = getSettings();

  var regions = analysisResult.regions
    .filter(function (r, i) { return selectedRegions[i] !== false; })
    .sort(function (a, b) { return a.start - b.start; })
    .map(function (r) {
      return {
        startSeconds: r.start,
        endSeconds:   r.end,
        type:         r.type || "silence"
      };
    });

  if (regions.length === 0) { status("No regions selected"); return; }

  setProcessing(true);
  hideDiagPanel();

  var scope = analysisResult.scope || {};

  // Step 1: take a sequence snapshot so the user can restore if they don't
  // like the cut. This is the "safety net" — on success we'll expose the
  // restore button next to Apply. On failure, we log and proceed anyway
  // (native Cmd+Z still works).
  progress(15, "Taking snapshot\u2026");
  cs.evalScript("createSnapshot()", function (snapRaw) {
    var snap = safeParseJSON(snapRaw);
    if (snap && snap.success && snap.backupSequenceID) {
      _snapshot = {
        backupSequenceID:   snap.backupSequenceID,
        backupName:         snap.backupName,
        originalSequenceID: snap.originalSequenceID
      };
      console.log("[SmartCut] snapshot saved:", _snapshot);
    } else {
      _snapshot = null;
      console.warn("[SmartCut] snapshot failed — proceeding without undo safety net:", snapRaw);
    }
    runApplyCuts(regions, trackIndex, s, scope, analysisResult.targetTracks);
  });
}

function runApplyCuts(regions, trackIndex, s, scope, targetTracks) {
  var payload = JSON.stringify({
    regions:             regions,
    paddingMs:           s.paddingMs,
    crossfadeMs:         s.crossfadeMs || 0,
    videoTrackIndex:     trackIndex,
    scopeStartSec:       (typeof scope.startSec === "number") ? scope.startSec : null,
    scopeEndSec:         (typeof scope.endSec   === "number") ? scope.endSec   : null,
    // v9.9: only touch these tracks in PHASE 1 (razor) and PHASE 2 (remove).
    // Derived server-side from the current selection + linked items. Null
    // means "no restriction" (whole-sequence fallback, not currently reachable
    // from the UI since single-clip mode requires exactly one selected clip).
    targetVideoTracks:   (targetTracks && targetTracks.video) ? targetTracks.video : null,
    targetAudioTracks:   (targetTracks && targetTracks.audio) ? targetTracks.audio : null,
    relink:              true
  });
  var escaped = payload.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  var script  = "applyCuts('" + escaped + "')";

  progress(40, "Razoring + removing (" + (scope.description || "full sequence") + ")\u2026");

  cs.evalScript(script, function (r) {
    setProcessing(false);
    var res = safeParseJSON(r);
    console.log("[SmartCut] applyCuts raw:", r);

    if (!res) {
      status("No response from host script. See diagnostics.");
      showDiagPanel(
        "HOST SCRIPT DID NOT RESPOND\n\n" +
        "Possible causes:\n" +
        " 1. SmartCutHost.jsx is not installed in the correct location.\n" +
        " 2. Panel needs reload (close + reopen from Window > Extensions).\n" +
        " 3. Syntax error in host script.\n\n" +
        "Raw: " + String(r)
      );
      return;
    }

    if (res.error) {
      status("Error: " + res.error);
      showDiagPanel("ERROR: " + res.error + "\n\n" +
        (res.log ? "--- Host Log ---\n" + (Array.isArray(res.log) ? res.log.join("\n") : res.log) : ""));
      return;
    }

    useTrial();

    var msg = "Applied " + (res.cutsApplied || 0) + "/" +
              (res.totalRegions || regions.length) + " cuts via " + (res.method || "engine");
    if (res.clipCountBefore !== undefined) {
      msg += " (clips " + res.clipCountBefore + " → " +
             (res.clipCountFinal !== undefined ? res.clipCountFinal : "?") + ")";
    }
    status((res.cutsApplied > 0 ? "\u2713 " : "\u2717 ") + msg);

    // On a successful apply, expose the Restore button — the host already
    // cloned a pre-cut copy of the sequence into the project bin.
    if (res.cutsApplied > 0 && _snapshot) {
      showRestoreButton();
    } else {
      hideRestoreButton();
    }

    if (!res.success || (res.removeErrors && res.removeErrors.length)) {
      var diag = [
        "=== Apply Cuts ===",
        "Method: "      + (res.method || "unknown"),
        "Cuts applied: " + (res.cutsApplied || 0) + "/" + (res.totalRegions || 0),
        "Clips: " + (res.clipCountBefore || "?") + " → " +
                    (res.clipCountAfterRazor || "?") + " (after razor) → " +
                    (res.clipCountFinal || "?") + " (after delete)",
        "Razor calls: " + (res.razorCount || 0),
        "Relink pairs: " + (res.relinkCount || 0)
      ];
      if (res.razorErrors && res.razorErrors.length)
        diag.push("", "Razor errors:", res.razorErrors.map(function (e) { return "  " + e; }).join("\n"));
      if (res.removeErrors && res.removeErrors.length)
        diag.push("", "Remove errors:", res.removeErrors.map(function (e) { return "  " + e; }).join("\n"));
      if (res.log)
        diag.push("", "--- Host Log ---", Array.isArray(res.log) ? res.log.join("\n") : res.log);
      showDiagPanel(diag.join("\n"));
    }
  });
}

// ─── Misc helpers ───────────────────────────────────────────────────────────

function showDiagPanel(text) {
  var panel = document.getElementById("diagPanel");
  if (!panel) return;
  panel.textContent = text;
  panel.style.display = "block";
  panel.scrollTop = 0;
}
function hideDiagPanel() {
  var panel = document.getElementById("diagPanel");
  if (panel) panel.style.display = "none";
}

// ─── Snapshot / Restore ─────────────────────────────────────────────────────
//
// Apply Cuts is destructive — it can fire hundreds of individual razor +
// ripple-delete operations, each of which lands as its own entry in
// Premiere's undo stack. A single Cmd+Z only undoes the last one, so users
// end up mashing Cmd+Z and getting the sequence in a half-cut state. To
// avoid that, the host clones the active sequence into the project bin
// *before* razoring (see createSnapshot in SmartCutHost.jsx). A single
// click of "Restore original" swaps the active sequence back to the clone.
// The cut-up version stays in the bin so nothing is ever lost.

function showRestoreButton() {
  var btn = document.getElementById("restoreBtn");
  if (!btn) return;
  btn.style.display = "block";
  var label = document.getElementById("restoreBtnLabel");
  if (label) label.textContent = "Restore original";
  btn.disabled = false;
}

function hideRestoreButton() {
  var btn = document.getElementById("restoreBtn");
  if (btn) btn.style.display = "none";
}

function clearSnapshot() {
  _snapshot = null;
  hideRestoreButton();
}

function restoreSnapshot() {
  if (!_snapshot || !_snapshot.backupSequenceID) {
    status("Nothing to restore. Snapshot not taken.");
    return;
  }
  var payload = JSON.stringify({ backupSequenceID: _snapshot.backupSequenceID });
  var escaped = payload.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  cs.evalScript("restoreSnapshot('" + escaped + "')", function (r) {
    var res = safeParseJSON(r);
    if (!res || res.error) {
      status("Restore failed: " + (res && res.error ? res.error : "no response"));
      return;
    }
    status("\u21BA Restored original sequence");
    clearSnapshot();
    // The cut-up timeline is no longer active, so results on screen are
    // stale. Clear them and the user can re-analyze the original.
    document.getElementById("resultsSection").style.display = "none";
    analysisResult = null;
    selectedRegions = {};
    refreshScope();
  });
}

function preview(t) {
  cs.evalScript("setPlayheadPosition(" + parseFloat(t) + ")", function () {
    status("Jumped to " + fmt(t));
  });
}

function clearResults() {
  document.getElementById("resultsSection").style.display = "none";
  analysisResult = null;
  selectedRegions = {};
  clearSnapshot();
  hideDiagPanel();
  status("Cleared");
}

function setProcessing(on) {
  isProcessing = on;
  var btn = document.getElementById("analyzeBtn");
  var dot = document.getElementById("statusDot");
  if (on) {
    btn.disabled = true;
    btn.innerHTML = '<svg class="spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Analyzing…';
    dot.className = "status-dot processing";
    document.getElementById("progressSection").style.display = "block";
  } else {
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg> Analyze &amp; Preview';
    dot.className = "status-dot";
    document.getElementById("progressSection").style.display = "none";
    // Refresh disabled-state against the current scope.
    syncAnalyzeButtonState();
  }
}

// Enable/disable the Analyze button based on whether the Scope card is in
// a valid state (exactly one clip selected). Called from renderScopeCard
// on every scope change and from setProcessing when analysis finishes.
function syncAnalyzeButtonState() {
  var btn = document.getElementById("analyzeBtn");
  if (!btn) return;
  if (isProcessing) return; // setProcessing(true) owns the button state
  var tgt = resolveScopeTarget();
  var invalid = !tgt || tgt.invalid;
  btn.disabled = invalid;
  btn.title = invalid
    ? "Select exactly one clip in the timeline to enable analysis"
    : "Analyze the selected clip for silence and bad takes";
}

function progress(pct, txt) {
  var sec = document.getElementById("progressSection");
  var justRevealed = sec.style.display === "none";
  sec.style.display = "block";
  document.getElementById("progressFill").style.width = pct + "%";
  document.getElementById("progressText").textContent = txt || "Processing…";

  // First call per run: scroll the progress bar into view so the user
  // doesn't have to hunt for it after clicking Analyze/Apply. Uses smooth
  // scroll where supported; falls back to instant otherwise.
  if (justRevealed) {
    try { sec.scrollIntoView({ behavior: "smooth", block: "center" }); }
    catch (e) { try { sec.scrollIntoView(); } catch (e2) {} }
  }
}

function status(t) {
  document.getElementById("statusText").textContent = t;
}

function fmt(sec) {
  var m  = Math.floor(sec / 60);
  var s  = Math.floor(sec % 60);
  var ms = Math.round((sec % 1) * 10);
  return (m > 0 ? m + ":" : "") + (s < 10 && m > 0 ? "0" : "") + s + "." + ms;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Double-edge safety razor blade SVG — matches the header logo. Body +
// central mounting slot + two pin-holes, horizontal orientation.
function razorSVG() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' +
           '<rect x="2" y="7.5" width="20" height="9" rx="1.8"/>' +
           '<rect x="7.5" y="10.8" width="9" height="2.4" rx="1.2"/>' +
           '<circle cx="4.8" cy="12" r="0.9"/>' +
           '<circle cx="19.2" cy="12" r="0.9"/>' +
         '</svg>';
}
