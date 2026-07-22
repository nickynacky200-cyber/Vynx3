const Api = {
  _authReadyPromise: null,

  // Resolves once Firebase has restored (or confirmed there's no) session
  // for this browser. Every call() and requireLogin() waits on this first,
  // so pages never race Firebase's async session check.
  ready() {
    if (!this._authReadyPromise) {
      this._authReadyPromise = new Promise((resolve) => {
        const unsubscribe = auth.onAuthStateChanged((firebaseUser) => {
          unsubscribe();
          resolve(firebaseUser);
        });
      });
    }
    return this._authReadyPromise;
  },

  // Cached copy of the *local* profile (fullName, handle, bio, avatarColor —
  // the stuff Firebase doesn't know about) so pages can read it
  // synchronously without an extra round trip. Set right after login,
  // registration, or any profile edit via setProfile().
  user() {
    try { return JSON.parse(localStorage.getItem('vynx_user') || 'null'); } catch { return null; }
  },
  setProfile(user) {
    localStorage.setItem('vynx_user', JSON.stringify(user));
  },

  async signInWithGoogle() {
    const provider = new firebase.auth.GoogleAuthProvider();
    return auth.signInWithPopup(provider);
  },

  // Shown once, only for a brand-new Google sign-in that has no Vynx
  // profile yet — Firebase already gave us their name, so this only
  // asks for the one thing it can't: a handle.
  promptFinishGoogleProfile(suggestedFullName) {
    return new Promise((resolve, reject) => {
      const overlay = document.createElement('div');
      overlay.className = 'attach-preview-overlay';
      overlay.innerHTML = `
        <div class="attach-preview-header">
          <span class="name">One last step</span>
        </div>
        <div style="padding:22px;">
          <div class="field">
            <label for="gFullName">Full name</label>
            <input id="gFullName" type="text" maxlength="60">
          </div>
          <div class="field">
            <label for="gHandle">Pick a handle</label>
            <input id="gHandle" type="text" maxlength="20" placeholder="yourname" autocapitalize="off">
          </div>
          <div id="gError" class="alert alert-error hidden"></div>
          <button class="btn btn-primary btn-block" id="gSubmit">Continue</button>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.querySelector('#gFullName').value = suggestedFullName || '';

      overlay.querySelector('#gSubmit').addEventListener('click', () => {
        const fullName = overlay.querySelector('#gFullName').value.trim();
        const handle = overlay.querySelector('#gHandle').value.trim();
        const errBox = overlay.querySelector('#gError');
        if (!fullName || !handle) {
          errBox.textContent = 'Please fill in both fields.';
          errBox.classList.remove('hidden');
          return;
        }
        overlay.remove();
        resolve({ fullName, handle });
      });
    });
  },

  async logout() {
    await auth.signOut();
    localStorage.removeItem('vynx_user');
    window.location.href = 'login.html';
  },

  // Fire-and-forget guard for pages that require a session — safe to call
  // without awaiting, since it only acts (redirects) when there's no user.
  async requireLogin() {
    const firebaseUser = await this.ready();
    if (!firebaseUser) window.location.href = 'login.html';
    return firebaseUser;
  },

  async call(path, { method = 'GET', body, isForm = false } = {}) {
    await this.ready();
    const headers = {};
    if (auth.currentUser) {
      const idToken = await auth.currentUser.getIdToken();
      headers.Authorization = `Bearer ${idToken}`;
    }
    if (!isForm) headers['Content-Type'] = 'application/json';

    const res = await fetch(`api${path}`, {
      method,
      headers,
      body: isForm ? body : body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || 'Something went wrong. Please try again.');
      Object.assign(err, data); // e.g. err.needsProfile, err.suggestedFullName
      throw err;
    }
    return data;
  },
  initials(name) {
    return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');
  },
  // Renders an <img> if the person has uploaded a profile photo, otherwise
  // falls back to the initials-on-color-background avatar used everywhere.
  avatarHTML(sizePx, { fullName, avatarColor, avatarUrl } = {}) {
    const style = `width:${sizePx}px;height:${sizePx}px;font-size:${Math.round(sizePx * 0.32)}px;background:${avatarColor || '#35f0c8'};`;
    if (avatarUrl) return `<div class="avatar" style="${style}"><img src="${avatarUrl}" alt=""></div>`;
    return `<div class="avatar" style="${style}">${this.initials(fullName)}</div>`;
  },
  // Renders the *inner content* of an avatar div — either an <img> (if the
  // person uploaded a profile photo) or their initials. Caller still sets
  // the outer size/background via style="background:${color}".
  avatarInner(fullName, avatarUrl) {
    return avatarUrl ? `<img src="${avatarUrl}" alt="">` : this.initials(fullName);
  },
  timeAgo(iso) {
    const diffMs = Date.now() - new Date(iso.includes('Z') || iso.includes('+') ? iso : iso + 'Z').getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.floor(hrs / 24)}d`;
  },
};

// One shared socket connection, created lazily so pages that don't need
// chat (like the feed) don't open a connection for nothing. The `auth`
// option is a function so socket.io calls it fresh on every (re)connect —
// which matters here since Firebase ID tokens expire hourly.
let _socket = null;
function getSocket() {
  if (!_socket && window.io) {
    _socket = io({
      auth: async (cb) => {
        const idToken = auth.currentUser ? await auth.currentUser.getIdToken() : null;
        cb({ token: idToken });
      },
    });
  }
  return _socket;
}

function renderBottomNav(activePage) {
  const el = document.getElementById('bottomNav');
  if (!el) return;
  const user = Api.user();
  el.innerHTML = `
    <a href="chats.html" class="nav-item ${activePage === 'chats' ? 'active' : ''}"><span class="nav-icon">${Icon.svg('chat', 22)}</span>Chats</a>
    <a href="feed.html" class="nav-item ${activePage === 'feed' ? 'active' : ''}"><span class="nav-icon">${Icon.svg('play', 22)}</span>For You</a>
    <a href="new-post.html" class="nav-item ${activePage === 'post' ? 'active' : ''}"><span class="nav-icon">${Icon.svg('plusCircle', 22)}</span>Post</a>
    <a href="profile.html?handle=${user?.handle || ''}" class="nav-item ${activePage === 'profile' ? 'active' : ''}"><span class="nav-icon">${Icon.svg('user', 22)}</span>Profile</a>
  `;
}
