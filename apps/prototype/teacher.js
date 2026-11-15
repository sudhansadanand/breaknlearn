/*
 * BreakNLearn school demo: Teacher studio (/demo/teacher).
 * Plan (lesson recording -> transcript -> concept pack -> publish), Teach (smartboard), Review (what I taught), Grow (private coach).
 * Static, ES5, sample content only. No network calls, nothing stored. Children's names never appear on the teacher side.
 */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var timers = [];
  var deleteAt = 0;

  var SECTIONS = ["Lesson plan", "Slides", "Script & anecdotes", "Activities", "Materials", "Homework & projects"];

  var S = {
    view: "plan",
    step: "start",
    file: "",
    audio: "none",
    tab: 0,
    sec: [],
    slideTitles: [{}, {}],
    pres: -1,
    teachSlide: 0,
    mic: true,
    timeLeft: 35 * 60,
    running: false,
    session: 0,
    showTx: false,
    carried: false,
    fb: {}
  };
  for (var si = 0; si < SECTIONS.length; si++) { S.sec.push({ st: "draft", v: 0, edited: false, editing: false, custom: [null, null] }); }

  // ---------- helpers ----------
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function byId(id) { return document.getElementById(id); }
  function on(id, fn) { var b = byId(id); if (b) { b.onclick = fn; } }
  function later(fn, ms) { var t = setTimeout(fn, ms); timers.push(t); return t; }
  function clearTimers() { for (var i = 0; i < timers.length; i++) { clearTimeout(timers[i]); clearInterval(timers[i]); } timers = []; }
  function rep(s, n) { var o = ""; for (var i = 0; i < n; i++) { o += s; } return o; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function approvedCount() { var n = 0; for (var i = 0; i < S.sec.length; i++) { if (S.sec[i].st === "ok") { n++; } } return n; }
  function allApproved() { return approvedCount() === S.sec.length; }

  // ---------- content ----------
  var TAGS = '<span class="pill pyp">PYP · How we organise ourselves</span><span class="pill pyp">Function · Responsibility · Perspective</span><span class="pill cam">Cambridge Primary Maths · Stage 2</span><span class="pill">Week 3 of 6 · Sharing equally (÷)</span>';

  var TX = [
    ["00:00", "Good morning, Grade 2! Close your eyes and imagine our class picnic. Canteen aunty has packed 12 hot rotis, and there are 4 of us on this mat. How do we share them so it's fair?"],
    ["00:41", null],
    ["01:05", "Lovely idea. [name removed] says everyone should get the same number. That's what we call sharing equally."],
    ["02:30", "Let's try it. Take 12 counters and 4 paper plates. Deal them one at a time: one for this plate, one for this plate, one, one…"],
    ["04:10", null],
    ["05:20", "So every plate has 3. We can write it like this: 12 ÷ 4 = 3. This sign is called 'divided by'."],
    ["07:45", "Here's something amazing. Almost 1,400 years ago, in 628 CE, an Indian mathematician called Brahmagupta wrote down rules for dividing numbers."],
    ["09:02", "And this sign, ÷, was first printed for division by Johann Rahn, in a book in 1659. Before that, people wrote division in other ways."],
    ["11:30", "Now a different question. We still have 12 rotis, but this time each plate gets 3. How many plates do we need?"],
    ["13:15", null],
    ["14:40", "Yes, 4 plates! Sharing and grouping are both division. And who remembers 4 times 3? Right, 12. Multiplying and dividing are partners."],
    ["17:05", "Think of the rice shop near your house. The shopkeeper fills a big sack of rice into equal 5-kilo bags. Why do you think the bags must be equal?"],
    ["20:30", "Group time: 'Is it fair?' Each table gets a set of sharing cards. Talk together and decide: fair, or not fair, and why?"],
    ["26:10", null],
    ["29:50", "What if we have 13 rotis and 4 plates? One is left over. What's a fair thing to do with it? [name removed], you thought we could break it into pieces. That's a caring idea."],
    ["33:40", "Tonight's Try-it mission: share something fairly at home with your family, and tomorrow tell me how you did it."]
  ];
  var TX_TUE = [
    ["00:00", "Yesterday we shared rotis. Today we're packing laddoos into boxes, 5 in each box."],
    ["03:20", null],
    ["06:15", "20 laddoos, 5 in a box. Let's count the boxes together: 1, 2, 3, 4. So 20 ÷ 5 = 4."],
    ["14:00", "Let's use our 5 times table to check: 4 × 5 = 20."],
    ["21:40", null],
    ["27:30", "Show me with your fingers: how many boxes for 10 laddoos?"]
  ];
  var TX_WED = [
    ["00:00", "Today's big question: what do we do when things don't share equally?"],
    ["04:30", null],
    ["08:10", "17 crayons for 4 tables. Each table gets 4, and 1 is left over. We call it the remainder."],
    ["15:45", "Is equal always fair? What if one table has more children? Talk with your partner."],
    ["19:20", null],
    ["28:05", "Your groups will start designing 'Our fair-share system' for our classroom."]
  ];

  function txHTML(lines) {
    var h = '<div class="transcript" tabindex="0" aria-label="Transcript">';
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i][1];
      var txt = t === null ? '<span class="gone">[children\'s voices removed]</span>' : esc(t).replace(/\[name removed\]/g, '<span class="gone">[name removed]</span>');
      h += '<p><span class="t mono">' + lines[i][0] + "</span><span>" + txt + "</span></p>";
    }
    return h + "</div>";
  }

  function rotis(n) { return rep('<i class="roti"></i>', n); }
  function plates(each, count, extra) { var h = ""; for (var i = 0; i < count; i++) { h += '<span class="plate">' + rotis(each) + "</span>"; } if (extra) { h += '<span class="left1"><i class="roti"></i></span>'; } return h; }

  var SLIDES = [
    [
      { se: "Week 3 · Sharing equally", t: "Class picnic: 12 rotis, 4 friends", b: '<div class="art">' + rotis(12) + "</div><p>How do we share them so it's <b>fair</b>?</p>" },
      { se: "Line of inquiry 1", t: "What makes a share fair?", b: "<ul><li>Everyone gets the same amount</li><li>Nobody is left out</li><li>We agree on the rule together</li></ul><p><span class=\"tag\">Responsibility</span><span class=\"tag\">Principled</span></p>" },
      { se: "Sharing", t: "Deal them out, one at a time", b: '<div class="art">' + plates(3, 4) + '</div><div class="eq">12 ÷ 4 = 3</div><p>How many on each plate?</p>' },
      { se: "Grouping", t: "3 rotis on every plate", b: '<p>12 rotis. 3 on each plate. How many plates?</p><div class="art">' + plates(3, 4) + '</div><div class="eq">12 ÷ 3 = 4</div>' },
      { se: "÷ and × are partners", t: "4 × 3 = 12, so 12 ÷ 4 = 3", b: '<div class="facts"><span>×2</span><span>×3</span><span>×4</span><span>×5</span><span>×10</span></div><p>Did you know? Brahmagupta wrote rules for division in 628 CE. The ÷ sign was first printed for division by Johann Rahn in 1659.</p><p><span class="tag cam">Cambridge Stage 2</span></p>' },
      { se: "Line of inquiry 3 · Perspective", t: "13 rotis, 4 plates…", b: '<div class="art">' + plates(3, 4, true) + '</div><p>1 is left over. What is the fair thing to do?</p><p><b>Is equal always fair?</b></p>' }
    ],
    [
      { se: "Week 3 · Sharing equally", t: "The community kitchen", b: '<p>Everyone who comes gets an equal plate.</p><div class="art">' + plates(2, 4) + "</div><p>How do the cooks make sure it's fair?</p>" },
      { se: "Line of inquiry 1", t: "Fair means…", b: "<ul><li>Same amount for each person</li><li>Everyone is counted</li><li>The rule is clear before we start</li></ul><p><span class=\"tag\">Function</span><span class=\"tag\">Caring</span></p>" },
      { se: "Sharing", t: "8 rotis shared by 4 people", b: '<div class="art">' + plates(2, 4) + '</div><div class="eq">8 ÷ 4 = 2</div><p>Each person gets 2.</p>' },
      { se: "Grouping", t: "Pack the rice: 5 kg in each bag", b: '<p>A 20 kg sack. 5 kg in each bag. How many bags?</p><div class="eq">20 ÷ 5 = 4</div><p>Shopkeepers do this every day.</p>' },
      { se: "÷ and × are partners", t: "4 × 5 = 20, so 20 ÷ 5 = 4", b: '<div class="facts"><span>×2</span><span>×3</span><span>×4</span><span>×5</span><span>×10</span></div><p>Brahmagupta (628 CE) wrote rules for division. Johann Rahn first printed ÷ for division in 1659.</p><p><span class="tag cam">Cambridge Stage 2</span></p>' },
      { se: "Line of inquiry 3 · Perspective", t: "One left over: what now?", b: '<div class="art">' + plates(3, 4, true) + "</div><p>Who decides? How can everyone agree?</p><p><b>Is equal always fair?</b></p>" }
    ]
  ];
  function slideSet() { return SLIDES[S.sec[1].v]; }
  function slideHTML(i, editable) {
    var s = slideSet()[i], title = S.slideTitles[S.sec[1].v][i] || s.t;
    return '<div class="sl"><div class="slide"' + (editable ? ' contenteditable="true"' : "") + ' data-i="' + i + '"><div class="se">' + esc(s.se) + "</div><h2>" + esc(title) + "</h2>" + s.b + "</div></div>";
  }

  function lessonPlan(v) {
    var hook = v === 0 ? "Class picnic: 12 rotis for 4 friends on a mat. How do we share fairly?" : "A community kitchen where everyone who comes gets an equal plate. How do the cooks make it fair?";
    var rows = v === 0 ?
      [["0–5", "Hook: the picnic rotis (slide 1). Children talk in pairs: what is fair?"], ["5–12", "Sharing with counters and paper plates; record 12 ÷ 4 = 3"], ["12–17", "Story time: Brahmagupta (628 CE) and the ÷ sign (Rahn, 1659)"], ["17–22", "Grouping: 3 on each plate, how many plates? Link to 4 × 3"], ["22–30", "Group inquiry: \"Is it fair?\" sharing cards"], ["30–35", "Leftovers (13 rotis), reflection, set the family Try-it mission"]] :
      [["0–6", "Hook: the community kitchen (slide 1). Think, pair, share"], ["6–14", "Sharing 8 rotis on 4 plates with counters; record 8 ÷ 4 = 2"], ["14–20", "Grouping: the rice shop, 20 kg into 5 kg bags"], ["20–24", "Brahmagupta and the ÷ sign; × and ÷ as partners"], ["24–31", "Group inquiry: \"Is it fair?\" sharing cards"], ["31–35", "One left over: what is fair? Exit thought + Try-it mission"]];
    var t = '<table class="plain"><tbody>';
    for (var i = 0; i < rows.length; i++) { t += "<tr><td>" + rows[i][0] + " min</td><td>" + rows[i][1] + "</td></tr>"; }
    t += "</tbody></table>";
    return "<p><b>Hook:</b> " + hook + "</p>" +
      "<h3>Learning objectives</h3><ul><li>Share a set of up to 20 objects equally and record it with ÷</li><li>Tell sharing (how many each?) from grouping (how many groups?)</li><li>Use multiplication facts for 2, 3, 4, 5 and 10 to check a division</li></ul>" +
      "<h3>Success criteria</h3><ul><li>I can share things so everyone gets the same.</li><li>I can write 12 ÷ 4 = 3 and say what it means.</li><li>I can explain why a share is fair or not fair.</li></ul>" +
      "<h3>35-minute timeline</h3>" + t +
      '<h3>Differentiation</h3><div class="diff"><div><b>Support</b>Real counters and plates, up to 12 objects, sharing between 2 or 4. Sentence starter: "Each one gets…"</div><div><b>Core</b>Up to 20 objects; write the ÷ sentence and its × partner.</div><div><b>Stretch</b>Up to 30 with a leftover; explain a fair decision for the remainder.</div></div>' +
      '<h3>Links</h3><p><span class="pill pyp">Lines of inquiry 1 &amp; 2 (3 previewed)</span><span class="pill pyp">ATL: Thinking, Social</span><span class="pill pyp">Learner profile: Principled, Caring</span><span class="pill cam">Cambridge Stage 2: division as sharing and grouping; × facts 2, 3, 4, 5, 10</span></p>';
  }

  function slidesBody() {
    var h = '<div class="thumbs">';
    for (var i = 0; i < 6; i++) { h += "<div>" + slideHTML(i, S.sec[1].editing) + '<p class="n">Slide ' + (i + 1) + "</p></div>"; }
    h += "</div>";
    if (S.sec[1].editing) { h += '<p class="note">Click any slide title to change it. Press Done when finished.</p>'; }
    return h + '<div class="row"><button id="present" class="primary small-btn">▶ Present on smartboard</button><span class="note">Arrow keys or Next / Prev · Esc to exit</span></div>';
  }

  function scriptBody(v) {
    var talk = v === 0 ?
      '<h3>Teacher talk script</h3><ol><li><b>Open (warm):</b> "Close your eyes and imagine our class picnic. 12 hot rotis, 4 of us. How do we share so it\'s fair?"</li><li><b>Name it:</b> "When everyone gets the same, we call it sharing equally. We write it with ÷, divided by."</li><li><b>Switch to grouping:</b> "Same 12 rotis, but now 3 on each plate. How many plates?"</li><li><b>Big question (Perspective):</b> "Is equal always fair? Can you think of a time when it might not be?"</li><li><b>Close:</b> "Tonight, share something fairly at home and tell me how you decided."</li></ol>' :
      '<h3>Teacher talk script</h3><ol><li><b>Open:</b> "Have you seen a community kitchen? Everyone who comes gets an equal plate. Why do you think they do that?"</li><li><b>Model:</b> "Watch me deal 8 rotis on 4 plates. One, one, one, one… What do you notice?"</li><li><b>Grouping:</b> "The rice shop has a 20 kg sack and 5 kg bags. How many bags will he fill?"</li><li><b>Big question (Perspective):</b> "Is equal always fair? Who might need a different share, and who should decide?"</li><li><b>Close:</b> "Your Try-it mission: be the fair-share helper at home tonight."</li></ol>';
    return talk +
      '<h3>Anecdotes</h3>' +
      '<div class="anec"><p><b>Brahmagupta, 628 CE</b> <span class="verified">✓ Fact-checked</span></p><p>The Indian mathematician Brahmagupta wrote the <i>Brāhmasphuṭasiddhānta</i> in 628 CE. It gives rules for working with numbers, including division, and is one of the earliest texts to treat zero as a number.</p></div>' +
      '<div class="anec"><p><b>The ÷ sign, 1659</b> <span class="verified">✓ Fact-checked</span></p><p>The Swiss mathematician Johann Rahn was the first to print the ÷ sign (the obelus) for division, in his algebra book <i>Teutsche Algebra</i> in 1659.</p></div>' +
      '<div class="anec"><p><b>The rice shop</b> <span class="verified">✓ Everyday example</span></p><p>A shopkeeper splits a big sack of rice into equal bags, say 5 kg each, so every customer pays the same price for the same amount. A 25 kg sack makes 5 bags: 25 ÷ 5 = 5.</p></div>' +
      '<p class="note">Dates checked against published histories of mathematics. Stories are told in your words; nothing about any child is used.</p>';
  }

  function activitiesBody(v) {
    var a1 = v === 0 ?
      '<h3>1 · Picnic plates (sharing) · pairs · 8 min</h3><p>Each pair gets 12 counters ("rotis") and 4 paper plates. Deal one at a time, then write the ÷ sentence. Try again with 2 and 3 plates.</p>' :
      '<h3>1 · Community kitchen (sharing) · pairs · 8 min</h3><p>Pairs serve 8, then 12, then 20 counters onto 4 plates. One child serves, one checks that every plate is equal. Swap roles.</p>';
    var a2 = v === 0 ?
      '<h3>2 · Bag the rice (grouping) · tables · 6 min</h3><p>Each table gets 20 cubes of "rice" and small cups. Fill each cup with 5. How many cups? Repeat with 2 and 10 in a cup. Check with a × fact.</p>' :
      '<h3>2 · Fair-share market (grouping) · tables · 6 min</h3><p>Toy coins: ₹20 to pack into ₹5 pouches. How many pouches? Then ₹30 into ₹10 pouches. Write the ÷ and × partners.</p>';
    return a1 + a2 +
      '<h3>3 · Group inquiry: "Is it fair?" · groups of 4 · 8 min</h3><p>Each group sorts scenario cards into <b>Fair</b> / <b>Not fair</b> / <b>It depends</b>, and must give a reason:</p><ul><li>9 laddoos shared by 3 friends: 3 each.</li><li>The oldest child takes more because they are older.</li><li>10 pencils for 4 children: 2 each, 2 go back in the class box.</li><li>The child who is hungriest gets an extra roti.</li></ul><p>Groups share one "It depends" card with the class. Listen for: equal vs fair, who decides, what to do with leftovers.</p>' +
      '<p><span class="pill pyp">Lines of inquiry 1–3</span><span class="pill pyp">Key concept: Perspective</span><span class="pill pyp">ATL: Social</span><span class="pill cam">Cambridge Stage 2</span></p>';
  }

  function materialsBody(v) {
    var items = v === 0 ?
      ["Counters, 20 per pair (12 pairs)", "Paper plates, 4 per pair (48)", "Small cups or zip bags for grouping, 4 per table", "Linking cubes as \"rice\", 20 per table", "\"Is it fair?\" scenario cards, 6 sets (printable in this pack)", "Chart paper and markers for group posters", "Smartboard slides (in this pack)"] :
      ["Low-prep version: any 20 small classroom items per pair (crayons, blocks, buttons)", "Paper or real plates, 4 per pair", "Toy ₹ coins or cut-out paper coins", "\"Is it fair?\" scenario cards, 6 sets", "Mini whiteboards and pens", "Smartboard slides (in this pack)"];
    var h = '<ul class="checklist">';
    for (var i = 0; i < items.length; i++) { h += '<li><input type="checkbox" id="m' + i + '" aria-label="' + esc(items[i]) + '"><label for="m' + i + '">' + esc(items[i]) + "</label></li>"; }
    return h + '</ul><p class="note">For 24 children in 12 pairs and 6 tables. Tick items as you gather them; nothing is saved.</p>';
  }

  function homeworkBody(v) {
    var mission = v === 0 ?
      "<p><b>Fair share at dinner.</b> Share rotis, fruit or biscuits equally with your family. If one is left over, decide together what is fair, and say why. Tell it in the app or just tell the class tomorrow.</p>" :
      "<p><b>The fair-share helper.</b> Help pack something at home into equal groups (socks into pairs, fruit into bowls of 3). Count the groups and say the ÷ sentence out loud with a grown-up.</p>";
    return "<h3>Family Try-it mission (this week)</h3>" + mission +
      '<p><span class="pill">Each child gets it at their own level</span><span class="pill cam">Cambridge Stage 2</span></p>' +
      '<h3>Mini-project: "Our fair-share system" (weeks 3–4)</h3><p>In groups, children design a system for sharing one class resource fairly, such as reading-corner books, playground balls or art supplies. It must say what to do with leftovers and how the class agrees on the rule. Groups present at the week 4 sharing circle.</p>' +
      '<p><span class="pill pyp">Line of inquiry 3: when things don\'t share equally</span><span class="pill pyp">Key concepts: Function, Responsibility</span><span class="pill pyp">Learner profile: Principled, Caring</span></p>' +
      '<div class="note-box">Children\'s homework and projects are not marked by BreakNLearn. No scores, no rankings, no attendance. You and the families talk about the work; the app only shows whole-class patterns.</div>';
  }

  function sectionBody(i) {
    var s = S.sec[i];
    if (s.custom[s.v] !== null && i !== 1) { return s.custom[s.v]; }
    if (i === 0) { return lessonPlan(s.v); }
    if (i === 1) { return slidesBody(); }
    if (i === 2) { return scriptBody(s.v); }
    if (i === 3) { return activitiesBody(s.v); }
    if (i === 4) { return materialsBody(s.v); }
    return homeworkBody(s.v);
  }
  var SEC_TAGS = [
    '<span class="pill pyp">LOI 1 &amp; 2</span><span class="pill cam">Stage 2 · ÷ as sharing and grouping</span>',
    '<span class="pill">6 slides · smartboard ready</span>',
    '<span class="pill safe">3 anecdotes · fact-checked</span>',
    '<span class="pill pyp">Group inquiry · Perspective</span>',
    '<span class="pill">Checklist</span>',
    '<span class="pill pyp">LOI 3 project</span><span class="pill safe">Not marked</span>'
  ];

  // ---------- frame ----------
  function chip() {
    if (S.audio === "scheduled") { return '<span class="achip" role="timer" aria-live="off"><span class="dot"></span><span class="achipt">' + countdownText() + "</span></span>"; }
    if (S.audio === "deleted") { return '<span class="achip ok" role="status">Audio deleted ✓</span>'; }
    return "";
  }
  function countdownText() {
    var s = Math.max(0, Math.floor((deleteAt - new Date().getTime()) / 1000));
    return "Audio scheduled for deletion: " + Math.floor(s / 3600) + " h " + pad(Math.floor(s / 60) % 60) + " m " + pad(s % 60) + " s";
  }
  function head() {
    var steps = [["plan", "Plan", "lesson → pack"], ["teach", "Teach", "smartboard"], ["review", "Review", "what I taught"], ["grow", "Grow", "private coach"]];
    var h = '<div class="thead"><div><div class="eyebrow">Teacher studio</div><div class="who">Ms Anjali · Grade 2B homeroom · 24 children · Demo Primary School, Chennai</div></div>' + chip() + "</div>";
    h += '<nav class="tsteps" aria-label="Studio steps">';
    for (var i = 0; i < steps.length; i++) {
      var cls = S.view === steps[i][0] ? "on" : (steps[i][0] === "plan" && S.step === "published" ? "done" : "");
      h += '<button data-view="' + steps[i][0] + '" class="' + cls + '"' + (cls === "on" ? ' aria-current="step"' : "") + "><b>" + (i + 1) + "</b>" + steps[i][1] + " <small>· " + steps[i][2] + "</small></button>";
    }
    return h + "</nav>";
  }

  function render(focusId) {
    clearTimers();
    var body;
    if (S.view === "plan") { body = PLAN[S.step](); }
    else if (S.view === "teach") { body = teachView(); }
    else if (S.view === "review") { body = reviewView(); }
    else { body = growView(); }
    app.innerHTML = head() + body + (S.pres >= 0 ? presenterHTML() : "");
    var navs = app.querySelectorAll("[data-view]");
    for (var i = 0; i < navs.length; i++) { navs[i].onclick = navClick; }
    WIRE[S.view === "plan" ? S.step : S.view]();
    if (S.pres >= 0) { wirePresenter(); }
    var f = (focusId && byId(focusId)) || app.querySelector("[data-first]");
    if (f) { try { f.focus({ preventScroll: !!focusId }); } catch (e) { f.focus(); } }
  }
  function navClick() { S.view = this.getAttribute("data-view"); S.showTx = false; render(); window.scrollTo(0, 0); }
  function goStep(step) { S.view = "plan"; S.step = step; render(); window.scrollTo(0, 0); }

  // ---------- plan screens ----------
  function waveHTML() {
    var h = '<div class="wave" aria-hidden="true">', hs = [18, 30, 44, 26, 12, 36, 50, 40, 22, 14, 8, 10, 28, 46, 38, 20, 34, 48, 30, 16, 10, 8, 24, 42, 36, 18, 28, 40, 22, 12];
    for (var i = 0; i < hs.length; i++) { h += '<i class="' + (i % 11 > 8 ? "" : "t") + '" style="height:' + hs[i] + 'px"></i>'; }
    return h + "</div>";
  }
  var RULES = '<div class="callout"><div class="eyebrow">The rules, always on</div><div class="rules"><span>Teacher\'s voice only</span><span>Audio turned into text, then deleted within 24 hours</span><span>Never used to assess any child</span><span>No attendance, no marks</span></div></div>';

  var PLAN = {
    start: function () {
      var fileMsg = S.file ? '<div class="callout"><p><b>Chosen: ' + esc(S.file) + "</b></p><p>In this demo your file never leaves this computer; we'll use the sample transcript.</p></div><button id=\"fileGo\" class=\"primary\" data-first>Continue with the sample →</button>" : "";
      return '<section class="panel"><div class="eyebrow">Plan · Monday lesson</div><h1>Turn this week\'s lesson into a concept pack</h1>' +
        '<p class="lede">Teach as you always do. BreakNLearn turns one lesson into a lesson plan, slides, script, activities, materials and homework. You check and approve every part before anything reaches families.</p>' +
        '<div>' + TAGS + "</div>" +
        '<p style="margin-top:14px"><b>Central idea:</b> Communities create systems to share resources fairly.</p>' +
        '<p class="note">Lines of inquiry: (1) what makes a share fair · (2) how we share equally: division as sharing and grouping · (3) what we do when things don\'t share equally</p></section>' +
        '<div class="cols">' +
        '<div class="card opt"><div><div class="eyebrow">Recommended for this demo</div><h3>Sample lesson recording</h3><p>Ms Anjali · Monday · 35 min · teacher\'s voice only</p>' + waveHTML() + '</div><button id="sample" class="primary"' + (S.file ? "" : " data-first") + '>Use the sample lesson recording →</button></div>' +
        '<div class="card opt"><div><div class="eyebrow">Or</div><h3>Your own audio</h3><p>Any lesson recording from your phone or the class mic (MP3, M4A, WAV).</p></div><div class="filebox"><input type="file" id="file" accept="audio/*"><label for="file">Choose your own audio file</label></div>' + fileMsg + "</div>" +
        "</div>" + RULES;
    },
    processing: function () {
      var steps = [["Uploading (encrypted)", "Sent over an encrypted connection"], ["Keeping the teacher's voice only", "Children's voices removed"], ["Turning speech into text", "35 min of teacher talk"], ["Removing names", "Any name spoken is replaced with [name removed]"], ["Drafting the concept pack", "Plan, slides, script, activities, materials, homework"]];
      var h = '<section class="panel"><div class="eyebrow">Plan · working on it</div><h2>Turning Monday\'s lesson into text</h2><div class="bar"><i id="pbar"></i></div><ol class="proc">';
      for (var i = 0; i < steps.length; i++) { h += '<li id="ps' + i + '"><span class="ic"></span><span>' + esc(steps[i][0]) + "<small>" + esc(steps[i][1]) + "</small></span></li>"; }
      return h + '</ol><div class="row" id="pdone"><button id="skip" class="ghost" data-first>Skip →</button></div></section>' + RULES;
    },
    transcript: function () {
      return '<div class="cols" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">' +
        '<section class="panel"><div class="eyebrow">Plan · cleaned transcript</div><h2>Monday\'s lesson, as text</h2><div class="stats"><span class="chip">35 min</span><span class="chip">Teacher\'s voice only</span><span class="chip">4 stretches of children\'s voices removed</span><span class="chip">2 names removed</span></div>' + txHTML(TX) + "</section>" +
        '<div><section class="panel"><h3>Next: draft the pack</h3><p>BreakNLearn drafts six parts from what you actually taught. Nothing is sent until you approve.</p><button id="draft" class="primary" data-first>Draft the concept pack →</button></section>' +
        '<section class="panel"><h3>The audio</h3><p>The recording is only kept long enough to make this text.</p><div class="row">' + chip() + '</div><button id="delnow" class="ghost"' + (S.audio === "deleted" ? " disabled" : "") + ">" + (S.audio === "deleted" ? "Audio deleted ✓" : "Delete audio now") + "</button></section></div></div>";
    },
    pack: function () {
      var n = approvedCount(), i = S.tab, s = S.sec[i];
      var h = '<section class="panel"><div class="packtop"><div><div class="eyebrow">Plan · concept pack draft</div><h2 style="margin:0">Sharing equally (÷) · your concept pack</h2></div><div><div class="note" style="font-weight:800">' + n + " of 6 approved</div><div class=\"meter\"><i style=\"width:" + Math.round(n / 6 * 100) + '%"></i></div></div><div class="row" style="margin:0"><button id="approveAll" class="good small-btn">Approve all</button><button id="toReview" class="primary small-btn">Review &amp; publish →</button></div></div></section>';
      h += '<div class="packgrid"><div class="tabs" role="tablist" aria-label="Pack sections">';
      for (var k = 0; k < SECTIONS.length; k++) {
        var st = S.sec[k].st === "ok" ? '<span class="st ok">Approved ✓</span>' : '<span class="st">' + (S.sec[k].edited ? "Edited" : "Draft") + "</span>";
        h += '<button role="tab" id="tab' + k + '" data-tab="' + k + '" class="' + (k === i ? "on" : "") + '" aria-selected="' + (k === i) + '">' + (k + 1) + " · " + esc(SECTIONS[k]) + st + "</button>";
      }
      h += "</div>";
      var status = s.st === "ok" ? '<span class="status ok">Approved ✓</span>' : (s.edited ? '<span class="status ed">Edited · draft</span>' : '<span class="status">Draft</span>');
      h += '<article class="card" role="tabpanel"><div class="sechead"><h2>' + esc(SECTIONS[i]) + "</h2>" + status + "</div>" +
        '<p class="note" style="margin:0 0 6px">Version ' + (s.v + 1) + " of 2 · drafted from Monday's transcript</p><div>" + SEC_TAGS[i] + "</div>" +
        '<div class="secbody" id="secbody"' + (s.editing && i !== 1 ? ' contenteditable="true"' : "") + ">" + sectionBody(i) + "</div>" +
        '<div class="secactions">' +
        (s.st === "ok" ? '<button id="approve" class="good" disabled>Approved ✓</button>' : '<button id="approve" class="good" data-first>Approve</button>') +
        '<button id="edit" class="soft">' + (s.editing ? "Done editing" : "Edit") + "</button>" +
        '<button id="regen" class="ghost">↻ Regenerate</button>' +
        (i < 5 ? '<button id="nextSec" class="ghost">Next: ' + esc(SECTIONS[i + 1]) + " →</button>" : "") +
        "</div></article></div>";
      return h;
    },
    review: function () {
      var h = '<section class="card"><div class="eyebrow">Plan · review</div><h2>Ready to send this week\'s concept pack?</h2><ul class="revlist">';
      for (var i = 0; i < SECTIONS.length; i++) {
        h += "<li><span><b>" + (i + 1) + " · " + esc(SECTIONS[i]) + "</b></span>" + (S.sec[i].st === "ok" ? '<span class="status ok">Approved ✓</span>' : '<span class="status">Draft</span>') + "</li>";
      }
      var all = allApproved();
      h += '</ul><p>Families get a Learn, Story, Game, Try-it missions, a TV break and family match night, each at their own child\'s level. No child\'s name, voice or result comes from your lesson.</p><div class="row">' +
        (all ? "" : '<button id="approveAll2" class="good" data-first>Approve all</button>') +
        '<button id="publish" class="primary"' + (all ? " data-first" : " disabled") + ">Publish to families</button>" +
        '<button id="backPack" class="ghost">← Back to the pack</button></div>' +
        (all ? "" : '<p class="note">Approve all six parts to publish.</p>') + "</section>";
      return h;
    },
    published: function () {
      var recv = [["📘", "Learn"], ["📖", "Story"], ["🎮", "Game"], ["🧪", "Try-it missions"], ["📺", "TV break"], ["🏏", "Family match night"]], r = "";
      for (var i = 0; i < recv.length; i++) { r += "<div><span>" + recv[i][0] + "</span>" + recv[i][1] + "</div>"; }
      return '<section class="panel"><div class="big-ok">✓</div><div class="eyebrow" style="margin-top:12px">Published · Week 3 · Sharing equally (÷)</div><h1>Sent as this week\'s concept pack for 24 families.</h1><p>Each child gets it at their own level.</p>' +
        '<div class="recv">' + r + "</div>" +
        '<div class="row"><a class="btn primary" href="/demo/child" data-first>See it as a child →</a><a class="btn soft" href="/demo/growth">See the parent growth story →</a><button id="toTeach" class="ghost">Teach it on the smartboard</button></div>' +
        '<p class="note">You can edit or unpublish any part this week. Families never see the transcript.</p></section>';
    }
  };

  function approve(i) { S.sec[i].st = "ok"; S.sec[i].editing = false; }
  function saveEdit(i) {
    var s = S.sec[i], b = byId("secbody");
    if (i === 1) {
      var sl = b.querySelectorAll(".slide");
      for (var k = 0; k < sl.length; k++) { var h2 = sl[k].querySelector("h2"); if (h2) { S.slideTitles[s.v][k] = h2.textContent; } }
    } else if (b) { s.custom[s.v] = b.innerHTML; }
    s.editing = false;
  }

  var WIRE = {
    start: function () {
      on("sample", function () { S.file = ""; goStep("processing"); });
      on("fileGo", function () { goStep("processing"); });
      var f = byId("file");
      if (f) {
        f.onchange = function () {
          var name = f.files && f.files[0] ? f.files[0].name : "";
          if (name) { S.file = name; render("fileGo"); }
        };
      }
    },
    processing: function () {
      var n = 5, dur = 1100;
      function tick(i) {
        if (i > 0) { byId("ps" + (i - 1)).className = "ok"; byId("ps" + (i - 1)).querySelector(".ic").innerHTML = "✓"; }
        byId("pbar").style.width = Math.round(i / n * 100) + "%";
        if (i === n) {
          startDeletion();
          var d = byId("pdone");
          d.innerHTML = '<button id="seeTx" class="primary">See the transcript →</button>';
          on("seeTx", function () { goStep("transcript"); });
          byId("seeTx").focus();
          var top = app.querySelector(".thead");
          if (top) { top.insertAdjacentHTML("beforeend", chip()); }
          return;
        }
        byId("ps" + i).className = "run";
        later(function () { tick(i + 1); }, dur);
      }
      later(function () { tick(0); }, 250);
      on("skip", function () { startDeletion(); goStep("transcript"); });
    },
    transcript: function () {
      on("draft", function () { goStep("pack"); });
      on("delnow", function () { S.audio = "deleted"; render("delnow"); });
    },
    pack: function () {
      var tabs = app.querySelectorAll("[data-tab]");
      for (var k = 0; k < tabs.length; k++) {
        tabs[k].onclick = function () { if (S.sec[S.tab].editing) { saveEdit(S.tab); } S.tab = +this.getAttribute("data-tab"); render("tab" + S.tab); };
      }
      var i = S.tab, s = S.sec[i];
      on("approve", function () {
        if (s.editing) { saveEdit(i); }
        approve(i);
        var next = -1;
        for (var j = 1; j <= 6; j++) { var c = (i + j) % 6; if (S.sec[c].st !== "ok") { next = c; break; } }
        if (next >= 0) { S.tab = next; render("approve"); cardToTop(); } else { goStep("review"); }
      });
      on("edit", function () {
        if (s.editing) { saveEdit(i); render("edit"); return; }
        s.editing = true; s.edited = true; s.st = "draft"; render("edit");
        var b = i === 1 ? app.querySelector("#secbody .slide h2") : byId("secbody");
        if (b) { b.focus(); }
      });
      on("regen", function () { s.v = 1 - s.v; s.custom[s.v] = null; s.editing = false; s.edited = false; s.st = "draft"; render("regen"); });
      on("nextSec", function () { if (s.editing) { saveEdit(i); } S.tab = i + 1; render("nextSec"); cardToTop(); });
      on("approveAll", function () { if (s.editing) { saveEdit(i); } for (var j = 0; j < 6; j++) { approve(j); } goStep("review"); });
      on("toReview", function () { if (s.editing) { saveEdit(i); } goStep("review"); });
      on("present", function () { S.pres = 0; render(); });
    },
    review: function () {
      on("approveAll2", function () { for (var j = 0; j < 6; j++) { approve(j); } render("publish"); });
      on("publish", function () { goStep("published"); });
      on("backPack", function () { goStep("pack"); });
    },
    published: function () { on("toTeach", function () { S.view = "teach"; render(); window.scrollTo(0, 0); }); },
    teach: wireTeach,
    grow: wireGrow
  };

  function cardToTop() {
    var c = app.querySelector("article.card");
    if (!c) { return; }
    var top = c.getBoundingClientRect().top;
    if (top < 0 || top > window.innerHeight * 0.6) { window.scrollTo(0, Math.max(0, window.pageYOffset + top - 90)); }
  }
  function startDeletion() { if (S.audio === "none") { S.audio = "scheduled"; deleteAt = new Date().getTime() + (24 * 3600 - 1) * 1000; } }

  // ---------- presenter overlay ----------
  function presenterHTML() {
    return '<div class="presenter" role="dialog" aria-modal="true" aria-label="Slide presenter"><div class="bigsl">' + slideHTML(S.pres, false) + '</div><div class="row"><button id="pPrev" class="ghost small-btn">← Prev</button><span class="counter">' + (S.pres + 1) + " / 6</span><button id=\"pNext\" class=\"primary small-btn\" data-first>Next →</button><button id=\"pExit\" class=\"soft small-btn\">Exit (Esc)</button></div></div>";
  }
  function wirePresenter() {
    on("pPrev", function () { presMove(-1); });
    on("pNext", function () { presMove(1); });
    on("pExit", function () { S.pres = -1; render("present"); });
  }
  function presMove(d) { var n = S.pres + d; if (n < 0 || n > 5) { return; } S.pres = n; render(d > 0 ? "pNext" : "pPrev"); }

  // ---------- teach ----------
  var SEGS = [[0, 5, "Hook: picnic rotis"], [5, 12, "Sharing with counters"], [12, 17, "Brahmagupta & the ÷ sign"], [17, 22, "Grouping"], [22, 30, "Is it fair? groups"], [30, 35, "Leftovers + Try-it mission"]];
  function clockText() { return pad(Math.floor(S.timeLeft / 60)) + ":" + pad(S.timeLeft % 60); }
  function segHTML() {
    var el = 35 - S.timeLeft / 60, h = "";
    for (var i = 0; i < SEGS.length; i++) {
      var cls = el >= SEGS[i][1] ? "past" : (el >= SEGS[i][0] ? "now" : "");
      h += '<li class="' + cls + '">' + SEGS[i][0] + "–" + SEGS[i][1] + " · " + esc(SEGS[i][2]) + "</li>";
    }
    return h;
  }
  function teachView() {
    return '<div class="teachgrid"><section><div class="row space" style="margin-top:0"><div><div class="eyebrow">Teach · smartboard mode</div><h2 style="margin:0">Sharing equally (÷)</h2></div><span class="counter" id="tCount">Slide ' + (S.teachSlide + 1) + " / 6</span></div>" +
      '<div id="tSlide">' + slideHTML(S.teachSlide, false) + "</div>" +
      '<div class="row"><button id="tPrev" class="ghost small-btn">← Prev</button><button id="tNext" class="primary small-btn" data-first>Next →</button><button id="tFull" class="soft small-btn">⛶ Present full screen</button><span class="note">← → arrow keys work too</span></div></section>' +
      '<aside class="side"><section class="panel"><button id="mic" class="mic ghost small-btn' + (S.mic ? "" : " off") + '"><span class="rec"></span><span>' + (S.mic ? "Recording: teacher mic only" : "Mic paused · tap to resume") + "</span></button>" +
      '<p class="note" style="margin-top:10px">Children\'s voices are filtered out before anything is saved.</p></section>' +
      '<section class="panel"><div class="eyebrow">Class timer · 35 min</div><div class="clock" id="clock">' + clockText() + '</div><div class="row" style="margin:6px 0"><button id="tStart" class="good small-btn">' + (S.running ? "❚❚ Pause" : "▶ Start") + '</button><button id="tReset" class="ghost small-btn">Reset</button></div><ol class="seg" id="segs">' + segHTML() + "</ol></section>" +
      '<div class="callout"><b>No attendance. No scores.</b> Teach mode never marks, ranks or records any child.</div></aside></div>';
  }
  function teachMove(d) {
    var n = S.teachSlide + d; if (n < 0 || n > 5) { return; }
    S.teachSlide = n; byId("tSlide").innerHTML = slideHTML(n, false); byId("tCount").innerHTML = "Slide " + (n + 1) + " / 6";
  }
  function wireTeach() {
    on("tPrev", function () { teachMove(-1); });
    on("tNext", function () { teachMove(1); });
    on("tFull", function () { S.pres = S.teachSlide; render(); });
    on("mic", function () {
      S.mic = !S.mic; var b = byId("mic");
      b.className = "mic ghost small-btn" + (S.mic ? "" : " off");
      b.innerHTML = '<span class="rec"></span><span>' + (S.mic ? "Recording: teacher mic only" : "Mic paused · tap to resume") + "</span>";
    });
    on("tStart", function () {
      S.running = !S.running;
      byId("tStart").innerHTML = S.running ? "❚❚ Pause" : "▶ Start";
    });
    on("tReset", function () { S.timeLeft = 35 * 60; S.running = false; byId("tStart").innerHTML = "▶ Start"; paintClock(); });
  }

  // ---------- review ----------
  var SESSIONS = [
    { d: "Mon", t: "Sharing equally (÷)", m: 35, tx: TX, cov: [
      ["y", "Share a set equally and record with ÷", "Taught at 02:30–05:20 with counters and plates"],
      ["y", "Tell sharing from grouping", "Grouping question at 11:30; named at 14:40"],
      ["p", "Check division with × facts for 2, 3, 4, 5, 10", "Only 4 × 3 came up (14:40). Try the 5s and 10s on Tuesday"],
      ["y", "Anecdotes: Brahmagupta and the ÷ sign", "07:45 and 09:02"],
      ["y", "Group inquiry: \"Is it fair?\"", "20:30–26:10"],
      ["n", "Perspective question: \"Is equal always fair?\"", "Planned for the close but not reached"],
      ["y", "Set the family Try-it mission", "33:40"]] },
    { d: "Tue", t: "Grouping: laddoo boxes", m: 30, tx: TX_TUE, cov: [
      ["y", "Grouping in 5s with a ÷ sentence", "06:15"], ["y", "Check with the 5 times table", "14:00"], ["p", "Grouping in 2s and 10s", "Only 10 ÷ 5 at 27:30"]] },
    { d: "Wed", t: "Leftovers & fair decisions", m: 32, tx: TX_WED, cov: [
      ["y", "Name a remainder (\"left over\")", "08:10"], ["y", "Perspective: \"Is equal always fair?\"", "15:45 — carried forward from Monday"], ["y", "Launch the \"Our fair-share system\" project", "28:05"]] }
  ];
  function reviewView() {
    var se = SESSIONS[S.session], h = '<section class="panel"><div class="eyebrow">Review · this week</div><h2>What I taught vs what I planned</h2><p class="lede">About your teaching, not about any child. Pick a lesson.</p><div class="sess">';
    for (var i = 0; i < SESSIONS.length; i++) {
      h += '<button id="ses' + i + '" data-ses="' + i + '" class="' + (i === S.session ? "on" : "") + '"' + (i === 0 ? " data-first" : "") + "><span>" + SESSIONS[i].d + " · " + esc(SESSIONS[i].t) + "</span><small>" + SESSIONS[i].m + " min · transcript ready · audio " + (i === 0 && S.audio === "scheduled" ? "deletes within 24 h" : "deleted ✓") + "</small></button>";
    }
    h += "</div></section>";
    var y = 0; for (var k = 0; k < se.cov.length; k++) { if (se.cov[k][0] === "y") { y++; } }
    h += '<div class="cols" style="grid-template-columns:minmax(0,1.2fr) minmax(0,1fr)"><section class="card"><div class="sechead"><h3 style="margin:0">' + se.d + " · coverage of lesson objectives</h3><span class=\"status ok\">" + y + " of " + se.cov.length + ' fully covered</span></div><ul class="cov">';
    for (var c = 0; c < se.cov.length; c++) {
      var m = se.cov[c][0];
      h += '<li><span class="m ' + m + '">' + (m === "y" ? "✓" : m === "p" ? "½" : "–") + "</span><span><b>" + esc(se.cov[c][1]) + "</b><small>" + esc(se.cov[c][2]) + "</small></span></li>";
    }
    h += "</ul>";
    if (S.session === 0) { h += '<div class="row"><button id="carry" class="good small-btn"' + (S.carried ? " disabled" : "") + ">" + (S.carried ? "Added to Wednesday's plan ✓" : "Carry \"Is equal always fair?\" forward") + "</button></div>"; }
    h += '<p class="note">Times come from your transcript. Nothing here is shared with families or leadership.</p></section>';
    h += '<section class="panel"><h3>Transcript</h3><p>Cleaned, teacher\'s voice only, names removed.</p><button id="txBtn" class="soft small-btn">' + (S.showTx ? "Hide transcript" : "Open " + se.d + "'s transcript") + "</button>" + (S.showTx ? txHTML(se.tx) : "") +
      '<div class="callout"><b>What stuck, what\'s slipping?</b><br>See whole-class patterns only, never single children.</div><a class="btn primary" href="/demo/class">Open class view →</a></section></div>';
    return h;
  }
  WIRE.review = (function (planReview) {
    return function () {
      if (S.view === "plan") { planReview(); return; }
      var b = app.querySelectorAll("[data-ses]");
      for (var i = 0; i < b.length; i++) { b[i].onclick = function () { S.session = +this.getAttribute("data-ses"); render("ses" + S.session); }; }
      on("txBtn", function () { S.showTx = !S.showTx; render("txBtn"); });
      on("carry", function () { S.carried = true; render("carry"); });
    };
  })(WIRE.review);

  // ---------- grow ----------
  var COACH = [
    { id: "talk", e: "🗣", h: "Talk-time balance", b: '<p>You were talking about <b>62%</b> of the lesson. For a Grade 2 inquiry lesson, around 50% leaves more room for children\'s thinking.</p><div class="split"><i class="a" style="width:62%">Your voice 62%</i><i class="b" style="width:38%">Class 38%</i></div><p class="note">Measured only from how long your voice was heard. What children said is never kept.</p>' },
    { id: "wait", e: "⏳", h: "Wait time after questions", b: '<p>After your big questions you waited about <b>2 seconds</b> before taking an answer. Try <b>5 seconds</b>. At 11:30 ("How many plates do we need?") a longer pause would let more hands go up.</p>' },
    { id: "hook", e: "🌟", h: "What worked: the roti hook", b: "<p>The class picnic was a great hook. The class joined in within 40 seconds, and you came back to the rotis three times to connect sharing, grouping and leftovers. That thread made the lesson hang together.</p>" },
    { id: "open", e: "🔍", h: "One open question for Perspective", b: '<p>Your plan had <b>"Is equal always fair?"</b> for the close, but time ran out. Moving it to just after the "Is it fair?" groups (around 26 min) would bring in the key concept of Perspective while the debate is still warm.</p>' }
  ];
  function growView() {
    var h = '<div class="privacy-band"><span>🔒 Private coach · only you can see this</span><span class="note" style="color:#d9f3e8">Never about individual children. Never shared with school leadership or used in appraisal.</span></div>' +
      '<section class="panel"><div class="eyebrow">Grow · from Monday\'s lesson</div><h2>Four kind, specific notes from your own talk</h2><p class="lede">Drawn only from your voice in the transcript. Take what helps, skip what doesn\'t.</p></section><div class="cols">';
    for (var i = 0; i < COACH.length; i++) {
      var c = COACH[i], fb = S.fb[c.id];
      h += '<article class="card coach"><h3><span>' + c.e + "</span>" + esc(c.h) + "</h3>" + c.b + '<div class="fb">' +
        (fb ? '<span class="thanks">' + (fb === "ok" ? "✓ Thanks. Noted for next week." : "Thanks. We'll show fewer notes like this.") + "</span>" :
          '<button class="good small-btn" id="fbok' + i + '" data-fb="' + i + '" data-v="ok"' + (i === 0 ? " data-first" : "") + '>Got it</button><button class="ghost small-btn" id="fbno' + i + '" data-fb="' + i + '" data-v="no">Not useful</button>') +
        "</div></article>";
    }
    h += '</div><section class="card goal" style="margin-top:18px"><div class="eyebrow" style="color:#5a2d00">Your micro-goal for next week</div><h3>After every big question, silently count to five before taking answers.</h3><p>Just one habit. Next week\'s note will tell you how your wait time changed.</p></section>';
    return h;
  }
  function wireGrow() {
    var b = app.querySelectorAll("[data-fb]");
    for (var i = 0; i < b.length; i++) {
      b[i].onclick = function () { var k = +this.getAttribute("data-fb"); S.fb[COACH[k].id] = this.getAttribute("data-v"); var nx = byId("fbok" + (k + 1)); render(nx ? "fbok" + (k + 1) : null); };
    }
  }

  function paintClock() { var c = byId("clock"), g = byId("segs"); if (c) { c.innerHTML = clockText(); } if (g) { g.innerHTML = segHTML(); } }

  // ---------- global ----------
  setInterval(function () {
    if (S.running) { if (S.timeLeft > 0) { S.timeLeft--; } else { S.running = false; } paintClock(); }
    if (S.audio !== "scheduled") { return; }
    var t = countdownText(), a = app.querySelectorAll(".achipt");
    for (var i = 0; i < a.length; i++) { a[i].innerHTML = t; }
  }, 1000);

  document.addEventListener("keydown", function (e) {
    var a = document.activeElement, typing = a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable);
    var k = e.keyCode;
    if (S.pres >= 0) {
      if (k === 37 || k === 33) { presMove(-1); e.preventDefault(); }
      else if (k === 39 || k === 34 || k === 32) { presMove(1); e.preventDefault(); }
      else if (k === 27 || k === 461 || k === 10009) { S.pres = -1; render(S.view === "teach" ? "tFull" : "present"); e.preventDefault(); }
      return;
    }
    if (S.view === "teach" && !typing) {
      if (k === 37 || k === 33) { teachMove(-1); e.preventDefault(); }
      else if (k === 39 || k === 34) { teachMove(1); e.preventDefault(); }
    }
  });

  render();
})();
