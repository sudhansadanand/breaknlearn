/* Shared top bar for the school demo. ES5. Usage: <div id="demobar" data-on="teacher"></div> then this script. */
(function () {
  "use strict";
  var bar = document.getElementById("demobar");
  if (!bar) { return; }
  var on = bar.getAttribute("data-on") || "";
  var links = [
    ["start", "/demo", "Start"],
    ["teacher", "/demo/teacher", "1 · Teacher studio"],
    ["child", "/demo/child", "2 · Child's week"],
    ["growth", "/demo/growth", "3 · Parent growth story"],
    ["family", "/demo/child#family", "4 · TV break + match night"],
    ["class", "/demo/class", "5 · Class view"],
    ["privacy", "/demo/privacy", "6 · Privacy"]
  ];
  var h = '<a class="brand" href="/demo">BreakNLearn <span>·</span> Demo Primary School</a><nav aria-label="Demo sections">';
  for (var i = 0; i < links.length; i++) {
    h += '<a href="' + links[i][1] + '"' + (links[i][0] === on ? ' class="on" aria-current="page"' : "") + ">" + links[i][2] + "</a>";
  }
  bar.className = "demobar";
  bar.innerHTML = h + '<a href="#" id="fs" title="Full screen for TV or smartboard">⛶ Full screen</a></nav>';
  var fs = document.getElementById("fs");
  fs.onclick = function (e) {
    e.preventDefault();
    var d = document.documentElement;
    try {
      if (document.fullscreenElement) { document.exitFullscreen(); }
      else if (d.requestFullscreen) { d.requestFullscreen(); }
    } catch (err) { /* optional */ }
  };
})();
