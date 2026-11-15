/*
 * School demo · class view (/demo/class). Static, ES5, fictional seed data, nothing stored, no network.
 * Whole-class patterns only: no names, no rankings, no attendance, no marks, groups smaller than 5 never shown.
 */
(function () {
  "use strict";

  var app = document.getElementById("app");
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  var BANDS = { strong: "Strong", growing: "Growing", look: "Needs another look" };

  var STUCK = [
    ["strong", "Sharing up to 12 with pictures", "Dealing one at a time is secure across the class, in the game and in the Roti share mission."],
    ["strong", "Pairs and groups of 2", "Sock pairs came back easily at match night."],
    ["growing", "Linking ÷ to × facts", "Many children check 12 ÷ 3 with 3 × 4 when prompted; fewer do it unprompted yet."],
    ["growing", "Sharing without pictures", "Most still reach for counters or drawings first, which is expected for Stage 2."],
    ["look", "What to do with leftovers", "When things do not share equally, the class tends to give the extra away rather than name it as left over."]
  ];

  var SLIPPING = [
    { what: "Doubling (week 1)", ladder: ["ok", "ok", "fade", ""], note: "Day-14 review shows it is fading, especially doubles past 10.",
      fix: "Suggested 5-minute warm-up: “Double trouble” clap game, doubles of 6, 7, 8 and 9, before Monday’s lesson." },
    { what: "Equal groups (week 2)", ladder: ["ok", "ok", "", ""], note: "Day-7 review: holding well. Day-14 review runs next week.",
      fix: "No action needed. BreakNLearn keeps it coming back in Watch breaks." }
  ];

  var MISC = [
    { key: "unequal", title: "Sharing unequally when there are leftovers",
      seen: "With 7 rotis on 3 plates, children often put 3 on one plate so nothing is “left over”.",
      act: "Fair or not fair? (8 min) Show 7 counters on 3 plates, deal one at a time, then stop and ask: is it fair now? What do we call the one left? Link to the learner profile: principled sharing." },
    { key: "among", title: "Confusing “share among 3” with “groups of 3”",
      seen: "12 shared among 3 gives 4 each, but some children answer 4 groups, mixing up the two meanings of ÷.",
      act: "Two stories, one number sentence (10 min) Act out 12 ÷ 3 twice with 12 children: first as 3 teams (sharing), then as teams of 3 (grouping). Ask which story matches each picture." },
    { key: "count", title: "Counting all instead of counting each group",
      seen: "After dealing, some children count all 12 again rather than the number on one plate.",
      act: "Point and say (5 min) After dealing, each child puts a finger on one plate only and says “each one gets …”. Use the word “each” on the board all week." }
  ];

  var WEEKS = [
    ["Week 1", "Doubling", "done"], ["Week 2", "Equal groups", "done"], ["Week 3", "Sharing equally (÷)", "on"],
    ["Week 4", "Grouping (÷)", ""], ["Week 5", "Fair systems at home & school", ""], ["Week 6", "Class share-shop (summative)", ""]
  ];

  var plan = {};

  function ladder(steps) {
    var days = [3, 7, 14, 30], h = '<div class="ladder">';
    for (var i = 0; i < 4; i++) {
      var st = steps[i], txt = st === "ok" ? "✓ holding" : st === "fade" ? "fading" : "later";
      h += '<span class="' + st + '"><b>Day ' + days[i] + "</b>" + txt + "</span>";
    }
    return h + "</div>";
  }

  function render() {
    var i, h = "";
    h += '<div class="ins-head"><div><div class="eyebrow">Teacher view · Ms Anjali · Grade 2B · 24 children</div>' +
      "<h1>Class 2B · what stuck, what’s slipping</h1>" +
      '<p class="note">Demo Primary School, Chennai (fictional) · Week 3 of 6 · updated Friday</p></div>' +
      '<div class="row" style="margin:0"><a class="pill" href="/demo/teacher" style="text-decoration:none;font-size:16px;padding:10px 16px">← Back to teacher studio</a></div></div>';

    h += '<div class="banner" role="note"><span class="shield" aria-hidden="true">🛡️</span><span>Whole class only</span><span>·</span><span>no names</span><span>·</span><span>no rankings</span><span>·</span><span>no attendance</span><span>·</span><span>no marks</span><span>·</span><span>groups smaller than 5 are never shown</span></div>';

    // concept + timeline
    h += '<div class="panel"><div class="row space" style="margin-top:0"><div><div class="eyebrow">This week’s concept</div><h2 style="margin:0">Sharing equally (÷)</h2></div>' +
      '<div><span class="pill pyp">PYP · How we organise ourselves</span><span class="pill pyp">Function · Responsibility · Perspective</span><span class="pill cam">Cambridge Maths Stage 2 · ÷ as sharing and grouping</span></div></div>' +
      '<p class="note" style="margin:10px 0 6px">Central idea: Communities create systems to share resources fairly.</p><div class="timeline" aria-label="Unit timeline">';
    for (i = 0; i < WEEKS.length; i++) {
      h += '<div class="' + WEEKS[i][2] + '"' + (WEEKS[i][2] === "on" ? ' aria-current="step"' : "") + "><b>" + esc(WEEKS[i][0]) + (WEEKS[i][2] === "on" ? " · now" : WEEKS[i][2] === "done" ? " ✓" : "") + "</b>" + esc(WEEKS[i][1]) + "</div>";
    }
    h += "</div></div>";

    // what stuck + home links
    h += '<div class="pair"><div class="panel"><h3>What stuck this week</h3><ul class="list">';
    for (i = 0; i < STUCK.length; i++) {
      h += '<li><div class="what">' + esc(STUCK[i][1]) + "<small>" + esc(STUCK[i][2]) + '</small></div><span class="band ' + STUCK[i][0] + '">' + BANDS[STUCK[i][0]] + "</span></li>";
    }
    h += '</ul><p class="note">Bands describe the class as a whole, from game answers, Watch breaks and Try it missions. There is no per-child score behind them for you to open.</p></div>';

    h += '<div class="card"><h3>Home links</h3><div class="row" style="margin-top:0;align-items:baseline"><span class="bignum">17</span><span style="font-weight:850;font-size:clamp(18px,1.6vw,24px)">of 24 families</span></div>' +
      "<p style=\"margin-top:0\">did at least one Try it mission at home this week.</p>" +
      '<div class="meter" role="img" aria-label="17 of 24 families"><i style="width:70.8%"></i></div>' +
      '<ul class="list" style="margin-top:10px">' +
      '<li><div class="what">🫓 Roti share<small>kitchen mission</small></div><b>12 families</b></li>' +
      '<li><div class="what">🧦 Sock pairs<small>laundry mission</small></div><b>9 families</b></li>' +
      '<li><div class="what">🪔 Diya rows<small>festival mission</small></div><b>6 families</b></li>' +
      '<li><div class="what">🧓 A grandparent joined in<small>in person or by phone</small></div><b>8 families</b></li>' +
      '<li><div class="what">🏏 Played family match night</div><b>11 families</b></li></ul>' +
      '<p class="note">Counted as families taking part, never as children’s scores. Any count under 5 is hidden.</p></div></div>';

    // slipping
    h += '<div class="panel"><h3>Slipping from earlier weeks</h3><p class="note" style="margin-top:0">From spaced review: every concept comes back after 3, 7, 14 and 30 days. A review “holds” when the class gets about 4 in 5 right.</p><div class="cols">';
    for (i = 0; i < SLIPPING.length; i++) {
      var s = SLIPPING[i];
      h += '<div class="card"><h4>' + esc(s.what) + "</h4>" + ladder(s.ladder) + '<p style="margin-top:10px">' + esc(s.note) + '</p><div class="callout"><p>' + esc(s.fix) + "</p></div></div>";
    }
    h += "</div></div>";

    // misconceptions
    var count = 0; for (var key in plan) { if (Object.prototype.hasOwnProperty.call(plan, key) && plan[key]) { count++; } }
    h += '<div class="panel"><div class="row space" style="margin-top:0"><h3 style="margin:0">Misconceptions we’re seeing</h3>' +
      '<span class="pill' + (count ? " safe" : "") + '" id="plancount">Next week’s plan: ' + count + " added</span></div>" +
      '<div class="tiles" style="margin-top:12px">';
    for (i = 0; i < MISC.length; i++) {
      var m = MISC[i], on = !!plan[m.key];
      var parts = m.act.split(") ");
      h += '<div class="card" style="display:flex;flex-direction:column"><h4>' + esc(m.title) + '</h4><p style="font-size:clamp(15px,1.2vw,18px)">' + esc(m.seen) + "</p>" +
        '<div class="callout" style="flex:1"><p style="font-size:clamp(15px,1.2vw,18px)"><b>Ready reteach · ' + esc(parts[0]) + ")</b> " + esc(parts.slice(1).join(") ")) + "</p></div>" +
        '<button class="sm ' + (on ? "added" : "primary") + '" data-k="' + m.key + '" aria-pressed="' + on + '">' + (on ? "✓ Added to next week’s plan" : "+ Add to next week’s plan") + "</button></div>";
    }
    h += "</div></div>";

    // never
    h += '<div class="panel never"><h3>What you will never see here</h3><ul class="xlist">' +
      "<li>Individual children’s scores or answers</li><li>Rankings, leaderboards or comparisons between children</li>" +
      "<li>Attendance, screen time per child, or a gradebook</li><li>Anything from classroom audio about children</li>" +
      "<li>Any group smaller than 5 children or families</li><li>Family messages, match-night scores or home details</li></ul>" +
      '<p class="note" style="margin-top:14px">Teachers already know their children. This view only points to what the whole class might need next.</p></div>';

    h += '<div class="foot"><a class="pill" href="/demo/teacher" style="text-decoration:none;font-size:16px;padding:10px 16px">← Back to teacher studio</a> <a class="pill pyp" href="/demo/privacy" style="text-decoration:none;font-size:16px;padding:10px 16px">Privacy &amp; trust →</a></div>';

    app.innerHTML = h;
    var btns = app.querySelectorAll("button[data-k]");
    for (i = 0; i < btns.length; i++) { btns[i].onclick = toggle; }
  }

  function toggle() {
    var k = this.getAttribute("data-k");
    plan[k] = !plan[k];
    render();
    var b = app.querySelector('button[data-k="' + k + '"]'); if (b) { b.focus(); }
  }

  render();
})();
