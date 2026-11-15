/*
 * School demo · parent growth story (/demo/growth). Static, ES5, fictional seed data, nothing stored, no network.
 * A warm weekly letter to the Raman family, tailored per child (Meera / Kabir).
 */
(function () {
  "use strict";

  var app = document.getElementById("app");
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function byId(id) { return document.getElementById(id); }

  // steps: 0..4 on the "with pictures -> on her own" scale; now = the step reached this week
  var KIDS = {
    meera: {
      name: "Meera", grade: "Grade 2", level: "Just starting", levelDetail: "small numbers, with pictures", she: "she", her: "her",
      headline: "Meera spent this week sharing things fairly, and she did a lot of it away from the screen. She dealt out rotis at dinner with Paati, paired up the laundry socks on her own, and took four learning breaks during TV time. By Friday she could share up to 12 things with pictures and check her answer with a times fact. Next, she is ready to try sharing without the pictures.",
      explored: [
        ["📘", "Learn", "Dealing one at a time", "Watched the 3-minute lesson twice, then dealt 12 bones to 3 puppies in Animal Farm."],
        ["📖", "Story", "Fact she liked", "The langar kitchen at the Golden Temple, where everyone sits in rows and gets the same meal. She told Appa about it at dinner."],
        ["🎮", "Game", "Fair-share farm", "Played 3 short rounds, carrots shared among 2, 3 and 4 horses."],
        ["📺", "Watch breaks", "4 breaks during TV time", "Short 90-second puzzles between cartoon episodes. She answered every one before the show came back."],
        ["🧺", "Try it", "2 real-world missions", "Roti share, with Paati · Sock pairs, on her own. Diya rows is still waiting for Diwali week."],
        ["🏏", "Match night", "Family XI won by 6 runs", "Paati joined by phone from Madurai and hit a SIX on Meera’s roti question. Everyone cheered."]
      ],
      stuck: [
        ["Sharing up to 12 things equally, with pictures", 3, "She deals one at a time and counts each plate."],
        ["Linking sharing to times facts: 12 ÷ 3 = 4 because 3 × 4 = 12", 2, "She checked 2 answers this way without being asked."],
        ["Pairs: 10 socks make 5 pairs", 3, "Learned from the laundry, used again at match night."]
      ],
      growing: [
        ["Sharing without pictures", 1, "She still likes to draw or hold things first. That is exactly right for now."],
        ["What to do with leftovers", 1, "When 7 sweets go to 3 people, she wants to give the extra one to someone."]
      ],
      tip: "Try it at snack time: give her 7 biscuits and 3 plates, and ask “Is it fair? What could we do with the one left over?” There is no wrong answer. Talking about it is the learning.",
      review: [
        ["Doubling", "Week 1", ["ok", "ok", "due", ""], "Day 14 check-in due Thursday, inside a Watch break."],
        ["Equal groups", "Week 2", ["ok", "due", "", ""], "Day 7 check-in due Tuesday."],
        ["Sharing equally (÷)", "This week", ["", "", "", ""], "First check-in starts on day 3, next Wednesday."]
      ],
      inquirer: "At dinner there were 7 rotis for 3 plates. After dealing 2 each, Meera looked at the last roti and said it should go to Paati “because she cooked them all.”",
      inquirerTags: ["Principled", "Caring"],
      inquirerWhy: "She noticed the share was not equal, and chose a fair reason for the extra one. That is the unit’s central idea in her own words: communities create systems to share resources fairly.",
      dinner: ["We have 6 rotis and 3 of us. How many does each person get?", "Can you share these 8 grapes equally between you and me?", "If 10 shoes go into pairs, how many pairs?"],
      activity: "<b>Fair-share chef:</b> give Meera 12 small things (beans, buttons, biscuits) and 3 plates. She deals them out and says the division out loud. Then swap: you deal, she checks."
    },
    kabir: {
      name: "Kabir", grade: "Grade 4", level: "Getting it", levelDetail: "remainders, money and word problems", she: "he", her: "his",
      headline: "Kabir took division into the real world this week. He shared 14 ladoos among 4 people and worked out what to do with the 2 left over, then sat with Appa during the cricket and calculated the run rate the team needed each over. He is confident with remainders now. The next step is deciding what a remainder means in a story: round up, round down, or share it.",
      explored: [
        ["📘", "Learn", "Remainders", "Watched the lesson on “what’s left over” and solved the warm-up in one go."],
        ["📖", "Story", "Fact he liked", "A cricket over has 6 balls, so 48 runs in 8 overs means 6 runs every over: a run a ball."],
        ["🎮", "Game", "Run-chase challenge", "Played the word-problem chase twice and set his own best time."],
        ["📺", "Watch breaks", "3 breaks during TV time", "Money puzzles between episodes, such as ₹60 shared among 4 friends."],
        ["🧺", "Try it", "2 real-world missions", "Ladoo share with leftovers, with Amma · Run rate, with Appa during the match."],
        ["🏏", "Match night", "Family XI won by 6 runs", "Kabir set the field for Paati, who joined by phone from Madurai and hit a SIX."]
      ],
      stuck: [
        ["Dividing with remainders: 14 ÷ 4 = 3, 2 left over", 3, "He writes the remainder clearly and explains it."],
        ["Division in money: ₹480 for 4 people is ₹120 each", 3, "Worked it out for the family dinner bill."],
        ["Run rate: 48 runs in 8 overs is 6 an over", 4, "Did it in his head, then checked it with Appa."]
      ],
      growing: [
        ["What the remainder means in a story", 2, "14 people need autos that seat 4. He said 3 autos, but 2 people would be left on the road."],
        ["Writing his own word problems", 1, "He can solve them. Making one up is the next stretch."]
      ],
      tip: "Ask him one “left-over” question this week: “14 of us are going to the temple and an auto takes 4. How many autos do we need?” Let him explain why the answer is 4, not 3.",
      review: [
        ["Multiplying by 10s and 100s", "Week 1", ["ok", "ok", "ok", "due"], "Day 30 check-in due next Monday."],
        ["Factors and multiples", "Week 2", ["ok", "ok", "", ""], "Day 14 check-in in 6 days."],
        ["Division with remainders", "This week", ["", "", "", ""], "First check-in starts on day 3, next Wednesday."]
      ],
      inquirer: "With 2 ladoos left over, Kabir suggested cutting them in half so all 4 people got 3 and a half, and then saved his half for Meera, “because she shared her rotis with Paati.”",
      inquirerTags: ["Principled", "Caring"],
      inquirerWhy: "He found a fair system for the leftovers, then thought about someone else. That is the unit’s central idea in action: communities create systems to share resources fairly.",
      dinner: ["Dinner costs ₹480 for 4 of us. How much is each share?", "24 stairs in 3 equal flights: how many stairs in each?", "We need 36 sweets in 6 boxes for Diwali. How many per box?"],
      activity: "<b>Left-over detective:</b> give Kabir 20 to 30 small things and ask him to share them among 3, then 4, then 6 people. For each one he decides: is there a remainder, and what is the fairest thing to do with it?"
    }
  };

  var state = { kid: "meera" };

  function dots(n, total) {
    var h = '<span class="d" aria-hidden="true">';
    for (var i = 0; i < total; i++) { h += "<i" + (i < n ? ' class="on"' : i === n ? ' class="now"' : "") + "></i>"; }
    return h + "</span>";
  }
  function confRow(step, k) {
    var labels = ["Just met it", "With pictures", "With a little help", "On " + k.her + " own", "Can explain it"];
    var s = Math.max(0, Math.min(step, 4));
    return '<div class="conf" role="img" aria-label="Confidence: ' + esc(labels[s]) + '" title="' + esc(labels[s]) + '"><span class="lab">With pictures</span>' + dots(s, 5) + '<span class="lab">On ' + esc(k.her) + " own</span></div>";
  }
  function growList(items, k) {
    var h = '<ul class="list">';
    for (var i = 0; i < items.length; i++) {
      h += '<li><div class="what">' + esc(items[i][0]) + "<small>" + esc(items[i][2]) + "</small>" + confRow(items[i][1], k) + "</div></li>";
    }
    return h + "</ul>";
  }
  function ladder(steps) {
    var days = [3, 7, 14, 30], h = '<div class="ladder">';
    for (var i = 0; i < 4; i++) {
      var st = steps[i], txt = st === "ok" ? "✓ got it" : st === "due" ? "next up" : "later";
      h += '<span class="' + st + '"><b>Day ' + days[i] + "</b>" + txt + "</span>";
    }
    return h + "</div>";
  }

  function render() {
    var k = KIDS[state.kid], i;
    var h = '<div class="ins-head"><div><div class="eyebrow">Parent view · weekly growth story · Week 3 of 6</div>' +
      "<h1>" + esc(k.name) + "’s week</h1>" +
      '<p class="note">The Raman family · Demo Primary School, Chennai (fictional) · ' + esc(k.grade) + "</p></div>" +
      '<div class="row noprint" style="margin:0"><div class="seg" role="group" aria-label="Choose child">' +
      '<button id="k-meera" aria-pressed="' + (state.kid === "meera") + '">👧 Meera · Grade 2</button>' +
      '<button id="k-kabir" aria-pressed="' + (state.kid === "kabir") + '">👦 Kabir · Grade 4</button></div>' +
      '<button id="print" class="soft sm">⬇ Download / Print</button></div></div>';

    // headline letter
    h += '<div class="card"><div class="row space" style="margin-top:0"><div class="eyebrow" style="margin:0">This week: Sharing equally (÷)</div>' +
      '<div><span class="pill pyp">PYP · How we organise ourselves</span><span class="pill cam">Cambridge Maths Stage ' + (state.kid === "meera" ? "2" : "4") + "</span></div></div>" +
      '<p class="lede">' + esc(k.headline) + "</p>" +
      '<p class="note">Tailored for ' + esc(k.name) + ": " + esc(k.level) + " · " + esc(k.levelDetail) + ". Same concept as the class, pitched to " + esc(k.her) + " level.</p></div>";

    // explored
    h += '<div class="card sec"><h3>🔭 What ' + esc(k.she) + " explored</h3><div class=\"tiles\">";
    for (i = 0; i < k.explored.length; i++) {
      var e = k.explored[i];
      h += '<div class="mini"><div class="ico" aria-hidden="true">' + e[0] + '</div><span class="tag">' + esc(e[1]) + "</span><h4>" + esc(e[2]) + "</h4><p>" + esc(e[3]) + "</p></div>";
    }
    h += "</div></div>";

    // stuck / growing
    h += '<div class="cols sec"><div class="card"><h3>🌱 What stuck</h3>' + growList(k.stuck, k) + "</div>" +
      '<div class="card"><h3>🌿 Still growing</h3>' + growList(k.growing, k) +
      '<div class="callout"><p><b>A gentle tip:</b> ' + esc(k.tip) + "</p></div></div></div>";

    // review ladder
    h += '<div class="card sec"><h3>🧠 Remembering over time</h3>' +
      "<p>Learning that lasts comes back again and again. BreakNLearn brings each earlier idea back as a quick, playful check-in after 3, 7, 14 and 30 days. It is about memory over time, not marks.</p>" +
      '<div class="tiles">';
    for (i = 0; i < k.review.length; i++) {
      var r = k.review[i];
      h += '<div class="mini"><span class="tag">' + esc(r[1]) + "</span><h4>" + esc(r[0]) + "</h4>" + ladder(r[2]) + '<p style="margin-top:8px">' + esc(r[3]) + "</p></div>";
    }
    h += '</div><p class="note" style="margin-top:12px">A check-in is 5 quick questions inside a game or a Watch break. When most of them come back easily, the next check-in moves further out. If an idea is fading, it simply comes back sooner.</p></div>';

    // inquirer
    h += '<div class="card sec"><div class="row space" style="margin-top:0"><h3 style="margin:0">💡 Thinking like an inquirer</h3><div>';
    for (i = 0; i < k.inquirerTags.length; i++) { h += '<span class="pill pyp">Learner profile · ' + esc(k.inquirerTags[i]) + "</span>"; }
    h += '</div></div><p class="lede" style="font-style:italic">' + esc(k.inquirer) + "</p><p>" + esc(k.inquirerWhy) + "</p>" +
      '<p class="note">From the ' + (state.kid === "meera" ? "Roti share" : "Ladoo share") + " Try it mission, as told by the family when they marked it done.</p></div>";

    // family card
    h += '<div class="card sec" id="family"><div class="row space" style="margin-top:0"><div><div class="eyebrow">This week at school</div><h3 style="margin:0">Sharing equally (division)</h3></div>' +
      '<button id="print2" class="primary sm noprint">⬇ Download / Print</button></div>' +
      '<div class="cols" style="margin-top:12px"><div>' +
      "<p><b>In plain words:</b> sharing a number of things into equal groups. 12 ÷ 3 = 4 means 12 shared into 3 equal groups gives 4 in each.</p>" +
      "<p><b>Words Ms Anjali uses:</b> share, equal groups, divide, ÷, each" + (state.kid === "kabir" ? ", remainder, left over" : "") + ".</p>" +
      "<p><b>How it was explained in class:</b> dealing objects one at a time into groups, then checking with multiplication (3 × 4 = 12).</p></div>" +
      "<div><h4>Three questions to ask at dinner</h4><ol>";
    for (i = 0; i < k.dinner.length; i++) { h += "<li>" + esc(k.dinner[i]) + "</li>"; }
    h += "</ol><h4>A 15-minute activity</h4><p>" + k.activity + "</p></div></div></div>";

    h += '<div class="foot"><span class="pill safe">🔒 Only your family sees this. No rankings, no comparison with other children, no ads.</span>' +
      '<p class="note">Fictional demo family and school. In the real app this story arrives every Friday evening, built from ' + esc(k.her) + ' own week.</p></div>';

    app.innerHTML = h;
    byId("k-meera").onclick = function () { pick("meera"); };
    byId("k-kabir").onclick = function () { pick("kabir"); };
    byId("print").onclick = byId("print2").onclick = function () { try { window.print(); } catch (err) { /* optional */ } };
  }

  function pick(kid) {
    if (state.kid === kid) { return; }
    state.kid = kid;
    render();
    var b = byId("k-" + kid); if (b) { b.focus(); }
  }

  render();
})();
