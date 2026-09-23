const GOOGLE_CLIENT_ID = "111315652710-jrj6kfrhdiuhldl73bca0idb25b0kb6o.apps.googleusercontent.com";
const GOOGLE_CLIENT_SECRET = "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";
const IMGBB_API_KEY = "ea686671bddfd79acb7b95eb48ecafc2";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Use environment variables if set in Cloudflare, otherwise fallback to constants above
    const googleClientId = env.GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID;
    const googleClientSecret = env.GOOGLE_CLIENT_SECRET || GOOGLE_CLIENT_SECRET;
    const imgbbApiKey = env.IMGBB_API_KEY || IMGBB_API_KEY;

    // ================= COOKIE / SESSION HELPERS =================
    const cookies = Object.fromEntries(
      (request.headers.get("Cookie") || "").split("; ").filter(Boolean).map(c => {
        const idx = c.indexOf("=");
        return [c.slice(0, idx), c.slice(idx + 1)];
      })
    );

    let currentUser = null;
    if (cookies.session_user) {
      try {
        currentUser = JSON.parse(decodeURIComponent(cookies.session_user));
      } catch (e) {}
    }

    const todayStr = new Date().toISOString().slice(0, 10);

    // ================= 1. GOOGLE LOGIN REDIRECT =================
    if (path === "/auth/google") {
      const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${googleClientId}&redirect_uri=${encodeURIComponent(url.origin + "/auth/callback")}&response_type=code&scope=openid%20profile%20email`;
      return Response.redirect(googleAuthUrl, 302);
    }

    // ================= 2. GOOGLE OAUTH CALLBACK =================
    if (path === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) return new Response("Authorization code missing", { status: 400 });

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: googleClientId,
          client_secret: googleClientSecret,
          redirect_uri: url.origin + "/auth/callback",
          grant_type: "authorization_code",
        }),
      });

      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) return new Response("Login failed", { status: 400 });

      const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      const googleUser = await userRes.json();

      const userId = "u_" + googleUser.id;
      const userName = googleUser.name;
      const userAvatar = googleUser.picture;

      await env.DB.prepare(
        `INSERT INTO users (id, google_id, name, avatar, bio, website_url, is_dofollow, last_post_date)
         VALUES (?, ?, ?, ?, '', '', 0, '')
         ON CONFLICT(google_id) DO UPDATE SET name=excluded.name, avatar=excluded.avatar`
      ).bind(userId, googleUser.id, userName, userAvatar).run();

      const userSession = JSON.stringify({ id: userId, name: userName, avatar: userAvatar });
      return new Response(null, {
        status: 302,
        headers: {
          "Location": "/",
          "Set-Cookie": `session_user=${encodeURIComponent(userSession)}; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax`,
        },
      });
    }

    // ================= 3. LOGOUT =================
    if (path === "/auth/logout") {
      return new Response(null, {
        status: 302,
        headers: { "Location": "/", "Set-Cookie": `session_user=; Path=/; Max-Age=0` },
      });
    }

    // ================= 4. GET FEED =================
    if (path === "/api/questions" && request.method === "GET") {
      const offset = parseInt(url.searchParams.get("offset") || "0");
      const { results } = await env.DB.prepare(
        `SELECT q.*, u.name as user_name, u.avatar as user_avatar, u.is_dofollow
         FROM questions q LEFT JOIN users u ON q.user_id = u.id
         ORDER BY q.created_at DESC LIMIT 10 OFFSET ?`
      ).bind(offset).all();
      return Response.json({ questions: results });
    }

    // ================= 5. SUBMIT QUESTION =================
    if (path === "/api/questions" && request.method === "POST") {
      if (!currentUser) {
        return Response.json({ success: false, error: "Please login with Google first" }, { status: 401 });
      }

      try {
        const userRow = await env.DB.prepare(`SELECT last_post_date FROM users WHERE id = ?`).bind(currentUser.id).first();
        if (userRow && userRow.last_post_date === todayStr) {
          return Response.json({ success: false, error: "You already posted today. Try again tomorrow!" }, { status: 429 });
        }

        const { title, body, tags, imgBase64 } = await request.json();
        if (!title || !body) return Response.json({ success: false, error: "Title and body required" }, { status: 400 });

        const wordCount = body.trim().split(/\s+/).length;
        if (wordCount > 300) {
          return Response.json({ success: false, error: "Body must be under 300 words" }, { status: 400 });
        }

        const tagArr = (tags || "").split(",").map(t => t.trim()).filter(Boolean).slice(0, 3);

        let imageUrl = "";
        if (imgBase64 && imgbbApiKey) {
          const formData = new FormData();
          formData.append("image", imgBase64);
          const imgRes = await fetch(`https://api.imgbb.com/1/upload?key=${imgbbApiKey}`, {
            method: "POST",
            body: formData
          });
          const imgData = await imgRes.json();
          if (imgData.success) imageUrl = imgData.data.url;
        }

        const qId = "q_" + Date.now();
        await env.DB.prepare(
          `INSERT INTO questions (id, user_id, title, body, tags, image_url, likes, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))`
        ).bind(qId, currentUser.id, title, body, tagArr.join(","), imageUrl).run();

        await env.DB.prepare(`UPDATE users SET last_post_date = ? WHERE id = ?`).bind(todayStr, currentUser.id).run();

        return Response.json({ success: true, id: qId });
      } catch (e) {
        return Response.json({ success: false, error: e.message }, { status: 500 });
      }
    }

    // ================= 6. DELETE OWN QUESTION =================
    if (path === "/api/questions/delete" && request.method === "POST") {
      if (!currentUser) return Response.json({ error: "Login required" }, { status: 401 });
      const { id } = await request.json();
      await env.DB.prepare(`DELETE FROM questions WHERE id = ? AND user_id = ?`).bind(id, currentUser.id).run();
      return Response.json({ success: true });
    }

    // ================= 7. LIKE QUESTION =================
    if (path === "/api/questions/like" && request.method === "POST") {
      const { id } = await request.json();
      await env.DB.prepare(`UPDATE questions SET likes = likes + 1 WHERE id = ?`).bind(id).run();
      return Response.json({ success: true });
    }

    // ================= 8. ANSWERS =================
    if (path === "/api/answers" && request.method === "GET") {
      const qid = url.searchParams.get("question_id");
      const { results } = await env.DB.prepare(
        `SELECT a.*, u.name as user_name, u.avatar as user_avatar
         FROM answers a LEFT JOIN users u ON a.user_id = u.id
         WHERE a.question_id = ? ORDER BY a.created_at ASC`
      ).bind(qid).all();
      return Response.json({ answers: results });
    }

    if (path === "/api/answers" && request.method === "POST") {
      if (!currentUser) return Response.json({ error: "Login required" }, { status: 401 });
      const { question_id, body } = await request.json();
      const aId = "a_" + Date.now();
      await env.DB.prepare(
        `INSERT INTO answers (id, question_id, user_id, body, created_at) VALUES (?, ?, ?, ?, datetime('now'))`
      ).bind(aId, question_id, currentUser.id, body).run();
      return Response.json({ success: true });
    }

    // ================= 9. FOLLOW / UNFOLLOW =================
    if (path === "/api/follow" && request.method === "POST") {
      if (!currentUser) return Response.json({ error: "Login required" }, { status: 401 });
      const { target_id } = await request.json();
      const existing = await env.DB.prepare(
        `SELECT * FROM follows WHERE follower_id = ? AND following_id = ?`
      ).bind(currentUser.id, target_id).first();

      if (existing) {
        await env.DB.prepare(`DELETE FROM follows WHERE follower_id = ? AND following_id = ?`).bind(currentUser.id, target_id).run();
        return Response.json({ success: true, following: false });
      } else {
        await env.DB.prepare(`INSERT INTO follows (follower_id, following_id) VALUES (?, ?)`).bind(currentUser.id, target_id).run();
        return Response.json({ success: true, following: true });
      }
    }

    // ================= 10. PUBLIC PROFILE =================
    if (path === "/api/profile" && request.method === "GET") {
      const id = url.searchParams.get("id") || (currentUser ? currentUser.id : "");
      const user = await env.DB.prepare(`SELECT id, name, avatar, bio, website_url, is_dofollow FROM users WHERE id = ?`).bind(id).first();
      const followers = await env.DB.prepare(`SELECT COUNT(*) as c FROM follows WHERE following_id = ?`).bind(id).first();
      const myQuestions = await env.DB.prepare(`SELECT * FROM questions WHERE user_id = ? ORDER BY created_at DESC`).bind(id).all();
      let isFollowing = false;
      if (currentUser) {
        const f = await env.DB.prepare(`SELECT * FROM follows WHERE follower_id = ? AND following_id = ?`).bind(currentUser.id, id).first();
        isFollowing = !!f;
      }
      return Response.json({ user, followers_count: followers ? followers.c : 0, questions: myQuestions.results, is_following: isFollowing });
    }

    // ================= 11. EDIT PROFILE =================
    if (path === "/api/profile/update" && request.method === "POST") {
      if (!currentUser) return Response.json({ error: "Login required" }, { status: 401 });
      const { name, bio, website_url } = await request.json();
      const shortBio = (bio || "").slice(0, 100);
      await env.DB.prepare(
        `UPDATE users SET name = ?, bio = ?, website_url = ? WHERE id = ?`
      ).bind(name, shortBio, website_url || "", currentUser.id).run();
      return Response.json({ success: true });
    }

    // ================= 12. AUTOMATED DOFOLLOW VERIFICATION =================
    if (path === "/api/verify-dofollow" && request.method === "POST") {
      if (!currentUser) return Response.json({ error: "Login required" }, { status: 401 });
      try {
        const { website_url } = await request.json();
        const siteRes = await fetch(website_url);
        const siteHtml = await siteRes.text();
        const hasBadge = siteHtml.includes("globaltoolsbox.online") &&
                        /rel\s*=\s*["']?dofollow["']?/i.test(siteHtml);
        if (hasBadge) {
          await env.DB.prepare(`UPDATE users SET is_dofollow = 1 WHERE id = ?`).bind(currentUser.id).run();
        }
        return Response.json({ success: true, verified: hasBadge });
      } catch (e) {
        return Response.json({ success: false, error: "Could not reach that website" }, { status: 400 });
      }
    }

    // ================= 13. FRONTEND UI =================
    if (path === "/" || path === "/index.html") {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Ask Global Tools Box</title>
<script src="https://cdn.tailwindcss.com"></script>
<script>tailwind.config = { darkMode: 'class' }</script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#f4f6f8; }
.dark body { background:#0f1115; }
.tag-pill { background:#e0f2fe; color:#0369a1; padding:3px 10px; border-radius:12px; font-size:12px; display:inline-flex; align-items:center; gap:5px; }
.dark .tag-pill { background:#1e3a5f; color:#7dd3fc; }
.liked { color:#e0245e !important; }
</style>
</head>
<body class="text-slate-900 dark:text-slate-100">

<nav class="sticky top-0 z-40 bg-white dark:bg-slate-800 border-b dark:border-slate-700 px-4 py-2.5 flex items-center justify-between shadow-sm">
<button onclick="showScreen('feed')" class="text-blue-600 text-2xl"><i class="fa-solid fa-house"></i></button>
<button onclick="openModal()" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm px-5 py-2 rounded-full">
<i class="fa-solid fa-plus"></i> Ask
</button>
<div class="flex items-center gap-3">
<button onclick="toggleDarkMode()" class="text-slate-500 dark:text-yellow-300 w-9 h-9 rounded-full hover:bg-slate-100 dark:hover:bg-slate-700">
<i id="dark-icon" class="fa-solid fa-moon"></i>
</button>
<div class="relative">
<button onclick="toggleDropdown()">
<img id="nav-avatar" src="${currentUser ? currentUser.avatar : 'https://via.placeholder.com/40?text=U'}" class="w-9 h-9 rounded-full border-2 border-blue-500 object-cover">
</button>
<div id="dropdown" class="hidden absolute right-0 mt-2 w-44 bg-white dark:bg-slate-800 rounded-xl shadow-xl border dark:border-slate-700 overflow-hidden text-sm">
${currentUser ? `
<button onclick="showScreen('dashboard')" class="w-full text-left px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-700"><i class="fa-solid fa-gauge"></i> Dashboard</button>
<button onclick="showScreen('editprofile')" class="w-full text-left px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-700"><i class="fa-solid fa-user-pen"></i> Edit Profile</button>
<a href="/auth/logout" class="block px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-red-500"><i class="fa-solid fa-right-from-bracket"></i> Logout</a>
` : `<a href="/auth/google" class="block px-4 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-blue-600 font-bold"><i class="fa-brands fa-google"></i> Login with Google</a>`}
</div>
</div>
</div>
</nav>

<div class="max-w-2xl mx-auto mt-4 px-3 pb-16">

<div id="screen-feed">
<div class="bg-white dark:bg-slate-800 p-3 rounded-xl border dark:border-slate-700 mb-4">
<div class="relative">
<i class="fa-solid fa-magnifying-glass absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i>
<input id="search-input" oninput="renderFeed()" placeholder="Search questions..." class="w-full pl-9 pr-3 py-2 rounded-lg border dark:border-slate-600 dark:bg-slate-700 text-sm outline-none">
</div>
</div>
<div id="questions-container" class="space-y-4"></div>
<div id="load-more-wrap" class="text-center py-4 hidden">
<button onclick="loadMore()" class="text-blue-600 text-sm font-bold">Load more</button>
</div>
</div>

<div id="screen-dashboard" class="hidden bg-white dark:bg-slate-800 p-5 rounded-xl border dark:border-slate-700">
<h2 class="font-bold text-lg mb-3">My Dashboard</h2>
<div id="dash-stats" class="text-sm text-slate-500 mb-4"></div>
<div id="dash-questions" class="space-y-3"></div>
</div>

<div id="screen-editprofile" class="hidden bg-white dark:bg-slate-800 p-5 rounded-xl border dark:border-slate-700">
<h2 class="font-bold text-lg mb-3">Edit Profile</h2>
<label class="block text-xs font-bold text-slate-500 mb-1">Name</label>
<input id="edit-name" class="w-full p-2 mb-3 rounded-lg border dark:border-slate-600 dark:bg-slate-700 text-sm">
<label class="block text-xs font-bold text-slate-500 mb-1">Bio (max 100 chars)</label>
<textarea id="edit-bio" maxlength="100" class="w-full p-2 mb-3 rounded-lg border dark:border-slate-600 dark:bg-slate-700 text-sm h-16"></textarea>
<label class="block text-xs font-bold text-slate-500 mb-1">Website URL</label>
<input id="edit-website" class="w-full p-2 mb-3 rounded-lg border dark:border-slate-600 dark:bg-slate-700 text-sm" placeholder="https://yoursite.com">
<button onclick="saveProfile()" class="w-full bg-slate-900 text-white font-bold py-2.5 rounded-xl mb-2">Save</button>
<button onclick="verifyDofollow()" class="w-full bg-blue-600 text-white font-bold py-2.5 rounded-xl text-sm">
<i class="fa-solid fa-shield-halved"></i> Verify DoFollow Badge
</button>
<div class="bg-slate-900 text-green-400 p-3 rounded-lg text-xs font-mono break-all mt-3">
&lt;a href="https://globaltoolsbox.online" rel="dofollow"&gt;Powered by Global Tools Box&lt;/a&gt;
</div>
</div>

</div>

<div id="modal" class="hidden fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
<div class="bg-white dark:bg-slate-800 p-6 rounded-2xl w-full max-w-md">
<h3 class="font-bold text-lg mb-3">Ask a Question</h3>
<input id="qTitle" placeholder="Question Title" class="w-full p-2.5 mb-2 rounded-lg border dark:border-slate-600 dark:bg-slate-700 text-sm">
<textarea id="qBody" oninput="updateWordCount()" placeholder="Describe your question (max 300 words)" class="w-full p-2.5 mb-1 rounded-lg border dark:border-slate-600 dark:bg-slate-700 text-sm h-28"></textarea>
<div class="flex justify-between mb-2">
<button onclick="addLinkPrompt()" class="text-xs text-blue-600 font-bold"><i class="fa-solid fa-link"></i> Add Link</button>
<span id="word-count" class="text-xs text-slate-400">0 / 300 words</span>
</div>
<div id="tag-pills" class="flex flex-wrap gap-1 mb-1"></div>
<input id="tagInput" placeholder="Type a tag and press Enter (max 3)" onkeydown="handleTagKey(event)" class="w-full p-2 mb-2 rounded-lg border dark:border-slate-600 dark:bg-slate-700 text-xs">
<label class="text-xs text-slate-500">Image (16:9 ratio, under 200KB)</label>
<input type="file" id="qImg" accept="image/*" onchange="validateImg(this)" class="w-full text-xs mb-3">
<div class="flex justify-end gap-2">
<button onclick="closeModal()" class="px-4 py-2 bg-slate-200 dark:bg-slate-700 rounded-lg text-sm font-bold">Cancel</button>
<button id="subBtn" onclick="submitQuestion()" class="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-bold">Post</button>
</div>
</div>
</div>

<div id="public-profile-modal" class="hidden fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
<div class="bg-white dark:bg-slate-800 p-6 rounded-2xl w-full max-w-sm text-center">
<img id="pp-avatar" class="w-16 h-16 rounded-full mx-auto mb-2 object-cover">
<h3 id="pp-name" class="font-bold text-lg"></h3>
<p id="pp-bio" class="text-xs text-slate-500 mb-2"></p>
<p id="pp-followers" class="text-xs text-slate-400 mb-3"></p>
<button id="pp-follow-btn" onclick="doFollow()" class="bg-blue-600 text-white text-sm font-bold px-6 py-2 rounded-full mb-2"></button>
<br>
<button onclick="closePublicProfile()" class="text-xs text-slate-400 mt-2">Close</button>
</div>
</div>

<script>
const isLoggedIn = ${currentUser ? "true" : "false"};
const myId = ${currentUser ? `"${currentUser.id}"` : "null"};
let allQuestions = [];
let currentOffset = 0;
let tags = [];
let imgBase64 = "";
let likedIds = JSON.parse(localStorage.getItem("liked_ids") || "[]");
let viewingProfileId = null;

function init() {
  if(localStorage.getItem("dark_mode") === "1") {
    document.documentElement.classList.add("dark");
    document.getElementById("dark-icon").className = "fa-solid fa-sun";
  }
  loadQuestions();
}

function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("dark_mode", isDark ? "1" : "0");
  document.getElementById("dark-icon").className = isDark ? "fa-solid fa-sun" : "fa-solid fa-moon";
}

function toggleDropdown() {
  document.getElementById("dropdown").classList.toggle("hidden");
}
document.addEventListener("click", function(e) {
  const dd = document.getElementById("dropdown");
  if(dd && !e.target.closest("#dropdown") && !e.target.closest("nav button")) dd.classList.add("hidden");
});

function showScreen(name) {
  ["feed","dashboard","editprofile"].forEach(s => document.getElementById("screen-" + s).classList.add("hidden"));
  document.getElementById("screen-" + name).classList.remove("hidden");
  document.getElementById("dropdown").classList.add("hidden");
  if(name === "dashboard") loadDashboard();
  if(name === "editprofile") loadEditProfile();
}

function openModal() {
  if(!isLoggedIn) return alert("Please Login with Google first!");
  tags = []; imgBase64 = "";
  document.getElementById("qTitle").value = "";
  document.getElementById("qBody").value = "";
  document.getElementById("tagInput").value = "";
  renderTagPills();
  updateWordCount();
  document.getElementById("modal").classList.remove("hidden");
}
function closeModal() { document.getElementById("modal").classList.add("hidden"); }

function updateWordCount() {
  const body = document.getElementById("qBody").value.trim();
  const count = body ? body.split(/\s+/).length : 0;
  document.getElementById("word-count").textContent = count + " / 300 words";
}

function addLinkPrompt() {
  const link = prompt("Enter URL:");
  const text = prompt("Enter link text:");
  if(link && text) {
    document.getElementById("qBody").value += \` <a href="\${link}" target="_blank">\${text}</a> \`;
  }
}

function handleTagKey(e) {
  if(e.key === "Enter") {
    e.preventDefault();
    const val = e.target.value.trim();
    if(val && tags.length < 3 && !tags.includes(val)) {
      tags.push(val);
      e.target.value = "";
      renderTagPills();
    }
  }
}
function renderTagPills() {
  document.getElementById("tag-pills").innerHTML = tags.map((t, i) =>
    \`<span class="tag-pill">#\${t} <i class="fa-solid fa-xmark cursor-pointer" onclick="removeTag(\${i})"></i></span>\`
  ).join("");
}
function removeTag(i) { tags.splice(i, 1); renderTagPills(); }

function validateImg(input) {
  const file = input.files[0];
  if(!file) return;
  if(file.size > 200 * 1024) {
    alert("Image must be under 200KB!");
    input.value = "";
    return;
  }
  const img = new Image();
  const reader = new FileReader();
  reader.onload = (e) => {
    img.onload = () => {
      const ratio = img.width / img.height;
      if(Math.abs(ratio - 16/9) > 0.15) {
        alert("Image should be close to 16:9 ratio!");
        input.value = "";
        imgBase64 = "";
        return;
      }
      imgBase64 = e.target.result.split(",")[1];
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function submitQuestion() {
  const title = document.getElementById("qTitle").value;
  const body = document.getElementById("qBody").value;
  if(!title || !body) return alert("Title and body required!");
  const wordCount = body.trim().split(/\s+/).length;
  if(wordCount > 300) return alert("Body must be under 300 words!");

  const subBtn = document.getElementById("subBtn");
  subBtn.disabled = true;
  subBtn.textContent = "Posting...";

  const res = await fetch("/api/questions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, tags: tags.join(","), imgBase64 })
  });
  const result = await res.json();
  subBtn.disabled = false;
  subBtn.textContent = "Post";

  if(result.success) {
    alert("Question posted!");
    closeModal();
    currentOffset = 0;
    loadQuestions();
  } else {
    alert(result.error || "Failed to post.");
  }
}

function timeAgo(dateStr) {
  const seconds = Math.floor((new Date() - new Date(dateStr + "Z")) / 1000);
  if(seconds < 60) return "just now";
  const mins = Math.floor(seconds / 60);
  if(mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if(hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

async function loadQuestions() {
  const res = await fetch("/api/questions?offset=" + currentOffset);
  const data = await res.json();
  const list = data.questions || [];
  if(currentOffset === 0) allQuestions = list;
  else allQuestions = allQuestions.concat(list);

  renderFeed();
  const loadBtnWrap = document.getElementById("load-more-wrap");
  if(list.length === 10) loadBtnWrap.classList.remove("hidden");
  else loadBtnWrap.classList.add("hidden");
}

function loadMore() {
  currentOffset += 10;
  loadQuestions();
}

async function toggleLike(id, btn) {
  if(likedIds.includes(id)) return;
  likedIds.push(id);
  localStorage.setItem("liked_ids", JSON.stringify(likedIds));
  btn.classList.add("liked");
  const span = btn.querySelector(".like-count");
  span.textContent = parseInt(span.textContent || "0") + 1;
  await fetch("/api/questions/like", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id })
  });
}

function sharePost(id) {
  const link = window.location.origin + "/?q=" + id;
  if(navigator.share) { navigator.share({ title: "Check this question", url: link }).catch(()=>{}); }
  else if(navigator.clipboard) { navigator.clipboard.writeText(link); alert("Link copied!"); }
  else { prompt("Copy link:", link); }
}

async function deleteQuestion(id) {
  if(!confirm("Delete this question?")) return;
  await fetch("/api/questions/delete", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id })
  });
  loadDashboard();
}

async function toggleAnswers(id) {
  const box = document.getElementById("answers-box-" + id);
  if(box.classList.contains("hidden")) {
    box.classList.remove("hidden");
    box.innerHTML = "<div class='text-xs text-slate-400 py-2'>Loading...</div>";
    const res = await fetch("/api/answers?question_id=" + id);
    const data = await res.json();
    renderAnswers(id, data.answers || []);
  } else {
    box.classList.add("hidden");
  }
}

function renderAnswers(id, answers) {
  const box = document.getElementById("answers-box-" + id);
  const list = answers.length === 0
    ? '<div class="text-xs text-slate-400 py-1">No answers yet.</div>'
    : answers.map(a => \`
      <div class="flex gap-2 py-2 border-t dark:border-slate-700">
        <img src="\${a.user_avatar || 'https://via.placeholder.com/28'}" class="w-7 h-7 rounded-full object-cover">
        <div><span class="font-bold text-xs">\${a.user_name || 'Anonymous'}</span><p class="text-xs text-slate-600 dark:text-slate-300">\${a.body}</p></div>
      </div>\`).join("");
  box.innerHTML = \`\${list}<div class="flex gap-2 mt-2">
    <input id="ans-in-\${id}" placeholder="Write an answer..." class="flex-1 text-xs p-2 rounded-lg border dark:border-slate-600 dark:bg-slate-700">
    <button onclick="submitAnswer('\${id}')" class="bg-blue-600 text-white text-xs px-3 rounded-lg font-bold">Send</button></div>\`;
}

async function submitAnswer(id) {
  if(!isLoggedIn) return alert("Please login first.");
  const input = document.getElementById("ans-in-" + id);
  const body = input.value.trim();
  if(!body) return;
  await fetch("/api/answers", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question_id: id, body }) });
  input.value = "";
  const res = await fetch("/api/answers?question_id=" + id);
  const data = await res.json();
  renderAnswers(id, data.answers || []);
}

async function openPublicProfile(userId) {
  viewingProfileId = userId;
  const res = await fetch("/api/profile?id=" + userId);
  const data = await res.json();
  document.getElementById("pp-avatar").src = data.user.avatar || 'https://via.placeholder.com/64';
  document.getElementById("pp-name").textContent = data.user.name;
  document.getElementById("pp-bio").textContent = data.user.bio || "No bio yet.";
  document.getElementById("pp-followers").textContent = data.followers_count + " followers" + (data.user.is_dofollow ? " • DoFollow Verified" : "");
  const btn = document.getElementById("pp-follow-btn");
  btn.textContent = data.is_following ? "Unfollow" : "Follow";
  document.getElementById("public-profile-modal").classList.remove("hidden");
}

function closePublicProfile() { document.getElementById("public-profile-modal").classList.add("hidden"); }

async function doFollow() {
  if(!isLoggedIn) return alert("Please login first.");
  const res = await fetch("/api/follow", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target_id: viewingProfileId }) });
  const data = await res.json();
  document.getElementById("pp-follow-btn").textContent = data.following ? "Unfollow" : "Follow";
}

async function loadDashboard() {
  if(!isLoggedIn) return;
  const res = await fetch("/api/profile?id=" + myId);
  const data = await res.json();
  document.getElementById("dash-stats").textContent = data.followers_count + " followers • " + (data.questions ? data.questions.length : 0) + " questions posted";
  document.getElementById("dash-questions").innerHTML = (data.questions && data.questions.length > 0) ? data.questions.map(q => \`
    <div class="border dark:border-slate-700 rounded-lg p-3 flex justify-between items-center">
      <span class="text-sm font-semibold">\${q.title}</span>
      <div class="flex gap-3 text-xs">
        <button onclick="sharePost('\${q.id}')" class="text-blue-600">Share</button>
        <button onclick="deleteQuestion('\${q.id}')" class="text-red-500">Delete</button>
      </div>
    </div>\`).join("") : "<p class='text-sm text-slate-400'>No questions yet.</p>";
}

async function loadEditProfile() {
  if(!isLoggedIn) return;
  const res = await fetch("/api/profile?id=" + myId);
  const data = await res.json();
  document.getElementById("edit-name").value = data.user.name || "";
  document.getElementById("edit-bio").value = data.user.bio || "";
  document.getElementById("edit-website").value = data.user.website_url || "";
}

async function saveProfile() {
  const name = document.getElementById("edit-name").value;
  const bio = document.getElementById("edit-bio").value;
  const website_url = document.getElementById("edit-website").value;
  await fetch("/api/profile/update", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, bio, website_url }) });
  alert("Profile saved!");
}

async function verifyDofollow() {
  const website_url = document.getElementById("edit-website").value;
  if(!website_url) return alert("Enter your website URL first and Save.");
  const res = await fetch("/api/verify-dofollow", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ website_url }) });
  const data = await res.json();
  alert(data.verified ? "Verified! You now have a DoFollow badge." : "Badge not found on your site yet.");
}

function renderFeed() {
  const query = (document.getElementById("search-input").value || "").toLowerCase();
  const container = document.getElementById("questions-container");
  const filtered = allQuestions.filter(q => (q.title||"").toLowerCase().includes(query) || (q.tags||"").toLowerCase().includes(query));
  
  if(filtered.length === 0) {
    container.innerHTML = "<p class='text-center text-slate-400 py-8'>No questions found.</p>";
    return;
  }
  
  container.innerHTML = filtered.map(q => {
    const tagsHtml = q.tags ? q.tags.split(",").filter(Boolean).map(t => \`<span class="tag-pill">#\${t}</span>\`).join(" ") : "";
    const isLiked = likedIds.includes(q.id);
    return \`
    <div class="bg-white dark:bg-slate-800 rounded-xl border dark:border-slate-700 p-5 space-y-2 shadow-sm">
      <div class="flex items-center gap-3 cursor-pointer" onclick="openPublicProfile('\${q.user_id}')">
        <img src="\${q.user_avatar || 'https://via.placeholder.com/36'}" class="w-9 h-9 rounded-full object-cover">
        <div>
          <div class="flex items-center gap-1">
            <span class="font-bold text-sm">\${q.user_name || "Member"}</span>
            \${q.is_dofollow ? '<i class="fa-solid fa-circle-check text-green-500 text-xs"></i>' : ''}
          </div>
          <span class="text-xs text-slate-400">\${timeAgo(q.created_at)}</span>
        </div>
      </div>
      <h3 class="text-lg font-bold">\${q.title}</h3>
      <p class="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line">\${q.body}</p>
      \${q.image_url ? \`<img src="\${q.image_url}" class="rounded-lg w-full max-h-80 object-cover mt-2">\` : ""}
      <div>\${tagsHtml}</div>
      <div class="border-t dark:border-slate-700 pt-3 flex justify-between text-xs font-semibold text-slate-500">
        <button onclick="toggleLike('\${q.id}', this)" class="\${isLiked ? 'liked' : ''} hover:text-red-500 flex items-center gap-1">
          <i class="fa-solid fa-heart"></i> <span class="like-count">\${q.likes || 0}</span>
        </button>
        <button onclick="toggleAnswers('\${q.id}')" class="hover:text-blue-600 flex items-center gap-1">
          <i class="fa-solid fa-comment"></i> Answers
        </button>
        <button onclick="sharePost('\${q.id}')" class="hover:text-blue-600 flex items-center gap-1">
          <i class="fa-solid fa-share"></i> Share
        </button>
      </div>
      <div id="answers-box-\${q.id}" class="hidden mt-3 bg-slate-50 dark:bg-slate-900/50 p-3 rounded-lg"></div>
    </div>\`;
  }).join("");
}

window.onload = init;
</script>
</body>
</html>`;

      return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8" } });
    }

    return new Response("Not Found", { status: 404 });
  }
};
