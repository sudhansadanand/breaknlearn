/*
 * School demo · privacy & trust (/demo/privacy). Static, ES5, fictional seed data, nothing stored, no network.
 * Every button here is a demo: nothing is exported, deleted or sent.
 */
(function () {
  "use strict";

  var app = document.getElementById("app");
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function byId(id) { return document.getElementById(id); }
  function on(id, fn) { var b = byId(id); if (b) { b.onclick = fn; } }

  var state = { consent: true, exp: false, del: "idle" };

  var SAMPLE = {
    export_version: 1,
    exported_at: "2026-11-15T18:30:00+05:30",
    family: { display_name: "Raman family", school: "Demo Primary School (fictional)", consent: { version: "guardian-v1", given_by: "Amma (guardian)", given_at: "2026-10-26" } },
    children: [
      { first_name: "Meera", grade: 2, level: "just starting",
        week_3: { concept: "Sharing equally (÷)", game_answers: 31, watch_breaks: 4, try_it: [{ mission: "Roti share", helper: "grandparent" }, { mission: "Sock pairs", helper: "on my own" }] },
        review: [{ concept: "Doubling", day_7: "remembered", day_14: "due" }] },
      { first_name: "Kabir", grade: 4, level: "getting it",
        week_3: { concept: "Division with remainders", game_answers: 42, watch_breaks: 3, try_it: [{ mission: "Ladoo share", helper: "parent" }, { mission: "Run rate", helper: "parent" }] } }
    ],
    match_nights: [{ date: "2026-11-13", result: "Family XI won by 6 runs", players: 5 }],
    parent_questions: ["We bought 15 mangoes for 3 families. How many each?"],
    not_held: ["photos or videos of children", "location", "contacts", "classroom audio about children"]
  };

  var COUNTDOWN_START = 23 * 3600 + 14 * 60 + 52; // seconds left on the example recording
  var left = COUNTDOWN_START;
  function hms(s) {
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h + "h " + (m < 10 ? "0" : "") + m + "m " + (x < 10 ? "0" : "") + x + "s";
  }

  function consentCard() {
    var c = state.consent;
    var h = '<div class="card"><div class="row space" style="margin-top:0"><div><div class="eyebrow">Sample consent card</div><h3 style="margin:0">Guardian consent · version v1</h3></div>' +
      '<span class="status ' + (c ? "ok" : "off") + '">' + (c ? "✓ Consent given" : "✕ Consent withdrawn") + "</span></div>" +
      '<p class="note" style="margin-top:8px">Raman family · given by Amma, a verified guardian, on 26 Oct 2026 · applies to Meera and Kabir</p>' +
      '<div class="tiles two" style="margin-top:10px"><div class="mini"><h4>What we collect</h4><ul style="margin:4px 0 0;padding-left:20px">' +
      "<li>Your child’s own answers in the app</li><li>Try it missions you mark as done, and who helped</li><li>Match night results, inside your family</li><li>Questions you add for match night</li></ul></div>" +
      '<div class="mini"><h4>What we never collect</h4><ul style="margin:4px 0 0;padding-left:20px">' +
      "<li>Photos or videos of children</li><li>Location</li><li>Contacts</li><li>Classroom audio about children</li></ul></div></div>" +
      '<div class="row"><span style="font-weight:850;color:#3b1f6e">Try it:</span><div class="seg" role="group" aria-label="Consent demo">' +
      '<button id="c-on" aria-pressed="' + c + '">Consent given</button><button id="c-off" aria-pressed="' + !c + '">Consent withdrawn</button></div></div>' +
      '<div class="effects" aria-live="polite">';
    if (c) {
      h += "<div><span>✅</span>Meera and Kabir can use Learn, Story, Game, Try it and Watch breaks, tailored to each of them.</div>" +
        "<div><span>✅</span>You get the weekly growth story and the “This week at school” card.</div>" +
        "<div><span>✅</span>Their activity counts toward whole-class patterns for Ms Anjali, only in groups of 5 or more.</div>";
    } else {
      h += "<div><span>⏸️</span>Personal learning stops at once. The app shows only general, non-personal content.</div>" +
        "<div><span>🚫</span>Nothing new is collected. Their data is left out of all class patterns from now on.</div>" +
        "<div><span>🗑️</span>You are offered export and deletion of everything held. You can give consent again at any time.</div>";
    }
    return h + "</div></div>";
  }

  function exportDelete() {
    var h = '<div class="card"><div class="eyebrow">Your data, your choice</div><h3>Export &amp; delete</h3>' +
      "<p>Parents can download everything held about their family, or delete it, from the parent app. No email to the school needed.</p>" +
      '<div class="row"><button id="exp" class="primary sm" aria-expanded="' + state.exp + '">' + (state.exp ? "Hide export preview" : "⬇ Export my family’s data") + "</button>" +
      '<button id="del" class="bad sm"' + (state.del === "done" ? " disabled" : "") + ">🗑 Delete my family’s data</button></div>";
    if (state.exp) {
      h += '<p class="note" style="margin:6px 0 0">Preview of raman-family-export.json (demo, nothing is downloaded):</p><pre class="json mono">' + esc(JSON.stringify(SAMPLE, null, 2)) + "</pre>";
    }
    if (state.del === "confirm") {
      h += '<div class="callout"><p><b>Delete everything for the Raman family?</b> This removes both children’s answers, missions, match nights and questions. It cannot be undone.</p>' +
        '<div class="row"><button id="del-yes" class="bad sm">Yes, delete it all</button><button id="del-no" class="ghost sm">Cancel</button></div></div>';
    } else if (state.del === "done") {
      h += '<div class="callout"><p><span class="status ok">✓ Deleted · confirmation sent</span></p><p style="margin-top:8px">The guardian gets a confirmation. Backups expire on their normal cycle. <b>Demo only: nothing was deleted.</b></p>' +
        '<div class="row"><button id="del-reset" class="ghost sm">Reset demo</button></div></div>';
    }
    return h + "</div>";
  }

  function audio() {
    return '<div class="panel"><div class="eyebrow">Teacher coaching audio</div><h3>How classroom audio is handled</h3>' +
      "<p>Teachers can choose to record a lesson for private coaching on their own teaching. Here is what happens to that recording.</p>" +
      '<div class="flow" role="list">' +
      '<div class="stepbox" role="listitem"><span class="ico" aria-hidden="true">🎙️</span><b>1 · Record</b>The teacher’s own clip-on mic, started and stopped by the teacher.</div><div class="arrow" aria-hidden="true">→</div>' +
      '<div class="stepbox" role="listitem"><span class="ico" aria-hidden="true">🧑‍🏫</span><b>2 · Teacher’s voice only</b>Other voices in the room are filtered out and not kept.</div><div class="arrow" aria-hidden="true">→</div>' +
      '<div class="stepbox" role="listitem"><span class="ico" aria-hidden="true">📝</span><b>3 · Text transcript</b>Names are removed, so “Meera, try it” becomes “[child], try it”.</div><div class="arrow" aria-hidden="true">→</div>' +
      '<div class="stepbox" role="listitem"><span class="ico" aria-hidden="true">⏳</span><b>4 · Audio deleted within 24h</b>Example: Tuesday’s lesson, deleting in <span class="mono" id="cd" style="font-weight:900;color:var(--yellow)">' + hms(left) + "</span></div><div class=\"arrow\" aria-hidden=\"true\">→</div>" +
      '<div class="stepbox end" role="listitem"><span class="ico" aria-hidden="true">🚫</span><b>5 · Never used to assess any child</b>Coach notes are private to the teacher. The school never sees them.</div></div></div>';
  }

  function render() {
    var h = '<div class="ins-head"><div><div class="eyebrow">For principals, coordinators and parents</div><h1>Privacy &amp; trust, built in</h1>' +
      "<p>Children’s data is handled with parents in control: what we collect is small, what we never collect is clear, and families can leave at any time.</p></div></div>";

    h += '<div class="cols">' + consentCard() + exportDelete() + "</div>";
    h += '<div class="sec">' + audio() + "</div>";

    h += '<div class="cols sec"><div class="panel" style="margin:0"><div class="eyebrow">Where data lives</div><h3>Data stays in India</h3>' +
      '<p><span class="status warn">Planned</span></p><p>Planned: data hosted in the Mumbai region before any school pilot. This is not in place yet, and we will confirm it in writing before a pilot starts.</p>' +
      '<p class="note">Today this demo stores nothing at all: no accounts, no network calls, nothing saved in the browser.</p></div>' +
      '<div class="panel" style="margin:0"><div class="eyebrow">The law</div><h3>Built around verifiable parental consent</h3>' +
      "<p>Our approach follows India’s Digital Personal Data Protection Act, 2023, for children’s data: verifiable consent from a parent or guardian, no tracking or targeted ads aimed at children, and data used only for the purpose it was given.</p>" +
      '<p class="note">This describes our design approach. It is not a certification or a legal opinion.</p></div></div>';

    h += '<div class="card sec"><div class="eyebrow">Our commitments</div><h3>What BreakNLearn will always do, and never do</h3><div class="cols">' +
      '<ul class="xlist" style="grid-template-columns:1fr"><li>No ads, ever</li><li>No rankings or leaderboards</li><li>No selling or sharing of data</li><li>No attendance tracking or gradebook</li></ul>' +
      '<ul class="xlist yes" style="grid-template-columns:1fr"><li>Coach notes stay private to the teacher</li><li>The school sees whole-class patterns only, in groups of 5 or more</li><li>Parents can export or delete their family’s data at any time</li><li>Every Try it mission is checked by a person for safety</li></ul></div></div>';

    h += '<div class="foot"><a class="pill" href="/demo/class" style="text-decoration:none;font-size:16px;padding:10px 16px">← Class view</a> <a class="pill" href="/demo" style="text-decoration:none;font-size:16px;padding:10px 16px">Back to start</a>' +
      '<p class="note">Fictional school and family. All buttons on this page are demonstrations.</p></div>';

    app.innerHTML = h;
    wire();
  }

  function rerender(focusId) {
    render();
    var f = byId(focusId); if (f) { f.focus(); }
  }

  function wire() {
    on("c-on", function () { state.consent = true; rerender("c-on"); });
    on("c-off", function () { state.consent = false; rerender("c-off"); });
    on("exp", function () { state.exp = !state.exp; rerender("exp"); });
    on("del", function () { state.del = "confirm"; rerender("del-yes"); });
    on("del-yes", function () { state.del = "done"; rerender("del-reset"); });
    on("del-no", function () { state.del = "idle"; rerender("del"); });
    on("del-reset", function () { state.del = "idle"; rerender("del"); });
  }

  setInterval(function () {
    left = left > 0 ? left - 1 : COUNTDOWN_START;
    var c = byId("cd"); if (c) { c.innerHTML = hms(left); }
  }, 1000);

  render();
})();
