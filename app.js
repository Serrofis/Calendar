(() => {
  'use strict';

  const CFG = window.CALENDAR_CONFIG || {};
  const API = 'https://www.googleapis.com/calendar/v3';
  const SCOPES = [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ].join(' ');
  const DEMO = new URLSearchParams(location.search).has('demo');
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Each entry on a day gets its own colour, in this order.
  const PALETTE = ['#3d8bff', '#ff8a1f', '#ff4fa3', '#2fd16b', '#b57bff', '#00c8c8', '#ffd23f', '#ff5c5c'];

  const $ = (id) => document.getElementById(id);
  const el = (tag, props, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  };

  // localStorage can throw in private browsing; the app still works without it.
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
    del(key) { try { localStorage.removeItem(key); } catch {} },
  };

  // ---- Dates ----
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const firstOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
  // Weeks start on Monday.
  const gridStart = (month) => addDays(month, -((month.getDay() + 6) % 7));

  // ---- Google sign-in (OAuth implicit flow by redirect; works in iOS home-screen apps) ----
  function readRedirect() {
    if (!/access_token=|error=/.test(location.hash)) return;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    if (p.get('state') !== store.get('oauth_state')) return;
    store.del('oauth_state');
    if (p.get('access_token')) {
      store.set('token', {
        value: p.get('access_token'),
        expires: Date.now() + (Number(p.get('expires_in')) - 60) * 1000,
      });
    }
  }

  function token() {
    const t = store.get('token');
    return t && t.expires > Date.now() ? t.value : null;
  }

  function signIn() {
    const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16)).join('');
    store.set('oauth_state', oauthState);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: CFG.clientId,
      redirect_uri: location.origin + location.pathname,
      response_type: 'token',
      scope: SCOPES,
      state: oauthState,
      include_granted_scopes: 'true',
    });
    location.assign(url);
  }

  function showSignIn(message) {
    $('app').hidden = true;
    $('signin').hidden = false;
    if (!CFG.clientId) {
      $('signinMsg').textContent = 'Not set up yet: add your Google client ID to config.js.';
      $('signinBtn').disabled = true;
    } else if (message) {
      $('signinMsg').textContent = message;
    }
  }

  async function api(path, { method = 'GET', params = {}, body } = {}) {
    const t = token();
    if (!t) {
      showSignIn('Your session expired. Sign in again.');
      throw new Error('Signed out');
    }
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${t}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      store.del('token');
      showSignIn('Your session expired. Sign in again.');
      throw new Error('Signed out');
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err.error && err.error.message) || `Request failed (${res.status})`);
    }
    return res.status === 204 ? null : res.json();
  }

  // ---- Backends: the real Google Calendar API, and in-memory sample data for ?demo ----
  const eventsPath = (calId, id) => `/calendars/${encodeURIComponent(calId)}/events${id ? `/${encodeURIComponent(id)}` : ''}`;

  const google = {
    async calendars() {
      const r = await api('/users/me/calendarList', { params: { maxResults: 250 } });
      return (r.items || []).map((c) => ({
        id: c.id,
        name: c.summaryOverride || c.summary,
        color: c.backgroundColor,
        writable: c.accessRole === 'owner' || c.accessRole === 'writer',
        primary: !!c.primary,
      }));
    },
    async events(calId, from, to) {
      const items = [];
      let pageToken;
      do {
        const r = await api(eventsPath(calId), {
          params: {
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            singleEvents: 'true',
            orderBy: 'startTime',
            maxResults: 2500,
            ...(pageToken ? { pageToken } : {}),
          },
        });
        items.push(...(r.items || []));
        pageToken = r.nextPageToken;
      } while (pageToken);
      return items;
    },
    insert: (calId, body) => api(eventsPath(calId), { method: 'POST', body }),
    patch: (calId, id, body) => api(eventsPath(calId, id), { method: 'PATCH', body }),
    remove: (calId, id) => api(eventsPath(calId, id), { method: 'DELETE' }),
  };

  const demo = (() => {
    const now = new Date();
    const at = (offset, h) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, h).toISOString();
    let seq = 1;
    const timed = (cal, summary, offset, from, to) =>
      ({ id: `demo${seq++}`, cal, summary, start: { dateTime: at(offset, from) }, end: { dateTime: at(offset, to) } });
    const items = [
      timed('work', 'Morning shift', 0, 7, 15),
      timed('me', 'Dinner with friends', 0, 20, 22),
      timed('me', 'Call with Mara', 0, now.getHours() + 1, now.getHours() + 2),
      timed('work', 'Team meeting', 2, 10, 11),
      timed('me', 'Haircut', 4, 17, 18),
      timed('work', 'Morning shift', 1, 7, 15),
      timed('me', 'Gym', 3, 18, 19),
      { id: `demo${seq++}`, cal: 'me', summary: 'Weekend trip', start: { date: ymd(addDays(now, 5)) }, end: { date: ymd(addDays(now, 7)) } },
    ];
    // PATCH bodies use null to clear a field, as the real API does.
    const clean = (body) => JSON.parse(JSON.stringify(body, (k, v) => (v === null ? undefined : v)));
    return {
      async calendars() {
        return [
          { id: 'me', name: 'Personal', color: '#3f6fd9', writable: true, primary: true },
          { id: 'work', name: 'Work', color: '#d9783f', writable: true, primary: false },
        ];
      },
      async events(calId) { return items.filter((e) => e.cal === calId); },
      async insert(calId, body) { items.push({ ...clean(body), id: `demo${seq++}`, cal: calId }); },
      async patch(calId, id, body) { Object.assign(items.find((e) => e.id === id), clean(body)); },
      async remove(calId, id) { items.splice(items.findIndex((e) => e.id === id), 1); },
    };
  })();

  const backend = DEMO ? demo : google;

  // ---- State ----
  const state = {
    month: firstOfMonth(new Date()),
    selected: startOfDay(new Date()),
    calendars: [],
    hidden: new Set(store.get('hidden_calendars') || []),
    cache: new Map(), // month key -> events
    editing: null,
    view: store.get('view') === 'week' ? 'week' : 'day',
  };

  function normalize(e, cal) {
    const allDay = !!e.start.date;
    return {
      id: e.id,
      calId: cal.id,
      color: cal.color,
      writable: cal.writable,
      title: e.summary || '(No title)',
      allDay,
      start: allDay ? parseYmd(e.start.date) : new Date(e.start.dateTime),
      end: allDay ? parseYmd(e.end.date) : new Date(e.end.dateTime), // exclusive
      location: e.location || '',
      description: e.description || '',
    };
  }

  async function loadMonth() {
    render();
    const key = ymd(state.month);
    if (state.cache.has(key)) return;
    const from = gridStart(state.month);
    const to = addDays(from, 42);
    const visible = state.calendars.filter((c) => !state.hidden.has(c.id));
    const failed = [];
    const lists = await Promise.all(visible.map((cal) =>
      backend.events(cal.id, from, to)
        .then((items) => items.filter((e) => e.status !== 'cancelled' && e.start).map((e) => normalize(e, cal)))
        .catch(() => { failed.push(cal.name); return []; })));
    if (!token() && !DEMO) return;
    state.cache.set(key, lists.flat());
    if (failed.length) toast(`Could not load: ${failed.join(', ')}`);
    render();
  }

  function reload() {
    state.cache.clear();
    return loadMonth();
  }

  // ---- Rendering ----
  function eventsByDay() {
    const byDay = new Map();
    for (const ev of state.cache.get(ymd(state.month)) || []) {
      const last = startOfDay(new Date(Math.max(ev.start, ev.end - 1)));
      for (let d = startOfDay(ev.start); d <= last; d = addDays(d, 1)) {
        const key = ymd(d);
        if (!byDay.has(key)) byDay.set(key, []);
        byDay.get(key).push(ev);
      }
    }
    return byDay;
  }

  function render() {
    $('title').textContent = state.month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    const byDay = eventsByDay();
    const todayKey = ymd(new Date());
    const selectedKey = ymd(state.selected);
    const first = gridStart(state.month);

    const cells = [];
    for (let i = 0; i < 42; i++) {
      const date = addDays(first, i);
      const key = ymd(date);
      const colors = [...new Set((byDay.get(key) || []).map((e) => e.color))].slice(0, 3);
      const dots = el('span', { className: 'dots' }, ...colors.map((c) => {
        const dot = el('i');
        dot.style.background = c;
        return dot;
      }));
      const cell = el('button', { className: 'day', type: 'button' }, el('span', { className: 'num', textContent: date.getDate() }), dots);
      cell.classList.toggle('other', date.getMonth() !== state.month.getMonth());
      cell.classList.toggle('today', key === todayKey);
      cell.classList.toggle('selected', key === selectedKey);
      cell.setAttribute('aria-label', date.toLocaleDateString(undefined, { dateStyle: 'full' }));
      cell.addEventListener('click', () => {
        state.selected = date;
        toggleMonth(false);
        if (date.getMonth() !== state.month.getMonth()) {
          state.month = firstOfMonth(date);
          loadMonth();
        } else {
          render();
        }
      });
      cells.push(cell);
    }
    $('grid').replaceChildren(...cells);

    const now = new Date();
    const weekView = state.view === 'week';
    $('viewDay').setAttribute('aria-pressed', !weekView);
    $('viewWeek').setAttribute('aria-pressed', weekView);
    $('agenda').hidden = weekView;
    $('week').hidden = !weekView;
    if (weekView) {
      const monday = addDays(state.selected, -((state.selected.getDay() + 6) % 7));
      const sunday = addDays(monday, 6);
      const short = (d) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      $('dayTitle').textContent = `${short(monday)} – ${short(sunday)}`;
      renderWeek(monday, byDay, todayKey, now);
      return;
    }

    // The board for the selected day.
    $('dayTitle').textContent = state.selected.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    const rows = sortedEvents(byDay, selectedKey).map((ev, i) => {
      const color = PALETTE[i % PALETTE.length];
      const line = el('span', { className: 'line', textContent: ev.title.trim().charAt(0) });
      line.style.background = color;
      line.style.color = textOn(color);
      const st = boardStatus(ev, selectedKey === todayKey, now);
      const button = el('button', { className: 'row', type: 'button' }, line,
        el('span', { className: 'time' }, ...dotText(ev.allDay ? '--:--' : hm(ev.start))),
        el('span', { className: 'name', textContent: ev.title }),
        el('span', { className: 'status' }, ...(st.value ? [el('b', {}, ...dotText(st.value))] : []), el('small', { textContent: st.label })));
      button.classList.toggle('live', !!st.live);
      button.classList.toggle('past', !!st.past);
      button.classList.toggle('soon', !!st.soon);
      button.addEventListener('click', () => openEditor(ev));
      return el('li', {}, button);
    });
    $('dayList').replaceChildren(...(rows.length ? rows : [el('li', { className: 'empty', textContent: 'Nothing scheduled' })]));
  }

  // Seven day columns side by side, scrolled sideways.
  function renderWeek(monday, byDay, todayKey, now) {
    const columns = Array.from({ length: 7 }, (_, d) => {
      const date = addDays(monday, d);
      const key = ymd(date);
      const head = el('button', { className: 'week-head', type: 'button' },
        el('span', { textContent: date.toLocaleDateString(undefined, { weekday: 'short' }) }),
        el('b', { textContent: date.getDate() }));
      head.addEventListener('click', () => { state.selected = date; setView('day'); });
      const chips = sortedEvents(byDay, key).map((ev, i) => {
        const chip = el('button', { className: 'chip', type: 'button' },
          el('span', { className: 'chip-time' }, ...dotText(ev.allDay ? 'All day' : hm(ev.start))),
          el('span', { className: 'chip-name', textContent: ev.title }));
        chip.style.setProperty('--c', PALETTE[i % PALETTE.length]);
        chip.classList.toggle('past', key === todayKey && !ev.allDay && ev.end <= now);
        chip.addEventListener('click', () => openEditor(ev));
        return chip;
      });
      const column = el('div', { className: 'week-day' }, head, ...(chips.length ? chips : [el('span', { className: 'week-empty', textContent: '—' })]));
      column.classList.toggle('today', key === todayKey);
      column.classList.toggle('selected', key === ymd(state.selected));
      return column;
    });
    $('week').replaceChildren(...columns);
    const current = $('week').querySelector('.selected');
    if (current) $('week').scrollLeft += current.getBoundingClientRect().left - $('week').getBoundingClientRect().left - 8;
  }

  function sortedEvents(byDay, key) {
    return (byDay.get(key) || []).slice().sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
  }

  function setView(view) {
    state.view = view;
    store.set('view', view);
    toggleMonth(false);
    if (state.selected.getMonth() === state.month.getMonth() && state.selected.getFullYear() === state.month.getFullYear()) render();
    else { state.month = firstOfMonth(state.selected); loadMonth(); }
  }

  // Right-hand column of a board row: a big value over a small label.
  // Today counts down to each event; other days show when it ends.
  function boardStatus(ev, isToday, now) {
    if (ev.allDay) return { value: 'All', label: 'day' };
    if (!isToday) return { value: hm(ev.end), label: 'ends' };
    if (ev.end <= now) return { value: '', label: 'ended', past: true };
    const live = ev.start <= now;
    const mins = Math.max(1, Math.round(((live ? ev.end : ev.start) - now) / 60000));
    const value = mins < 60 ? String(mins) : `${Math.floor(mins / 60)}:${pad(mins % 60)}`;
    return { value, label: (mins < 60 ? 'min' : 'hr') + (live ? ' left' : ''), live, soon: !live && mins < 120 };
  }

  // Text for the dot-matrix font, with each colon wrapped so CSS can set it in the plain font.
  function dotText(text) {
    return text.split(':').flatMap((part, i) => (i ? [el('i', { className: 'sep', textContent: ':' }), part] : [part]));
  }

  // Black or white, whichever reads better on a calendar's colour.
  function textOn(hex) {
    if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return '#000';
    const n = parseInt(hex.slice(1), 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 150 ? '#000' : '#fff';
  }

  function toggleMonth(open) {
    $('monthPanel').hidden = !open;
    $('dayBtn').setAttribute('aria-expanded', open);
  }

  function shiftDay(delta) {
    state.selected = addDays(state.selected, state.view === 'week' ? delta * 7 : delta);
    if (state.selected.getMonth() === state.month.getMonth() && state.selected.getFullYear() === state.month.getFullYear()) {
      render();
    } else {
      state.month = firstOfMonth(state.selected);
      loadMonth();
    }
  }

  function tick() {
    const now = new Date();
    $('clock').replaceChildren(...dotText(`${hm(now)}:${pad(now.getSeconds())}`));
    if (now.getSeconds() === 0 && !$('app').hidden) render();   // keeps the countdowns current
  }

  function renderWeekdays() {
    const monday = gridStart(new Date());
    $('weekdays').replaceChildren(...Array.from({ length: 7 }, (_, i) =>
      el('span', { textContent: addDays(monday, i).toLocaleDateString(undefined, { weekday: 'short' }) })));
  }

  function shiftMonth(delta) {
    state.month = new Date(state.month.getFullYear(), state.month.getMonth() + delta, 1);
    const now = new Date();
    const isThisMonth = state.month.getFullYear() === now.getFullYear() && state.month.getMonth() === now.getMonth();
    state.selected = isThisMonth ? startOfDay(now) : state.month;
    loadMonth();
  }

  let toastTimer;
  function toast(message) {
    $('toast').textContent = message;
    $('toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3500);
  }

  // ---- Event editor ----
  function syncAllDay() {
    const allDay = $('f-allday').checked;
    $('f-stime').hidden = allDay;
    $('f-etime').hidden = allDay;
  }

  function openEditor(ev) {
    state.editing = ev;
    const writable = state.calendars.filter((c) => c.writable);
    const shown = ev ? state.calendars.filter((c) => c.id === ev.calId) : writable;
    $('f-cal').replaceChildren(...shown.map((c) => el('option', { value: c.id, textContent: c.name })));

    if (ev) {
      const lastDay = ev.allDay ? addDays(ev.end, -1) : ev.end;
      $('f-title').value = ev.title === '(No title)' ? '' : ev.title;
      $('f-allday').checked = ev.allDay;
      $('f-sdate').value = ymd(ev.start);
      $('f-edate').value = ymd(lastDay);
      $('f-stime').value = ev.allDay ? '09:00' : hm(ev.start);
      $('f-etime').value = ev.allDay ? '10:00' : hm(ev.end);
      $('f-loc').value = ev.location;
      $('f-desc').value = ev.description;
    } else {
      const hour = Math.min(new Date().getHours() + 1, 22);
      const primary = writable.find((c) => c.primary) || writable[0];
      $('editorForm').reset();
      $('f-sdate').value = $('f-edate').value = ymd(state.selected);
      $('f-stime').value = `${pad(hour)}:00`;
      $('f-etime').value = `${pad(hour + 1)}:00`;
      if (primary) $('f-cal').value = primary.id;
    }

    const canEdit = ev ? ev.writable : writable.length > 0;
    $('editorTitle').textContent = !ev ? 'New event' : canEdit ? 'Edit event' : 'Event';
    $('editorFields').disabled = !canEdit;
    $('f-cal').disabled = !!ev; // moving an event between calendars is not supported
    $('f-save').hidden = !canEdit;
    $('f-delete').hidden = !ev || !canEdit;
    syncAllDay();
    $('editor').showModal();
  }

  function editorBody() {
    const startDate = $('f-sdate').value;
    const endDate = $('f-edate').value || startDate;
    const body = {
      summary: $('f-title').value.trim(),
      location: $('f-loc').value.trim(),
      description: $('f-desc').value.trim(),
    };
    if ($('f-allday').checked) {
      if (endDate < startDate) throw new Error('The end date is before the start date.');
      // null clears the timed fields when an existing event becomes all-day
      body.start = { date: startDate, dateTime: null, timeZone: null };
      body.end = { date: ymd(addDays(parseYmd(endDate), 1)), dateTime: null, timeZone: null };
    } else {
      const start = new Date(`${startDate}T${$('f-stime').value || '00:00'}`);
      const end = new Date(`${endDate}T${$('f-etime').value || '00:00'}`);
      if (end <= start) throw new Error('The event must end after it starts.');
      body.start = { dateTime: start.toISOString(), timeZone: TZ, date: null };
      body.end = { dateTime: end.toISOString(), timeZone: TZ, date: null };
    }
    return body;
  }

  async function saveEvent(submitEvent) {
    submitEvent.preventDefault();
    const ev = state.editing;
    try {
      const body = editorBody();
      $('f-save').disabled = true;
      if (ev) await backend.patch(ev.calId, ev.id, body);
      else await backend.insert($('f-cal').value, body);
      $('editor').close();
      state.selected = parseYmd($('f-sdate').value);
      state.month = firstOfMonth(state.selected);
      await reload();
    } catch (err) {
      toast(err.message);
    } finally {
      $('f-save').disabled = false;
    }
  }

  async function deleteEvent() {
    const ev = state.editing;
    try {
      await backend.remove(ev.calId, ev.id);
      $('editor').close();
      await reload();
    } catch (err) {
      toast(err.message);
    }
  }

  // ---- Calendars menu ----
  function openMenu() {
    $('calList').replaceChildren(...state.calendars.map((cal) => {
      const box = el('input', { type: 'checkbox', checked: !state.hidden.has(cal.id) });
      box.addEventListener('change', () => {
        if (box.checked) state.hidden.delete(cal.id);
        else state.hidden.add(cal.id);
        store.set('hidden_calendars', [...state.hidden]);
        reload();
      });
      const swatch = el('i');
      swatch.style.background = cal.color;
      return el('li', {}, el('label', {}, box, swatch, el('span', { textContent: cal.name })));
    }));
    $('menu').showModal();
  }

  function signOut() {
    $('menu').close();
    if (DEMO) {
      location.assign(location.pathname);
      return;
    }
    store.del('token');
    state.cache.clear();
    showSignIn('You are signed out.');
  }

  // ---- Start ----
  async function start() {
    $('signin').hidden = true;
    $('app').hidden = false;
    renderWeekdays();
    render();
    tick();
    try {
      state.calendars = await backend.calendars();
      await loadMonth();
    } catch (err) {
      if (err.message !== 'Signed out') toast(err.message);
    }
  }

  $('signinBtn').addEventListener('click', signIn);
  $('prev').addEventListener('click', () => shiftMonth(-1));
  $('next').addEventListener('click', () => shiftMonth(1));
  $('viewDay').addEventListener('click', () => setView('day'));
  $('viewWeek').addEventListener('click', () => setView('week'));
  $('prevDay').addEventListener('click', () => shiftDay(-1));
  $('nextDay').addEventListener('click', () => shiftDay(1));
  $('dayBtn').addEventListener('click', () => toggleMonth($('monthPanel').hidden));
  $('today').addEventListener('click', () => {
    toggleMonth(false);
    state.selected = startOfDay(new Date());
    state.month = firstOfMonth(state.selected);
    loadMonth();
  });
  $('add').addEventListener('click', () => openEditor(null));
  $('menuBtn').addEventListener('click', openMenu);
  $('menuClose').addEventListener('click', () => $('menu').close());
  $('signout').addEventListener('click', signOut);
  $('f-allday').addEventListener('change', syncAllDay);
  $('f-cancel').addEventListener('click', () => $('editor').close());
  $('f-delete').addEventListener('click', deleteEvent);
  $('editorForm').addEventListener('submit', saveEvent);

  // Swipe sideways: the board changes day, the month picker changes month.
  function onSwipe(node, handler) {
    let touchX = 0;
    let touchY = 0;
    node.addEventListener('touchstart', (e) => {
      touchX = e.touches[0].clientX;
      touchY = e.touches[0].clientY;
    }, { passive: true });
    node.addEventListener('touchend', (e) => {
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) handler(dx < 0 ? 1 : -1);
    }, { passive: true });
  }
  onSwipe($('grid'), shiftMonth);
  onSwipe($('agenda'), shiftDay);
  setInterval(tick, 1000);

  // Pick up changes made elsewhere when the app comes back to the foreground.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || $('app').hidden) return;
    if (!DEMO && !token()) showSignIn('Your session expired. Sign in again.');
    else if (!$('editor').open) reload();
  });

  readRedirect();
  if (DEMO || token()) start();
  else showSignIn();
})();
