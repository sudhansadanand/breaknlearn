/*
 * BreakNLearn concept prototype: one week's concept ("sharing equally", division) in every mode.
 * Static, ES5, no network calls, nothing stored. Driven by a TV remote (arrows, Enter, Back) or keyboard.
 */
(function () {
  "use strict";

  var WORLDS = [
    { key: "puppy", name: "Puppy Park", icon: "🐶", color: "#6633a8", obj: "🦴", objs: "bones", who: "🐶", whos: "puppies" },
    { key: "candy", name: "Candy Land", icon: "🍬", color: "#a64487", obj: "🍬", objs: "candies", who: "🧒", whos: "friends" },
    { key: "unicorn", name: "Unicorn Sky", icon: "🦄", color: "#5546b8", obj: "⭐", objs: "stars", who: "🦄", whos: "unicorns" },
    { key: "school", name: "School Box", icon: "✏️", color: "#287ba1", obj: "✏️", objs: "pencils", who: "🧒", whos: "classmates" },
    { key: "treat", name: "Treat Time", icon: "🍦", color: "#986034", obj: "🍦", objs: "ice creams", who: "🧒", whos: "friends" },
    { key: "farm", name: "Animal Farm", icon: "🐴", color: "#4d8a60", obj: "🥕", objs: "carrots", who: "🐴", whos: "horses" }
  ];

  // School demo mode (/demo/child): set by child.html. Fictional school and children; same engine.
  var DEMO = window.BNL_DEMO || null;
  var UNIT = DEMO ? {
    school: "Demo Primary School", teacher: "Ms Anjali", week: "Week 3 of 6",
    theme: "How we organise ourselves", idea: "Communities create systems to share resources fairly.",
    concepts: "Function · Responsibility · Perspective", cambridge: "Cambridge Primary Maths · Stage 2: division as sharing and grouping"
  } : null;

  var LEVELS = {
    starter: { name: "Just starting", detail: "Small numbers, with pictures", who: "🧒 Child A", kid: "Child A" },
    explorer: { name: "Getting it", detail: "Bigger numbers and word problems", who: "👧 Child B", kid: "Child B" }
  };
  if (DEMO) {
    LEVELS.starter = { name: "Meera · Grade 2", detail: "Just starting: small numbers, with pictures", who: "👧 Meera · Grade 2", kid: "Meera" };
    LEVELS.explorer = { name: "Kabir · Grade 4", detail: "Getting it: leftovers, money and word problems", who: "👦 Kabir · Grade 4", kid: "Kabir" };
  }

  var state = { world: WORLDS[5], level: "starter", voice: true, screen: "home", parentQuestions: [], missions: [] };
  var timers = [];
  var app = document.getElementById("app");

  // ---------- helpers ----------
  function el(html) { app.innerHTML = html; focusFirst(); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function rep(icon, n) { var s = ""; for (var i = 0; i < n; i++) { s += icon; } return s; }
  function rnd(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }
  function clearTimers() { for (var i = 0; i < timers.length; i++) { clearTimeout(timers[i]); clearInterval(timers[i]); } timers = []; }
  function byId(id) { return document.getElementById(id); }
  function on(id, fn) { var b = byId(id); if (b) { b.onclick = fn; } }
  function focusFirst() {
    var f = app.querySelector("[data-first]") || app.querySelector("button,input");
    if (f) { try { f.focus({ preventScroll: true }); } catch (e) { f.focus(); } }
  }
  function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }

  function speak(text) {
    if (!state.voice || !window.speechSynthesis || !window.SpeechSynthesisUtterance) { return; }
    try {
      window.speechSynthesis.cancel();
      var u = new window.SpeechSynthesisUtterance(text.replace(/÷/g, " divided by ").replace(/×/g, " times "));
      u.lang = "en-IN";
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) { /* speech is optional */ }
  }
  function hush() { try { if (window.speechSynthesis) { window.speechSynthesis.cancel(); } } catch (e) { /* ignore */ } }

  function go(screen) {
    clearTimers();
    hush();
    state.screen = screen;
    try { window.scrollTo(0, 0); } catch (e) { /* ignore */ }
    document.documentElement.style.setProperty("--world", state.world.color);
    SCREENS[screen]();
  }

  function topBar(title) {
    return '<div class="row space"><div><div class="eyebrow">' + esc(state.world.icon + " " + state.world.name + " · " + LEVELS[state.level].name) + "</div><h2>" + esc(title) + "</h2></div>" +
      '<div class="row"><button id="voice" class="ghost">' + (state.voice ? "🔊 Read aloud on" : "🔇 Read aloud off") + '</button><button id="back" class="soft">← Back</button></div></div>';
  }
  function wireTop(backTo) {
    on("back", function () { go(backTo || "hub"); });
    on("voice", function () { state.voice = !state.voice; hush(); byId("voice").innerHTML = state.voice ? "🔊 Read aloud on" : "🔇 Read aloud off"; });
  }

  // ---------- questions ----------
  // difficulty 1..3 within a level; starter shows pictures.
  function makeQuestion(level, diff) {
    var w = state.world, b, q, text, pics;
    if (level === "starter") {
      b = [2, 3, 4][Math.min(diff, 3) - 1] || 2; q = rnd(2, 2 + diff); pics = true;
      text = (b * q) + " " + w.objs + " shared equally among " + b + " " + w.whos + ". How many each?";
    } else if (level === "explorer") {
      b = rnd(2 + diff, 5 + diff); q = rnd(3, 4 + diff * 2); pics = false;
      text = pick([
        (b * q) + " " + w.objs + " go into " + b + " equal boxes. How many in each box?",
        (b * q) + " ÷ " + b + " = ?",
        b + " " + w.whos + " share " + (b * q) + " " + w.objs + " fairly. How many does each get?"
      ]);
    } else { // grown-up
      b = rnd(4, 9); q = rnd(12, 45) ; pics = false;
      text = pick([
        "₹" + (b * q * 10) + " shared equally among " + b + " people. How much each?",
        "A school trip of " + (b * q) + " children fills " + b + " buses equally. How many per bus?"
      ]);
      if (text.charAt(0) === "₹") { q = q * 10; }
    }
    var opts = [q];
    var cands = shuffle([q + 1, q - 1, q + b, q + 2, q - 2, q * 2]);
    for (var i = 0; i < cands.length && opts.length < 4; i++) { if (cands[i] > 0 && opts.indexOf(cands[i]) < 0) { opts.push(cands[i]); } }
    return { a: b * q, b: b, q: q, text: text, pics: pics, options: shuffle(opts), money: text.charAt(0) === "₹" };
  }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function showMe(qn) {
    if (qn.money || qn.a > 60) { return "<p>" + qn.a + " ÷ " + qn.b + " = " + qn.q + ", because " + qn.b + " × " + qn.q + " = " + qn.a + ".</p>"; }
    var g = '<div class="groups">';
    for (var i = 0; i < qn.b; i++) { g += '<div class="group pop"><div class="who">' + state.world.who + "</div>" + rep(state.world.obj, qn.q) + "</div>"; }
    return g + "</div><p>" + qn.b + " groups of " + qn.q + " make " + qn.a + ". So " + qn.a + " ÷ " + qn.b + " = " + qn.q + ".</p>";
  }
  function optionsHtml(qn) {
    var h = '<div class="options">';
    for (var i = 0; i < qn.options.length; i++) { h += '<button class="soft opt"' + (i === 0 ? " data-first" : "") + ' data-v="' + qn.options[i] + '">' + (qn.money ? "₹" : "") + qn.options[i] + "</button>"; }
    return h + "</div>";
  }
  function wireOptions(qn, done) {
    var bs = app.querySelectorAll(".opt");
    for (var i = 0; i < bs.length; i++) {
      bs[i].onclick = function () {
        var v = Number(this.getAttribute("data-v"));
        for (var j = 0; j < bs.length; j++) { bs[j].disabled = true; if (Number(bs[j].getAttribute("data-v")) === qn.q) { bs[j].className = "good opt"; } }
        if (v !== qn.q) { this.className = "bad opt"; }
        done(v === qn.q);
      };
    }
  }

  // ---------- screens ----------
  var SCREENS = {};

  SCREENS.home = function () {
    var worlds = "";
    for (var i = 0; i < WORLDS.length; i++) {
      var w = WORLDS[i];
      worlds += '<button class="world' + (w === state.world ? " on" : "") + '" data-w="' + i + '"' + (w === state.world ? " data-first" : "") + '><span class="big">' + w.icon + "</span>" + esc(w.name) + "</button>";
    }
    el((UNIT ? unitHeader() : '<div class="eyebrow">This week at school</div><h1>Sharing equally (÷)</h1>') +
      "<p>One concept, every mode: learn it, hear its story, play with it, and practise it together as a family.</p>" +
      '<div class="panel"><h3>1. Pick your world</h3><div class="grid six">' + worlds + "</div></div>" +
      '<div class="panel"><h3>2. Who is playing?</h3><div class="grid two">' +
      '<button class="lvl' + (state.level === "starter" ? " good" : "") + '" data-l="starter">' + (DEMO ? LEVELS.starter.who : "🧒 Child A · " + LEVELS.starter.name) + '<br><small>' + LEVELS.starter.detail + "</small></button>" +
      '<button class="lvl' + (state.level === "explorer" ? " good" : "") + '" data-l="explorer">' + (DEMO ? LEVELS.explorer.who : "👧 Child B · " + LEVELS.explorer.name) + '<br><small>' + LEVELS.explorer.detail + "</small></button>" +
      '</div><div class="row"><button id="start" class="primary">Let’s go →</button></div></div>' +
      '<p class="note">' + (DEMO ? "Same concept, pitched to each child: Meera and Kabir are siblings in different grades. Levels come from each child’s own answers; the concept comes from the pack " + UNIT.teacher + " approved this week." : "In the real app the level comes from each child’s quiz results, and the concept from what their teacher taught this week.") + "</p>");
    var ws = app.querySelectorAll(".world");
    for (var j = 0; j < ws.length; j++) { ws[j].onclick = function () { state.world = WORLDS[Number(this.getAttribute("data-w"))]; go("home"); byId("start").focus(); }; }
    var ls = app.querySelectorAll(".lvl");
    for (var k = 0; k < ls.length; k++) { ls[k].onclick = function () { state.level = this.getAttribute("data-l"); go("home"); byId("start").focus(); }; }
    on("start", function () { go("hub"); });
  };

  SCREENS.hub = function () {
    var w = state.world;
    var tiles = [
      ["learn", "💡", "Learn", "How sharing equally works, step by step"],
      ["story", "📜", "Story", "Surprising facts and history of ÷"],
      ["game", "🎮", "Game", "Quick quizzes that adapt to you"],
      ["tryit", "🧺", "Try it", "Real-world missions at home"],
      ["watch", "📺", "Watch", "A short episode with a 60-second break"],
      ["match", "🏏", "Family match night", "Everyone plays, cricket style"],
      ["parents", "👪", "For parents", "This week at school + dinner questions"]
    ];
    if (DEMO) { tiles.splice(4, 0, ["wonder", "🤔", "Big question", "Is equal always fair? There’s no wrong answer"]); }
    var h = "";
    for (var i = 0; i < tiles.length; i++) {
      h += '<button class="tile" data-go="' + tiles[i][0] + '"' + (i === 0 ? " data-first" : "") + '><span class="big">' + tiles[i][1] + "</span>" + tiles[i][2] + "<small>" + tiles[i][3] + "</small></button>";
    }
    el('<div class="row space"><div><div class="eyebrow">' + esc(w.icon + " " + w.name + " · " + LEVELS[state.level].name) + '</div><h1>Sharing equally (÷)</h1>' + (UNIT ? unitPills() : "") + '</div><button id="home" class="soft">Change world or player</button></div>' +
      '<div class="grid">' + h + "</div>" +
      '<p class="hint">Use the arrow keys and OK/Enter. Back returns here.</p>');
    var ts = app.querySelectorAll(".tile");
    for (var j = 0; j < ts.length; j++) { ts[j].onclick = function () { go(this.getAttribute("data-go")); }; }
    on("home", function () { go("home"); });
    if (state.focusTile) { var ft = app.querySelector('[data-go="' + state.focusTile + '"]'); state.focusTile = null; if (ft) { ft.focus(); } }
  };

  // ----- Learn -----
  SCREENS.learn = function () {
    var w = state.world, total = 12, groups = 3, dealt = 0, step = 0;
    function slide() {
      hush();
      var body = "", say = "";
      if (step === 0) {
        say = "We have " + total + " " + w.objs + " and " + groups + " " + w.whos + ". Let's share them fairly, so everyone gets the same.";
        body = '<div class="stage">' + rep(w.obj, total) + "</div><div class=\"stage\">" + rep(w.who, groups) + "</div>";
      } else if (step === 1) {
        say = dealt < total ? "Give one to each, round and round. Press Deal." : "Each of the " + w.whos + " gets 4 " + w.objs + ". Nobody has more. That's sharing equally!";
        body = '<div class="stage">' + rep(w.obj, total - dealt) + "&nbsp;</div>" + groupsHtml(dealt);
      } else if (step === 2) {
        say = "That's division! 12 shared among 3 is 4. We write it as 12 ÷ 3 = 4. The sign ÷ means share equally.";
        body = groupsHtml(total) + '<div class="question">12 ÷ 3 = 4</div>';
      } else if (step === 3) {
        say = "Check it: 4 plus 4 plus 4 is 12. Three groups of 4. That's 3 × 4 = 12, the times table you already know!";
        body = groupsHtml(total) + '<div class="question">4 + 4 + 4 = 12 &nbsp;·&nbsp; 3 × 4 = 12</div>';
      } else {
        return tryOne();
      }
      el(topBar("Learn · step " + (step + 1) + " of 5") + '<div class="panel">' + body + "<p>" + esc(say) + "</p>" +
        '<div class="row">' + (step === 1 && dealt < total ? '<button id="deal" class="primary" data-first>Deal →</button>' : "") +
        '<button id="next" class="' + (step === 1 && dealt < total ? "" : "primary") + '"' + (step === 1 && dealt < total ? "" : " data-first") + ">Next →</button></div></div>");
      wireTop();
      on("deal", function () { dealt = Math.min(total, dealt + groups); slide(); var d = byId("deal"); if (d) { d.focus(); } });
      on("next", function () { if (step === 1 && dealt < total) { dealt = total; } step++; slide(); });
      speak(say);
    }
    function groupsHtml(n) {
      var h = '<div class="groups">';
      for (var g = 0; g < groups; g++) {
        var c = Math.floor(n / groups) + (g < n % groups ? 1 : 0);
        h += '<div class="group"><div class="who">' + w.who + "</div>" + rep(w.obj, c) + "</div>";
      }
      return h + "</div>";
    }
    function tryOne() {
      var qn = { a: 8, b: 2, q: 4, pics: true, money: false, options: shuffle([4, 6, 3, 2]), text: "8 " + w.objs + " shared among 2 " + w.whos + ". How many each?" };
      el(topBar("Learn · your turn") + '<div class="panel"><div class="stage">' + rep(w.obj, 8) + '</div><div class="question">' + esc(qn.text) + "</div>" + optionsHtml(qn) +
        '<div id="fb" class="feedback"></div><div id="more"></div></div>');
      wireTop();
      speak("Your turn. " + qn.text);
      wireOptions(qn, function (ok) {
        byId("fb").className = "feedback " + (ok ? "good" : "bad");
        byId("fb").innerHTML = ok ? "⭐ Yes! 8 ÷ 2 = 4" : "Nearly! Let’s see it.";
        speak(ok ? "Yes! 8 divided by 2 is 4." : "Nearly! Here are the two groups.");
        byId("more").innerHTML = (ok ? "" : showMe(qn)) + '<div class="row"><button id="done" class="primary">Play the game →</button><button id="again" class="soft">Watch again</button></div>';
        on("done", function () { go("game"); });
        on("again", function () { go("learn"); });
        byId("done").focus();
      });
    }
    slide();
  };

  // ----- Story -----
  var FACTS = [
    { art: "÷", title: "A sign with a story", text: "The ÷ sign is called an obelus. Long before it meant divide, scholars in ancient Greece used a mark like it to point out words in old copies of books that might be wrong." },
    { art: "📖", title: "Its first maths job: 1659", text: "In 1659 a Swiss mathematician, Johann Rahn, printed ÷ in an algebra book to mean divide. That is how it became the sign you use today." },
    { art: "🔢", title: "India's rules for dividing", text: "Almost 1,400 years ago, in the year 628, the Indian mathematician Brahmagupta wrote rules for dividing numbers, even rules about dividing with zero." },
    { art: "➗", title: "Not everyone writes ÷", text: "In many countries children write division with a colon instead, like 12 : 3 = 4. On a calculator or computer you'll often see a slash: 12 / 3." },
    { art: "🛒", title: "Fair shares in the market", text: "Shopkeepers have always needed fair shares: splitting a sack of rice into equal bags, or a bill among friends. Every time, they are dividing." }
  ];
  if (DEMO) {
    FACTS.splice(4, 1,
      { art: "🍛", title: "A kitchen that feeds everyone", text: "At the Golden Temple in Amritsar, the community kitchen, called the langar, serves free meals to tens of thousands of people every day. Everyone sits together in rows and gets the same food. Volunteers organise it so the sharing is fair." },
      { art: "🛒", title: "Fair shares in the market", text: "Shopkeepers have always needed fair shares: splitting a sack of rice into equal bags, or a bill among friends. Every time, they are dividing." });
  }
  SCREENS.story = function () {
    var i = 0;
    function show() {
      var f = FACTS[i];
      el(topBar("Story · " + (i + 1) + " of " + FACTS.length) + '<div class="panel"><div class="factart">' + f.art + "</div><h2>" + esc(f.title) + '</h2><div class="fact">' + esc(f.text) + "</div>" +
        '<div class="row"><button id="next" class="primary" data-first>' + (i < FACTS.length - 1 ? "Next fact →" : "Quick question →") + "</button>" + (i > 0 ? '<button id="prev">← Previous</button>' : "") + "</div></div>" +
        '<p class="note">Story facts are checked before they reach children.</p>');
      wireTop();
      on("next", function () { if (i < FACTS.length - 1) { i++; show(); } else { quiz(); } });
      on("prev", function () { i--; show(); });
      speak(f.title + ". " + f.text);
    }
    function quiz() {
      var opts = shuffle(["Johann Rahn", "Brahmagupta", "A shopkeeper", "A unicorn"]);
      var h = '<div class="options">';
      for (var k = 0; k < opts.length; k++) { h += '<button class="soft opt"' + (k === 0 ? " data-first" : "") + ' data-v="' + esc(opts[k]) + '">' + esc(opts[k]) + "</button>"; }
      el(topBar("Story · quick question") + '<div class="panel"><div class="question">Who first printed ÷ to mean divide?</div>' + h + '</div><div id="fb" class="feedback"></div><div id="more"></div></div>');
      wireTop();
      speak("Quick question. Who first printed the divide sign to mean divide?");
      var bs = app.querySelectorAll(".opt");
      for (var j = 0; j < bs.length; j++) {
        bs[j].onclick = function () {
          var ok = this.getAttribute("data-v") === "Johann Rahn";
          for (var m = 0; m < bs.length; m++) { bs[m].disabled = true; if (bs[m].getAttribute("data-v") === "Johann Rahn") { bs[m].className = "good opt"; } }
          if (!ok) { this.className = "bad opt"; }
          byId("fb").className = "feedback " + (ok ? "good" : "bad");
          byId("fb").innerHTML = ok ? "⭐ Right! In 1659." : "It was Johann Rahn, in 1659.";
          speak(ok ? "Right! Johann Rahn, in 1659." : "It was Johann Rahn, in 1659.");
          byId("more").innerHTML = '<div class="row"><button id="done" class="primary">Back to modes</button></div>';
          on("done", function () { go("hub"); });
          byId("done").focus();
        };
      }
    }
    show();
  };

  // ----- Game -----
  SCREENS.game = function () {
    var n = 0, total = 6, diff = 1, streak = 0, stars = 0;
    function next() {
      if (n >= total) { return finish(); }
      var qn = makeQuestion(state.level, diff);
      el(topBar("Game · question " + (n + 1) + " of " + total) +
        '<div class="score"><div><b>' + stars + '</b><span>stars</span></div><div><b>' + ["", "●", "●●", "●●●"][diff] + '</b><span>level</span></div></div>' +
        '<div class="panel">' + (qn.pics ? '<div class="stage">' + rep(state.world.obj, qn.a) + "</div>" : "") + '<div class="question">' + esc(qn.text) + "</div>" + optionsHtml(qn) +
        '<div id="fb" class="feedback"></div><div id="more"></div></div>');
      wireTop();
      speak(qn.text);
      wireOptions(qn, function (ok) {
        n++;
        if (ok) { stars++; streak++; if (streak >= 2 && diff < 3) { diff++; streak = 0; } }
        else { streak = 0; if (diff > 1) { diff--; } }
        byId("fb").className = "feedback " + (ok ? "good" : "bad");
        byId("fb").innerHTML = ok ? pick(["⭐ Brilliant!", "⭐ Spot on!", "⭐ Super sharing!"]) : "Not quite. Let’s see it:";
        speak(ok ? "Brilliant!" : "Not quite. Let's see it.");
        byId("more").innerHTML = (ok ? "" : showMe(qn)) + '<div class="row"><button id="go" class="primary">Next →</button></div>';
        on("go", next);
        byId("go").focus();
      });
    }
    function finish() {
      el(topBar("Game · done") + '<div class="panel" style="text-align:center"><div class="factart">' + rep("⭐", Math.max(1, stars)) + "</div><h2>" + stars + " stars out of " + total + "!</h2>" +
        "<p>Questions got harder after two right in a row, and easier after a miss, so it always felt just right.</p>" +
        '<div class="row" style="justify-content:center"><button id="again" class="primary" data-first>Play again</button><button id="hub2">Back to modes</button></div></div>');
      wireTop();
      speak("You got " + stars + " stars!");
      on("again", function () { go("game"); });
      on("hub2", function () { go("hub"); });
    }
    next();
  };

  // ----- Try it (real-world missions) -----
  var MISSIONS = {
    starter: [
      { key: "roti", place: "Kitchen", icon: "🫓", title: "Roti share", item: "🫓", who: "🍽️", setup: "Help set the table for dinner.", steps: ["Count out 6 rotis (or 6 paper circles).", "Put out 3 plates.", "Deal the rotis one at a time onto the plates, like a card dealer.", "Count how many are on each plate."], a: 6, b: 3, q: 2, ask: "How many rotis on each plate?", recall: "Remember your Roti share mission? 6 rotis on 3 plates. How many on each?" },
      { key: "socks", place: "Bedroom", icon: "🧦", title: "Sock pairs", item: "🧦", who: "👣", setup: "Laundry helper time!", steps: ["Find 10 socks from the clean laundry.", "Match them into pairs of 2.", "Count the pairs."], a: 10, b: 2, q: 5, pairs: true, ask: "How many pairs did 10 socks make?", recall: "Remember the Sock pairs mission? 10 socks in pairs. How many pairs?" },
      { key: "diya", place: "Festival", icon: "🪔", title: "Diya rows", item: "🪔", who: "▫️", setup: "Get ready for Diwali (cups or bottle caps work too).", steps: ["Take 12 diyas.", "Make 3 equal rows.", "Count how many are in each row."], a: 12, b: 3, q: 4, ask: "How many diyas in each row?", recall: "Remember the Diya rows mission? 12 diyas in 3 equal rows. How many in each?" }
    ],
    explorer: [
      { key: "ladoo", place: "Kitchen", icon: "🟠", title: "Ladoo share", item: "🟠", who: "🧑", setup: "Sweets after dinner, shared fairly.", steps: ["Take 14 ladoos (or 14 biscuits).", "Share them equally among 4 people at home.", "How many each? Is anything left over?"], a: 12, b: 4, q: 3, left: 2, ask: "14 ladoos among 4 people: how many does each get?", recall: "Remember the Ladoo share? 14 ladoos among 4 people. How many each?" },
      { key: "shop", place: "Market", icon: "🛒", title: "Best buy", item: "🍪", who: "📦", setup: "Next time you're at the shop with a grown-up.", steps: ["Find a pack of 4 biscuits for ₹40.", "Work out the price of one biscuit in the pack.", "A single biscuit costs ₹12. Which is the better deal?"], a: 40, b: 4, q: 10, money: true, ask: "₹40 for 4 biscuits: how much is one?", recall: "Remember Best buy? ₹40 for 4 biscuits. How much is one?" },
      { key: "runrate", place: "Cricket", icon: "🏏", title: "Run rate", item: "🏏", who: "⏱️", setup: "Watch a match with the family.", steps: ["The team needs 48 runs in 8 overs.", "Work out how many runs they need each over.", "Watch the next over: did they get it?"], a: 48, b: 8, q: 6, ask: "48 runs in 8 overs: how many runs per over?", recall: "Remember the Run rate mission? 48 runs in 8 overs. How many per over?" }
    ]
  };
  function missionQn(m) {
    var opts = [m.q], c = shuffle([m.q + 1, m.q - 1, m.q + 2, m.q * 2, m.q + 3]);
    for (var i = 0; i < c.length && opts.length < 4; i++) { if (c[i] > 0 && opts.indexOf(c[i]) < 0) { opts.push(c[i]); } }
    return { a: m.a, b: m.b, q: m.q, text: m.ask, pics: false, options: shuffle(opts), money: !!m.money };
  }
  function missionPicture(m) {
    var cur = m.money ? "₹" : "";
    if (m.money || m.a > 24) { return "<p>" + cur + m.a + " ÷ " + m.b + " = " + cur + m.q + ", because " + m.b + " × " + m.q + " = " + m.a + ".</p>"; }
    var g = '<div class="groups">', n = m.pairs ? m.q : m.b, per = m.pairs ? m.b : m.q;
    for (var i = 0; i < n; i++) { g += '<div class="group pop"><div class="who">' + m.who + "</div>" + rep(m.item, per) + "</div>"; }
    g += "</div>";
    if (m.pairs) { return g + "<p>" + m.a + " socks in pairs of 2 make " + m.q + " pairs. So " + m.a + " ÷ 2 = " + m.q + ".</p>"; }
    if (m.left) { return g.slice(0, -6) + '<div class="group pop"><div class="who">❓</div>' + rep(m.item, m.left) + "</div></div><p>" + m.b + " equal groups of " + m.q + " use " + m.a + ", with " + m.left + " left over. So " + (m.a + m.left) + " ÷ " + m.b + " = " + m.q + " remainder " + m.left + ".</p>"; }
    return g + "<p>" + m.b + " equal groups of " + m.q + " make " + m.a + ". So " + m.a + " ÷ " + m.b + " = " + m.q + ".</p>";
  }
  SCREENS.tryit = function () {
    var list = MISSIONS[state.level === "explorer" ? "explorer" : "starter"];
    function choose() {
      var h = "";
      for (var i = 0; i < list.length; i++) {
        var done = state.missions.indexOf(list[i]) >= 0;
        h += '<button class="tile" data-m="' + i + '"' + (i === 0 ? " data-first" : "") + '><span class="big">' + list[i].icon + "</span>" + esc(list[i].title) + (done ? " ✅" : "") + "<small>" + esc(list[i].place + " · " + list[i].setup) + "</small></button>";
      }
      el(topBar("Try it · real-world missions") + "<p>÷ is everywhere at home. Pick a mission, do it with someone at home, then come back and tell us what you found.</p>" +
        '<div class="grid">' + h + "</div>" +
        '<p class="note">In the real app, missions come from what the teacher taught this week and from your family’s own life (your city, festivals, sports, who’s at home), and a person checks every mission for safety first.</p>');
      wireTop();
      speak("Try it! Division is everywhere at home. Pick a mission.");
      var ts = app.querySelectorAll(".tile");
      for (var j = 0; j < ts.length; j++) { ts[j].onclick = function () { card(list[Number(this.getAttribute("data-m"))]); }; }
    }
    function card(m) {
      var st = "";
      for (var i = 0; i < m.steps.length; i++) { st += "<li>" + esc(m.steps[i]) + "</li>"; }
      el(topBar("Mission · " + m.title) + '<div class="card"><div class="eyebrow">' + esc(m.icon + " " + m.place + " mission") + "</div><h2>" + esc(m.title) + "</h2><p><b>" + esc(m.setup) + "</b></p><ol>" + st + "</ol>" +
        "<p><b>Do it with:</b> a parent, a grandparent, a brother or sister, or on your own.</p>" +
        '<p class="note">Safe by design: no stoves or knives, and never going out alone. No photos or videos of children are needed.</p>' +
        '<div class="row"><button id="did" class="primary" data-first>We did it! Tell BreakNLearn →</button><button id="other" class="soft">Pick another mission</button></div></div>');
      wireTop();
      speak(m.title + ". " + m.setup + " " + m.steps.join(" "));
      on("did", function () { tell(m); });
      on("other", choose);
    }
    function tell(m) {
      var qn = missionQn(m);
      el(topBar("Tell it · " + m.title) + '<div class="panel"><div class="question">' + esc(m.ask) + "</div>" + optionsHtml(qn) + '<div id="fb" class="feedback"></div><div id="more"></div></div>');
      wireTop();
      speak(m.ask);
      wireOptions(qn, function (ok) {
        byId("fb").className = "feedback " + (ok ? "good" : "bad");
        byId("fb").innerHTML = ok ? "⭐ That’s it! You used ÷ in real life." : "Let’s check it together.";
        speak(ok ? "That's it! You used division in real life." : "Let's check it together.");
        var extra = m.left ? "<p><b>" + m.left + " left over!</b> That’s called the <b>remainder</b>. Who should get the last " + m.left + "? Decide as a family.</p>" : "";
        if (m.key === "shop") { extra = "<p>One biscuit in the pack costs ₹10, a single costs ₹12. <b>The pack is the better deal.</b></p>"; }
        byId("more").innerHTML = missionPicture(m) + extra +
          '<div class="row"><span class="chip">Who helped?</span><button class="soft helper">🧑 Parent</button><button class="soft helper">🧓 Grandparent</button><button class="soft helper">🧒 Sibling</button><button class="soft helper">🙋 On my own</button></div>';
        var hs = app.querySelectorAll(".helper");
        for (var i = 0; i < hs.length; i++) { hs[i].onclick = function () { saved(m, this.innerHTML); }; }
        hs[0].focus();
      });
    }
    function saved(m, helper) {
      if (state.missions.indexOf(m) < 0) { state.missions.push(m); }
      el(topBar("Mission complete") + '<div class="panel" style="text-align:center"><div class="factart">🏅</div><h2>' + esc(m.title) + " done · " + helper + "</h2>" +
        "<p>Your mission becomes a question at the next <b>family match night</b>: “" + esc(m.recall) + "”</p>" +
        '<p class="note">This is how we see real understanding: using ÷ in a new place, outside the app. Parents see it in the weekly growth story.</p>' +
        '<div class="row" style="justify-content:center"><button id="more2" class="primary" data-first>Another mission</button><button id="match2">Play match night →</button><button id="hub2" class="soft">Back to modes</button></div></div>');
      wireTop();
      speak("Mission complete! It will be a question at the next family match night.");
      on("more2", choose);
      on("match2", function () { go("match"); });
      on("hub2", function () { go("hub"); });
    }
    choose();
  };

  // ----- Watch (episode + 60-second break) -----
  SCREENS.watch = function () {
    var w = state.world;
    var ep = [
      { art: rep(w.who, 3), text: "It's picnic day in " + w.name + "! Three " + w.whos + " meet under the big tree." },
      { art: rep(w.obj, 12), text: "They open the basket and find twelve " + w.objs + ". \"How do we share them?\" they wonder." },
      { art: w.who + " " + rep(w.obj, 4), text: "One by one, round and round, they share them out. Everyone gets four. What a fair picnic!" }
    ];
    var s = 0;
    function scene() {
      var e = ep[s];
      el(topBar("Watch · Episode 1: The Picnic") + '<div class="scene"><div class="art pop">' + e.art + "</div><p>" + esc(e.text) + '</p></div><div class="bar"><i id="bar"></i></div>' +
        '<div class="row"><button id="skip" class="soft" data-first>Skip scene →</button></div>');
      wireTop();
      speak(e.text);
      later(function () { var b = byId("bar"); if (b) { b.style.width = "100%"; } }, 50);
      on("skip", advance);
      later(advance, 6000);
    }
    function advance() { clearTimers(); s++; if (s < ep.length) { scene(); } else { breakQ(); } }
    function breakQ() {
      var qn = makeQuestion(state.level, 1);
      var left = 60;
      el(topBar("Learning break · 60 seconds") + '<div class="panel"><div class="eyebrow" style="text-align:center">Quick one before the next episode!</div>' +
        (qn.pics ? '<div class="stage">' + rep(w.obj, qn.a) + "</div>" : "") + '<div class="question">' + esc(qn.text) + "</div>" + optionsHtml(qn) +
        '<div id="fb" class="feedback"></div><div id="more"></div><p class="hint">Picked from what’s due for review today. <span id="left">60</span>s left · <button id="skipq" class="ghost">Skip</button></p></div>');
      wireTop();
      speak("Quick one before the next episode! " + qn.text);
      var tick = setInterval(function () { left--; var l = byId("left"); if (l) { l.innerHTML = String(left); } if (left <= 0) { nextEp(); } }, 1000);
      timers.push(tick);
      on("skipq", nextEp);
      wireOptions(qn, function (ok) {
        clearTimers();
        byId("fb").className = "feedback " + (ok ? "good" : "bad");
        byId("fb").innerHTML = ok ? "⭐ Yes! Back to the show…" : "Nearly! Here’s how:";
        speak(ok ? "Yes! Back to the show." : "Nearly! Here's how.");
        byId("more").innerHTML = (ok ? "" : showMe(qn)) + '<div class="row"><button id="cont" class="primary">Next episode →</button></div>';
        on("cont", nextEp);
        byId("cont").focus();
      });
    }
    function nextEp() {
      clearTimers();
      var n = 10;
      el(topBar("Up next") + '<div class="scene"><div class="art">🎬</div><p>Episode 2: The Market starts in <span id="n">10</span>…</p></div>' +
        '<div class="row"><button id="hub2" class="primary" data-first>Back to modes</button><button id="again">Watch episode 1 again</button></div>' +
        '<p class="note">Parents choose: a break after every episode, every second one, or off.</p>');
      wireTop();
      var t = setInterval(function () { n--; var x = byId("n"); if (x) { x.innerHTML = String(Math.max(0, n)); } if (n <= 0) { clearTimers(); var pe = app.querySelector(".scene p"); if (pe) { pe.innerHTML = "Episode 2 comes in the full version. This prototype has one episode."; } } }, 1000);
      timers.push(t);
      on("hub2", function () { go("hub"); });
      on("again", function () { go("watch"); });
    }
    scene();
  };

  // ----- Family match night -----
  SCREENS.match = function () {
    var players = [
      { name: "Child", icon: "🧒", level: state.level },
      { name: "Parent", icon: "🧑", level: "grown" },
      { name: "Grandparent", icon: "🧓", level: "grown" }
    ];
    if (DEMO) { players[0].name = LEVELS[state.level].kid; players[1].name = "Appa"; players[2].name = "Paati (from Madurai)"; }
    var target = 15, runs = 0, balls = 0, maxBalls = 12, streak = 0, log = [], predicted = null;
    function intro() {
      el(topBar("Family match night") + '<div class="panel"><h2>Family XI vs Team ' + esc(state.world.icon + " Mascot") + "</h2>" +
        "<p>The mascot team scored <b>" + target + "</b>. Chase it in 2 overs! Everyone bats at their own level.</p>" +
        '<p>✅ Right answer = 1 run · 3 in a row = <b>FOUR</b> · every 4th ball is a bouncer worth <b>SIX</b> · wrong = dot ball, and we replay it with pictures.</p>' +
        '<div class="row"><span class="chip">🧒 Child · ' + LEVELS[state.level].name + '</span><span class="chip">🧑 Parent · grown-up</span><span class="chip">🧓 Grandparent · grown-up</span></div>' +
        '<div class="row"><button id="play" class="primary" data-first>Start the chase 🏏</button></div>' +
        '<p class="note">Prototype: everyone takes turns with the remote. In the real app, parents and grandparents join with their phones by scanning a QR code, even from another city.</p></div>');
      wireTop();
      speak("Family match night! The mascot team scored " + target + ". Can the family chase it in two overs?");
      on("play", ball);
    }
    function board() {
      var b = '<div class="balls">';
      for (var i = 0; i < maxBalls; i++) {
        var r = log[i];
        b += '<div class="ball ' + (r === undefined ? "" : "r" + r) + '">' + (r === undefined ? "" : (r === 0 ? "•" : r)) + "</div>";
        if (i === 5) { b += '<div style="width:16px"></div>'; }
      }
      b += "</div>";
      var need = Math.max(0, target - runs + 1);
      return '<div class="score"><div><b>' + runs + '</b><span>runs</span></div><div><b>' + Math.floor(balls / 6) + "." + (balls % 6) + '</b><span>overs</span></div><div><b>' + target + '</b><span>target</span></div><div><b>' + need + '</b><span>to win</span></div></div>' + b;
    }
    function ball() {
      if (runs > target || balls >= maxBalls) { return finish(); }
      if (balls === 6 && predicted === null) { return predict(); }
      var p = players[balls % players.length];
      var bouncer = (balls + 1) % 4 === 0;
      var mi = p.level !== "grown" && !bouncer ? Math.floor(balls / 3) : -1;
      var mine = []; for (var x = 0; x < state.missions.length; x++) { if (MISSIONS[state.level === "explorer" ? "explorer" : "starter"].indexOf(state.missions[x]) >= 0) { mine.push(state.missions[x]); } }
      var m = mi >= 0 && mi < mine.length ? mine[mi] : null;
      var qn = m ? missionQn(m) : makeQuestion(p.level === "grown" ? "grown" : p.level, bouncer ? 3 : 1 + (balls > 5 ? 1 : 0));
      if (m) { qn.text = m.recall; }
      el(topBar("Match night · ball " + (balls + 1)) + board() + '<div class="panel"><div class="eyebrow" style="text-align:center">' + p.icon + " " + p.name + " on strike" + (bouncer ? " · 🔥 BOUNCER for SIX" : "") + (m ? " · 🧺 from your Try it mission" : "") + "</div>" +
        (qn.pics ? '<div class="stage">' + rep(state.world.obj, qn.a) + "</div>" : "") + '<div class="question">' + esc(qn.text) + "</div>" + optionsHtml(qn) +
        '<div id="fb" class="comment"></div><div id="more"></div></div>');
      wireTop();
      speak(p.name + " on strike. " + (bouncer ? "Bouncer, for six! " : "") + qn.text);
      wireOptions(qn, function (ok) {
        var r = 0, line;
        if (ok) { streak++; r = bouncer ? 6 : (streak >= 3 ? 4 : 1); if (r === 4) { streak = 0; } }
        else { streak = 0; }
        runs += r; log.push(r); balls++;
        line = r === 6 ? pick(["SIX! Out of the stadium!", "Massive SIX! The crowd is on its feet!"]) :
          r === 4 ? pick(["FOUR! Three in a row, that's a boundary!", "Cracking shot for FOUR!"]) :
          r === 1 ? pick(["Neat single.", "Pushed for one.", "Good running, one run."]) :
          pick(["Dot ball. Let's see that again with pictures.", "Beaten! No run, here's the replay."]);
        byId("fb").innerHTML = line;
        speak(line);
        byId("more").innerHTML = (ok ? "" : (m ? missionPicture(m) : showMe(qn))) + '<div class="row" style="justify-content:center"><button id="nb" class="primary">Next ball →</button></div>';
        on("nb", ball);
        byId("nb").focus();
      });
    }
    function predict() {
      el(topBar("Match night · innings break") + board() + '<div class="panel" style="text-align:center"><h2>Prediction time!</h2><p>Will the family hit a boundary (4 or 6) in the next over?</p>' +
        '<div class="row" style="justify-content:center"><button id="yes" class="good" data-first>Yes!</button><button id="no" class="soft">No</button></div></div>');
      wireTop();
      speak("Prediction time! Will the family hit a boundary in the next over?");
      on("yes", function () { predicted = true; ball(); });
      on("no", function () { predicted = false; ball(); });
    }
    function finish() {
      var won = runs > target;
      var hit = false; for (var i = 6; i < log.length; i++) { if (log[i] >= 4) { hit = true; } }
      el(topBar("Match report") + board() + '<div class="panel" style="text-align:center"><div class="factart">' + (won ? "🏆" : "🤝") + "</div><h2>" +
        (won ? "Family XI win! " + runs + " runs." : "So close! " + runs + " runs, the mascot team edges it.") + "</h2>" +
        "<p>Prediction: " + (predicted === hit ? "✅ you called it!" : "❌ not this time.") + " Best moment: " + (log.indexOf(6) >= 0 ? "that SIX!" : log.indexOf(4) >= 0 ? "the boundary!" : "great running between the wickets.") + "</p>" +
        '<p class="note">The match report goes into the parents’ weekly update. Scores stay inside the family: no public leaderboards.</p>' +
        '<div class="row" style="justify-content:center"><button id="again" class="primary" data-first>Rematch</button><button id="hub2">Back to modes</button></div></div>');
      wireTop();
      speak(won ? "Family eleven win! What a match!" : "So close! What a match!");
      on("again", function () { go("match"); });
      on("hub2", function () { go("hub"); });
    }
    intro();
  };

  // ----- School demo: unit header and the PYP "big question" -----
  function unitPills() {
    return '<div class="row" style="margin:4px 0 0"><span class="pill pyp">PYP · ' + esc(UNIT.theme) + '</span><span class="pill pyp">' + esc(UNIT.concepts) + '</span><span class="pill cam">Cambridge Stage 2</span></div>';
  }
  function unitHeader() {
    return '<div class="eyebrow">' + esc(UNIT.school + " · " + UNIT.week + " · approved by " + UNIT.teacher) + "</div><h1>Sharing equally (÷)</h1>" +
      '<div class="row" style="margin:0 0 6px"><span class="pill pyp">PYP · ' + esc(UNIT.theme) + '</span><span class="pill pyp">Key concepts: ' + esc(UNIT.concepts) + '</span><span class="pill cam">' + esc(UNIT.cambridge) + "</span></div>" +
      "<p><b>Central idea:</b> " + esc(UNIT.idea) + "</p>";
  }
  SCREENS.wonder = function () {
    var starter = state.level === "starter";
    var q = starter ?
      { set: "There are 4 rotis for Meera, her brother and Paati. Paati is very hungry after cooking all morning.", opts: ["Share them exactly equally", "Give Paati a bit more", "Ask everyone how hungry they are"] } :
      { set: "A class has 25 pencils for 4 groups. One group has a child who broke their arm and finds thin pencils hard to hold.", opts: ["Equal shares, 6 each, and decide about the extra one", "Give that group the thick pencils first", "Let each group say what it needs, then decide together"] };
    var h = '<div class="options three">';
    for (var i = 0; i < q.opts.length; i++) { h += '<button class="soft opt"' + (i === 0 ? " data-first" : "") + ">" + esc(q.opts[i]) + "</button>"; }
    el(topBar("Big question · Is equal always fair?") + '<div class="panel"><div class="eyebrow">Key concept: Perspective · Learner profile: Principled, Caring</div><div class="fact">' + esc(q.set) + "</div><p>What would you do? There’s no wrong answer. Think about why.</p>" + h + '</div><div id="more"></div></div>');
    wireTop();
    speak("Big question. Is equal always fair? " + q.set + " What would you do?");
    var bs = app.querySelectorAll(".opt");
    for (var j = 0; j < bs.length; j++) {
      bs[j].onclick = function () {
        for (var m = 0; m < bs.length; m++) { bs[m].className = "soft opt"; }
        this.className = "good opt";
        byId("more").innerHTML = '<p>Great thinking. <b>Equal</b> means everyone gets the same. <b>Fair</b> can mean thinking about what each person needs. Both are ways communities organise sharing.</p>' +
          "<p><b>Ask at home:</b> when is equal the fairest way? When is it not?</p>" +
          '<p class="note">Your choice is not marked. It goes into your family’s match night as a “talk about it” question.</p><div class="row"><button id="hub2" class="primary">Back to modes</button></div>';
        speak("Great thinking. Equal means everyone gets the same. Fair can mean thinking about what each person needs.");
        on("hub2", function () { go("hub"); });
        byId("hub2").focus();
      };
    }
  };

  // ----- Parents -----
  SCREENS.parents = function () {
    var starter = state.level === "starter";
    var doneCount = 0; for (var d = 0; d < state.missions.length; d++) { if (MISSIONS[starter ? "starter" : "explorer"].indexOf(state.missions[d]) >= 0) { doneCount++; } }
    var qs = starter ?
      ["We have 6 rotis and 3 of us. How many does each person get?", "Can you share these 8 grapes equally between you and me?", "If 10 shoes go into pairs, how many pairs?"] :
      ["Dinner costs ₹480 for 4 of us. How much is each share?", "24 stairs in 3 equal flights: how many stairs in each?", "We need 36 sweets in 6 boxes for Diwali. How many per box?"];
    var added = "";
    for (var i = 0; i < state.parentQuestions.length; i++) { added += "<li>" + esc(state.parentQuestions[i]) + " <em>(in the next match night)</em></li>"; }
    el(topBar("For parents") + '<div class="card"><div class="eyebrow">This week at school' + (UNIT ? " · " + esc(UNIT.school + " · " + UNIT.teacher) : "") + '</div><h2>Sharing equally (division)</h2>' +
      (UNIT ? '<p><span class="pill pyp">PYP · ' + esc(UNIT.theme) + '</span><span class="pill pyp">' + esc(UNIT.concepts) + '</span><span class="pill cam">' + esc(UNIT.cambridge) + "</span></p><p><b>Central idea of the unit:</b> " + esc(UNIT.idea) + " This week the class explored how we share equally, and when equal is fair.</p>" : "") +
      "<p><b>In plain words:</b> sharing a number of things into equal groups. 12 ÷ 3 = 4 means 12 shared into 3 equal groups gives 4 in each.</p>" +
      "<p><b>Words the teacher uses:</b> share, equal groups, divide, ÷, each.</p>" +
      "<p><b>How it was explained in class:</b> dealing objects one at a time into groups, then checking with multiplication (3 × 4 = 12).</p>" +
      "<h3>Three questions to ask at dinner</h3><ul>" + "<li>" + esc(qs[0]) + "</li><li>" + esc(qs[1]) + "</li><li>" + esc(qs[2]) + "</li></ul>" +
      "<h3>A 15-minute activity</h3><p><b>Fair-share chef:</b> give your child 12 to 24 small things (beans, buttons, biscuits) and 2 to 4 plates. They deal them out and say the division out loud. Then swap: you deal, they check.</p>" +
      "<h3>This week’s Try it missions</h3><p>" + (starter ? "Roti share (kitchen), Sock pairs (laundry), Diya rows (festival)." : "Ladoo share with leftovers (kitchen), Best buy (shop), Run rate (cricket).") + " About 10 minutes each, done together." + (doneCount ? " <b>Done so far: " + doneCount + ".</b>" : "") + "</p>" +
      "<h3>Add your own question for match night</h3><div class=\"row\"><input id=\"pq\" class=\"text\" placeholder=\"e.g. We bought 15 mangoes for 3 families. How many each?\"></div>" +
      '<div class="row"><button id="add" class="primary">Add question</button><button id="hub2" class="soft" data-first>Back to modes</button></div>' + (added ? "<ul>" + added + "</ul>" : "") +
      '<p class="note">Questions are pitched to ' + (DEMO ? LEVELS[state.level].kid + " (" + LEVELS[state.level].detail.split(":")[0].toLowerCase() + ")" : starter ? "Child A (just starting)" : "Child B (getting it)") + '. In the real app this card arrives every Monday, built from what the teacher taught.' + (DEMO ? ' <a href="/demo/growth">See this week’s growth story →</a>' : "") + "</p></div>");
    wireTop();
    on("hub2", function () { go("hub"); });
    on("add", function () { var v = byId("pq").value.replace(/^\s+|\s+$/g, ""); if (v) { state.parentQuestions.push(v); go("parents"); } });
  };

  // ---------- remote / keyboard navigation ----------
  function focusables() {
    var list = app.querySelectorAll("button:not([disabled]),input");
    var out = [];
    for (var i = 0; i < list.length; i++) { var r = list[i].getBoundingClientRect(); if (r.width > 0 && r.height > 0) { out.push({ el: list[i], r: r }); } }
    return out;
  }
  function move(dir) {
    var cur = document.activeElement;
    var items = focusables();
    if (!items.length) { return; }
    if (!cur || cur === document.body || !app.contains(cur)) { items[0].el.focus(); return; }
    var c = cur.getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2;
    var best = null, bestScore = Infinity;
    for (var i = 0; i < items.length; i++) {
      if (items[i].el === cur) { continue; }
      var r = items[i].r, x = r.left + r.width / 2, y = r.top + r.height / 2, dx = x - cx, dy = y - cy, main, cross;
      if (dir === "left") { main = -dx; cross = Math.abs(dy); }
      else if (dir === "right") { main = dx; cross = Math.abs(dy); }
      else if (dir === "up") { main = -dy; cross = Math.abs(dx); }
      else { main = dy; cross = Math.abs(dx); }
      if (main <= 2) { continue; }
      var score = main + cross * 2;
      if (score < bestScore) { bestScore = score; best = items[i].el; }
    }
    if (best) { best.focus(); if (best.scrollIntoView) { best.scrollIntoView({ block: "nearest" }); } }
  }
  document.addEventListener("keydown", function (e) {
    var k = e.keyCode, typing = document.activeElement && document.activeElement.tagName === "INPUT";
    if (k === 37 && !typing) { move("left"); e.preventDefault(); }
    else if (k === 39 && !typing) { move("right"); e.preventDefault(); }
    else if (k === 38) { move("up"); e.preventDefault(); }
    else if (k === 40) { move("down"); e.preventDefault(); }
    else if (k === 461 || k === 10009 || k === 27 || (k === 8 && !typing)) {
      e.preventDefault();
      if (state.screen === "home") { return; }
      go(state.screen === "hub" ? "home" : "hub");
    }
  });

  if (DEMO) { window.addEventListener("hashchange", function () { if (/family/.test(location.hash)) { state.focusTile = "watch"; go("hub"); } }); }
  if (DEMO && /family/.test(location.hash)) { state.focusTile = "watch"; go("hub"); }
  else { go("home"); }
})();
